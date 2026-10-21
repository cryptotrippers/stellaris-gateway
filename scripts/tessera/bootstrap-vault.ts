/**
 * Operator script: stand up the sTSRA vault on Preprod (Phase 4, step 2).
 * Needs a confirmed Reserve genesis in deployments/<label>.json (step 1).
 *
 *   npx tsx scripts/tessera/bootstrap-vault.ts --keys-dir <dir> --signers c1,c2,c3
 *       dry run (default): builds the remaining stages as a chain, evaluates every
 *       script against those exact transactions, prints the plan. Nothing signed.
 *
 *   ... --submit --accept-provisional
 *       submits the stages in order, waiting for each to confirm and recording it
 *       in deployments/<label>.json before the next. Re-running resumes after the
 *       last recorded stage.
 *
 * Stages: firstLoss → opsStake → vault → setVault (see lib/build-vault.ts).
 *
 * Options
 *   --keys-dir <dir>      folder with the committee .skey files (from new-preprod-keys)
 *   --signers c1,c2,c3    committee key names in --keys-dir that sign SetVault
 *                         (at least the Config threshold; their hashes must be in it)
 *   --treasury <addr>     treasury address for the protocol cut (default: operator)
 *   --label <name>        deployment label (default preprod-v1)
 *   --submit --accept-provisional
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 * Bounds: SPEC.md §3 proposed values (12,500 bps long weight, 7-day cooldown,
 * 30-day lock, 12.5% protocol cut).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { applyReserve } from "./lib/blueprint";
import { BUILDERS, STAGES, type Built, type StageName, type VaultContext } from "./lib/build-vault";
import {
  ada,
  args,
  git,
  keyHashOf,
  makeDie,
  preprodKey,
  selectOperator,
  skeyFileToBech32,
} from "./lib/cli";
import { decodeReserveDatum } from "./lib/genesis";
import { PROPOSED_BOUNDS, committeeOf } from "./lib/vault-genesis";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[tessera-vault]");

const a = args();
try {
  for (const o of ["--label", "--keys-dir", "--signers", "--treasury"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const LABEL = a.opt("--label") ?? "preprod-v1";
const KEYS_DIR = a.opt("--keys-dir");
const SIGNERS = (a.opt("--signers") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TREASURY = a.opt("--treasury");
const FILE = `deployments/${LABEL}.json`;

if (SUBMIT && !a.flag("--accept-provisional"))
  die(
    "--submit needs --accept-provisional (vault and reserve datums are provisional, SPEC.md §1).",
  );
if (!existsSync(FILE)) die(`${FILE} not found — run bootstrap-reserve first, from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, unknown> & { status?: string };
const deployment = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown> & {
  reserve?: Rec;
  firstLoss?: Rec;
  opsStake?: Rec;
  vault?: Rec;
  setVault?: Rec;
};
const reserveRec = deployment.reserve;
if (reserveRec?.status !== "confirmed") die(`${FILE}: the reserve genesis is not confirmed.`);
const done = (s: StageName) => (deployment[s] as Rec | undefined)?.status === "confirmed";
const pending = STAGES.filter((s) => !done(s));
for (const s of STAGES) {
  const st = (deployment[s] as Rec | undefined)?.status;
  if (st && st !== "confirmed")
    die(
      `${FILE}: stage ${s} is "${st}". Check its tx on Cardanoscan; mark it confirmed or remove it, then re-run.`,
    );
}
if (!pending.length) {
  console.log(`All vault stages are already confirmed in ${FILE}. Nothing to do.`);
  process.exit(0);
}

const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty)
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);

function save() {
  writeFileSync(FILE, JSON.stringify(deployment, null, 2) + "\n");
}

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operatorAddress = await lucid.wallet().address();
  if (!operatorAddress.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");

  // The reserve script, re-derived from the recorded seed and checked.
  const reserve = applyReserve(reserveRec!.seed as { txHash: string; outputIndex: number });
  if (reserve.hash !== reserveRec!.scriptHash)
    die(`Re-derived reserve hash ${reserve.hash} ≠ recorded ${String(reserveRec!.scriptHash)}.`);
  const reserveAddress = reserveRec!.address as string;
  const configUnit = reserveRec!.configUnit as string;

  const configs = (await lucid.utxosAt(reserveAddress)).filter(
    (u) => (u.assets[configUnit] ?? 0n) === 1n,
  );
  if (configs.length !== 1)
    die(`Expected one genuine Config at ${reserveAddress}, found ${String(configs.length)}.`);
  const configUtxo: UTxO = configs[0]!;
  const committee = committeeOf(configUtxo.datum!);

  // Committee signers for SetVault.
  let signerKeys: string[] = [];
  let signerHashes: string[] = [];
  if (pending.includes("setVault")) {
    const keysDir = KEYS_DIR;
    if (!keysDir || SIGNERS.length === 0)
      die("SetVault needs --keys-dir <dir> and --signers c1,c2,c3.");
    signerKeys = SIGNERS.map((n) => {
      const f = join(keysDir, `${n}.skey`);
      if (!existsSync(f)) die(`${f} not found.`);
      return skeyFileToBech32(f);
    });
    signerHashes = signerKeys.map(keyHashOf);
    for (const [i, h] of signerHashes.entries())
      if (!committee.operators.includes(h))
        die(`${SIGNERS[i]!} (${h}) is not on the Config committee.`);
    if (new Set(signerHashes).size < committee.threshold)
      die(
        `SetVault needs ${String(committee.threshold)} distinct committee signers; got ${String(new Set(signerHashes).size)}.`,
      );
  }

  const treasury =
    TREASURY ??
    ((deployment.vault as Rec | undefined)?.treasuryAddress as string) ??
    operatorAddress;
  if (!treasury.startsWith("addr_test1")) die("--treasury must be an addr_test1… address.");
  if (getAddressDetails(treasury).paymentCredential === undefined)
    die("--treasury has no payment credential.");

  const ctx: VaultContext = {
    reserve,
    reserveAddress,
    firstLossHash: (deployment.firstLoss as Rec | undefined)?.scriptHash as string | undefined,
    vaultHash: (deployment.vault as Rec | undefined)?.scriptHash as string | undefined,
    treasuryAddress: treasury,
    bounds: PROPOSED_BOUNDS,
    configUtxo,
    signers: signerHashes,
  };

  // Build every remaining stage as one chain; each build evaluates its scripts.
  const built: Built[] = [];
  for (const s of pending) built.push(await BUILDERS[s](lucid, ctx));

  console.log(`== Tessera vault bootstrap — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator       ${operatorAddress}`);
  console.log(
    `reserve        ${reserve.hash}  (Config epoch ${String(decodeReserveDatum(configUtxo.datum!)!.fields[9])})`,
  );
  console.log(
    `committee      ${String(committee.threshold)}-of-${String(committee.operators.length)}; signing: ${SIGNERS.join(", ") || "-"}`,
  );
  console.log(`treasury       ${treasury}`);
  console.log(
    `bounds         long weight ${String(PROPOSED_BOUNDS.longWeightBps)} bps · cooldown 7 d · lock 30 d · protocol ${String(PROPOSED_BOUNDS.protocolBps)} bps`,
  );
  if (STAGES.some(done)) console.log(`already done   ${STAGES.filter(done).join(", ")}`);
  for (const b of built) {
    const fee = CML.Transaction.from_cbor_hex(b.tx.toCBOR()).body().fee();
    console.log(
      `\n[${b.name}]  ${String(b.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${b.tx.toHash()}`,
    );
    for (const [k, v] of Object.entries(b.record))
      if (!["genesisTx", "registrationTx", "setVaultTx", "bounds", "seed"].includes(k))
        console.log(`   ${k.padEnd(15)}${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  console.log("\nValidated: every script accepted these exact transactions in local evaluation.");

  if (!SUBMIT) {
    console.log(
      "\nDRY RUN — nothing signed or submitted. Seeds are chosen fresh on the --submit run.",
    );
    return;
  }

  for (const b of built) {
    let s = b.tx.sign.withWallet();
    if (b.name === "setVault") for (const k of signerKeys) s = s.sign.withPrivateKey(k);
    const hash = await (await s.complete()).submit();
    deployment[b.name] = {
      ...b.record,
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
    save();
    console.log(
      `\n[${b.name}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
    );
    if (!(await lucid.awaitTx(hash, 5_000)))
      die(`[${b.name}] not confirmed yet; ${FILE} records it as submitted. Re-check, then re-run.`);
    deployment[b.name] = {
      ...(deployment[b.name] as Rec),
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    };
    save();
    console.log(`[${b.name}] confirmed.`);
  }

  // Read back what matters.
  const cfg = (await lucid.utxosAt(reserveAddress)).find(
    (u) => (u.assets[configUnit] ?? 0n) === 1n,
  );
  const vp = cfg?.datum ? decodeReserveDatum(cfg.datum)?.fields[7] : undefined;
  const vaultRec = deployment.vault as Rec;
  const vaultAt = await lucid.utxosAt(vaultRec.address as string);
  const ok =
    vp === vaultRec.scriptHash &&
    vaultAt.some((u) => (u.assets[vaultRec.stateUnit as string] ?? 0n) === 1n);
  console.log(
    ok
      ? "\nConfirmed: vault State on chain and Config.vault_policy points at it."
      : "\nWARNING: read-back did not match; inspect the addresses above.",
  );
  console.log(`Commit ${FILE} (no keys in it).`);
}

main().catch((e: unknown) => {
  console.error(`[tessera-vault] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
