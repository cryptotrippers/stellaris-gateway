/**
 * Operator script: Tessera Reserve genesis on Preprod (Phase 4, step 1).
 *
 *   npx tsx scripts/tessera/bootstrap-reserve.ts --committee deployments/committee.preprod.json
 *       dry run (default): builds the genesis tx, evaluates the reserve policy
 *       against it, prints the TSRA policy ID / addresses / plan. Nothing signed.
 *
 *   ... --submit --accept-provisional
 *       signs with the operator key, submits, waits for confirmation, reads the
 *       two genesis UTxOs back and records everything in deployments/<label>.json.
 *
 * Options
 *   --committee <file>    JSON: { "operators": [addr_test1… | 56-hex key hash, …],
 *                         "threshold": 3 }  (required)
 *   --mint-cap <TSRA>     working mint ceiling, whole TSRA (default 5000000)
 *   --seed <txhash#ix>    the wallet UTxO to consume (default: largest pure-ADA UTxO)
 *   --label <name>        deployment label / file name (default preprod-v1)
 *   --submit              sign and submit
 *   --accept-provisional  required with --submit: SPEC.md §1 datums are provisional
 *                         until counsel answers, so this deployment is throwaway
 *
 * Environment (never logged, never written)
 *   BLOCKFROST_PREPROD_PROJECT_ID   a preprod… key (required)
 *   STELLARIS_OPERATOR_SKEY_FILE    cardano-cli payment .skey, or
 *   STELLARIS_OPERATOR_SKEY         bech32 ed25519_sk…, or
 *   STELLARIS_OPERATOR_MNEMONIC     seed phrase (account 0)
 *   STELLARIS_OPERATOR_ADDRESS      dry run only: an address to plan from without a key
 *
 * Refuses if: not Preprod; the blueprint is not the pinned one; contracts/tessera
 * has uncommitted changes (on --submit); the label already has a reserve genesis;
 * the seed is not a plain wallet UTxO; any genesis rule would fail.
 *
 * Genesis needs no committee signature. Every later committee action does.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  Blockfrost,
  CML,
  Lucid,
  getAddressDetails,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { buildGenesis, seedProblems, type GenesisInput } from "./lib/build-genesis";
import { decodeReserveDatum, tsraToUnits } from "./lib/genesis";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const TAG = "[tessera-bootstrap]";

function die(msg: string): never {
  console.error(`${TAG} ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
function opt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) die(`${name} needs a value`);
  return v;
}

const SUBMIT = flag("--submit");
const ACCEPT_PROVISIONAL = flag("--accept-provisional");
const LABEL = opt("--label") ?? "preprod-v1";
const COMMITTEE_FILE = opt("--committee");
const MINT_CAP = opt("--mint-cap") ?? "5000000";
const SEED_ARG = opt("--seed");
const DEPLOY_FILE = `deployments/${LABEL}.json`;

if (!/^[a-z0-9-]+$/.test(LABEL)) die("--label may only contain a-z, 0-9 and '-'");
if (SUBMIT && !ACCEPT_PROVISIONAL) {
  die(
    "--submit needs --accept-provisional: the Config/Supply datums are provisional until counsel " +
      "answers (SPEC.md §1), so this policy ID will change on the next reserve redeploy.",
  );
}
if (!COMMITTEE_FILE) die("--committee <file> is required (see the header of this script).");
if (!existsSync("contracts/tessera/plutus.json")) die("Run this from the repo root.");

const KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID ?? "";
if (!KEY) die("BLOCKFROST_PREPROD_PROJECT_ID is not set in this shell.");
if (!KEY.startsWith("preprod"))
  die("BLOCKFROST_PREPROD_PROJECT_ID is not a Preprod key — refusing.");

// ---------------------------------------------------------------------------
// Committee
// ---------------------------------------------------------------------------

function toKeyHash(entry: string): string {
  const e = entry.trim().toLowerCase();
  if (/^[0-9a-f]{56}$/.test(e)) return e;
  if (e.startsWith("addr1")) die(`Committee entry ${entry} is a MAINNET address — refusing.`);
  if (!e.startsWith("addr_test1"))
    die(`Committee entry ${entry} is neither a key hash nor addr_test1…`);
  let cred: ReturnType<typeof getAddressDetails>["paymentCredential"];
  try {
    cred = getAddressDetails(e).paymentCredential;
  } catch {
    die(`Committee entry ${entry} is not a valid address (did you replace the example values?).`);
  }
  if (cred?.type !== "Key") die(`Committee address ${entry} is not a key (payment) address.`);
  return cred.hash;
}

const committeeJson = JSON.parse(readFileSync(COMMITTEE_FILE, "utf8")) as {
  operators?: string[];
  threshold?: number;
};
if (!Array.isArray(committeeJson.operators)) die(`${COMMITTEE_FILE}: "operators" must be a list`);
if (typeof committeeJson.threshold !== "number")
  die(`${COMMITTEE_FILE}: "threshold" must be a number`);

const input: GenesisInput = {
  operators: committeeJson.operators.map(toKeyHash),
  threshold: committeeJson.threshold,
  mintCap: tsraToUnits(MINT_CAP),
  attestedReserve: 0n,
  paused: false,
  // SPEC.md §1a: all KYC switches off on Preprod.
  kycMint: false,
  kycRedeem: false,
  kycStake: false,
};

// ---------------------------------------------------------------------------
// Guards on repo state and prior deployments
// ---------------------------------------------------------------------------

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const commit = git("rev-parse HEAD");
const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty) {
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}\nCommit first.`);
}

interface Deployment {
  label: string;
  network: "Preprod";
  provisional: boolean;
  reserve?: Record<string, unknown>;
  eligibility?: Record<string, unknown>;
  [k: string]: unknown;
}
const existing: Deployment | null = existsSync(DEPLOY_FILE)
  ? (JSON.parse(readFileSync(DEPLOY_FILE, "utf8")) as Deployment)
  : null;
if (existing?.reserve) {
  die(
    `${DEPLOY_FILE} already records a reserve genesis (${String(existing.reserve.genesisTx)}). ` +
      "Genesis is one-shot; use a new --label for a fresh deployment.",
  );
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function selectWallet(lucid: LucidEvolution): void {
  const skeyFile = process.env.STELLARIS_OPERATOR_SKEY_FILE;
  const skey = process.env.STELLARIS_OPERATOR_SKEY;
  const mnemonic = process.env.STELLARIS_OPERATOR_MNEMONIC;
  if (skeyFile) {
    const j = JSON.parse(readFileSync(skeyFile, "utf8")) as { cborHex?: string };
    if (!j.cborHex?.startsWith("5820"))
      die("STELLARIS_OPERATOR_SKEY_FILE is not a cardano-cli payment .skey.");
    const key = CML.PrivateKey.from_normal_bytes(Buffer.from(j.cborHex.slice(4), "hex"));
    lucid.selectWallet.fromPrivateKey(key.to_bech32());
  } else if (skey) {
    lucid.selectWallet.fromPrivateKey(skey.trim());
  } else if (mnemonic) {
    lucid.selectWallet.fromSeed(mnemonic.trim());
  } else {
    die(
      "No operator key. Set STELLARIS_OPERATOR_SKEY_FILE, STELLARIS_OPERATOR_SKEY or " +
        "STELLARIS_OPERATOR_MNEMONIC (or STELLARIS_OPERATOR_ADDRESS for a dry run).",
    );
  }
}

async function chooseSeed(utxos: UTxO[]): Promise<UTxO> {
  if (SEED_ARG) {
    const m = /^([0-9a-f]{64})#(\d+)$/.exec(SEED_ARG);
    if (!m) die("--seed must be <64-hex txhash>#<index>");
    const u = utxos.find((x) => x.txHash === m[1] && x.outputIndex === Number(m[2]));
    if (!u) die(`Seed ${SEED_ARG} is not an unspent UTxO of the operator wallet.`);
    return u;
  }
  const plain = utxos
    .filter((u) => seedProblems(u).length === 0 && Object.keys(u.assets).length === 1)
    .sort((a, b) => ((b.assets.lovelace ?? 0n) > (a.assets.lovelace ?? 0n) ? 1 : -1));
  if (!plain.length) die("The operator wallet has no plain ADA UTxO to use as the seed.");
  return plain[0]!;
}

const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} tADA`;
const tsra = (u: bigint) => `${(u / 1_000_000n).toLocaleString("en-AU")} TSRA`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  const dryAddress = process.env.STELLARIS_OPERATOR_ADDRESS?.trim();
  if (!SUBMIT && dryAddress) {
    if (!dryAddress.startsWith("addr_test1")) die("STELLARIS_OPERATOR_ADDRESS must be addr_test1…");
    lucid.selectWallet.fromAddress(dryAddress, await lucid.utxosAt(dryAddress));
  } else {
    selectWallet(lucid);
  }
  const walletAddress = await lucid.wallet().address();
  if (!walletAddress.startsWith("addr_test1"))
    die("Operator wallet is not a testnet address — refusing.");

  const utxos = await lucid.wallet().getUtxos();
  const seed = await chooseSeed(utxos);
  const sp = seedProblems(seed);
  if (sp.length) die(`Seed refused: ${sp.join("; ")}`);
  const balance = utxos.reduce((a, u) => a + (u.assets.lovelace ?? 0n), 0n);
  if (balance < 15_000_000n)
    die(`Operator wallet holds ${ada(balance)}; genesis needs about 15 tADA.`);

  const plan = await buildGenesis(lucid, seed, input, Date.now());
  const fee = CML.Transaction.from_cbor_hex(plan.tx.toCBOR()).body().fee();

  console.log(`== Tessera Reserve genesis — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(
    `commit            ${commit || "(unknown)"}${dirty ? "  [uncommitted changes]" : ""}`,
  );
  console.log(`operator wallet   ${walletAddress}`);
  console.log(
    `seed              ${seed.txHash}#${String(seed.outputIndex)} (${ada(seed.assets.lovelace ?? 0n)})`,
  );
  console.log("");
  console.log(`TSRA policy ID    ${plan.reserve.hash}`);
  console.log(`TSRA unit         ${plan.units.tsra}   <- token-registry subject`);
  console.log(`reserve address   ${plan.reserveAddress}`);
  console.log(`eligibility hash  ${plan.eligibility.hash}   (recorded in Config; deployed later)`);
  console.log("");
  console.log(`committee         ${String(input.threshold)}-of-${String(input.operators.length)}`);
  for (const op of input.operators) console.log(`                  ${op}`);
  console.log(`mint_cap          ${tsra(input.mintCap)}`);
  console.log(`attested_reserve  0 · KYC switches off · not paused`);
  console.log(
    `validity          ${new Date(plan.lo).toISOString()} → ${new Date(plan.hi).toISOString()}`,
  );
  console.log(`attested_at       ${String(plan.attestedAt)} (== lower bound)`);
  console.log(`tx                ${String(plan.tx.toCBOR().length / 2)} bytes, fee ${ada(fee)}`);
  console.log(`tx hash           ${plan.tx.toHash()}`);
  console.log(
    "\nValidated: the reserve policy accepted this exact transaction in local evaluation.",
  );

  if (!SUBMIT) {
    console.log(
      "\nDRY RUN — nothing signed or submitted. The seed above is NOT consumed; a different seed " +
        "gives a different policy ID, so re-check these values on the --submit run.",
    );
    return;
  }

  const record: Deployment = {
    ...(existing ?? {}),
    label: LABEL,
    network: "Preprod",
    provisional: true,
    commit,
    reserve: {
      status: "submitted",
      seed: { txHash: seed.txHash, outputIndex: seed.outputIndex },
      scriptHash: plan.reserve.hash,
      tsraPolicyId: plan.reserve.hash,
      tsraUnit: plan.units.tsra,
      configUnit: plan.units.config,
      supplyUnit: plan.units.supply,
      address: plan.reserveAddress,
      genesisTx: plan.tx.toHash(),
      attestedAt: plan.attestedAt,
      committee: { operators: input.operators, threshold: input.threshold },
      mintCap: input.mintCap.toString(),
      submittedAt: new Date().toISOString(),
    },
    eligibility: { scriptHash: plan.eligibility.hash, status: "derived-not-deployed" },
  };

  const signed = await plan.tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  // Written immediately: the seed is now spent, so this policy ID must never be lost.
  mkdirSync("deployments", { recursive: true });
  writeFileSync(DEPLOY_FILE, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nSubmitted ${txHash}\nhttps://preprod.cardanoscan.io/transaction/${txHash}`);
  console.log(`Recorded in ${DEPLOY_FILE}. Waiting for confirmation…`);

  if (!(await lucid.awaitTx(txHash, 5_000)))
    die("Not confirmed yet. Re-check on Cardanoscan; the record is saved.");

  const at = await lucid.utxosAt(plan.reserveAddress);
  const cfg = at.filter((u) => (u.assets[plan.units.config] ?? 0n) === 1n);
  const sup = at.filter((u) => (u.assets[plan.units.supply] ?? 0n) === 1n);
  const cfgD = cfg[0]?.datum ? decodeReserveDatum(cfg[0].datum) : null;
  const supD = sup[0]?.datum ? decodeReserveDatum(sup[0].datum) : null;
  const ok =
    at.length === 2 &&
    cfg.length === 1 &&
    sup.length === 1 &&
    cfgD?.kind === "config" &&
    supD?.kind === "supply" &&
    supD.fields[4] === BigInt(plan.attestedAt);
  record.reserve = {
    ...record.reserve,
    status: ok ? "confirmed" : "confirmed-UNEXPECTED-STATE",
    configUtxo: cfg[0] ? `${cfg[0].txHash}#${String(cfg[0].outputIndex)}` : null,
    supplyUtxo: sup[0] ? `${sup[0].txHash}#${String(sup[0].outputIndex)}` : null,
    confirmedAt: new Date().toISOString(),
  };
  writeFileSync(DEPLOY_FILE, JSON.stringify(record, null, 2) + "\n");
  if (!ok)
    die(
      `Confirmed, but the reserve address does not hold exactly the genesis Config + Supply. See ${DEPLOY_FILE}.`,
    );

  console.log("\nConfirmed. Config and Supply read back from chain and match the plan.");
  console.log(`Commit ${DEPLOY_FILE} (it contains no keys).`);
}

main().catch((e: unknown) => {
  console.error(`${TAG} ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
