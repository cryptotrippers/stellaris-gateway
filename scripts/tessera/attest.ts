/**
 * Operator script: re-attest the TSRA reserve on Preprod.
 *
 * TSRA can only be minted while the reserve attestation is less than 7 days
 * old. This records a fresh attestation (committee M-of-N, 3 of 5 on
 * preprod-v1), so minting works again for the next 7 days.
 *
 *   npx tsx scripts/tessera/attest.ts --status
 *       read only: minted, attested reserve, cap, and until when it is fresh.
 *       No keys needed besides Blockfrost.
 *
 *   npx tsx scripts/tessera/attest.ts --keys-dir <dir> --signers c1,c2,c3
 *       dry run (default): builds the attestation and has every script
 *       evaluate it. Nothing signed.
 *
 *   ... --submit
 *       signs with the operator wallet (fees) and the committee keys, submits,
 *       and appends it to deployments/<label>.json under "attestations".
 *
 * Options
 *   --label <name>          deployment label (default preprod-v1)
 *   --reserve <TSRA>        new attested reserve in whole TSRA (default: keep
 *                           the current figure, so only the date moves)
 *   --allow-below-minted    allow attesting less than the minted supply
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 * Preprod only. Test reserve figures only: they attest nothing real.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, type UTxO } from "@lucid-evolution/lucid";
import { applyReserve } from "./lib/blueprint";
import { buildReattest, freshness, sydney } from "./lib/attest";
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
import { tsraToUnits } from "./lib/genesis";
import { committeeOf } from "./lib/vault-genesis";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[tessera-attest]");

const a = args();
try {
  for (const o of ["--label", "--keys-dir", "--signers", "--reserve"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const STATUS = a.flag("--status");
const LABEL = a.opt("--label") ?? "preprod-v1";
const KEYS_DIR = a.opt("--keys-dir");
const SIGNERS = (a.opt("--signers") ?? "c1,c2,c3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RESERVE = a.opt("--reserve");
const FILE = `deployments/${LABEL}.json`;

if (!existsSync(FILE)) die(`${FILE} not found — run from the repo root.`);
if (!STATUS && !KEYS_DIR)
  die("Give --keys-dir <dir> (the folder with c1.skey … c5.skey), or use --status.");
const KEY = preprodKey(die);

// The deployment record is loosely typed JSON written by the operator scripts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;
const dep = JSON.parse(readFileSync(FILE, "utf8")) as Rec;
if (dep.reserve?.status !== "confirmed") die(`${FILE}: the reserve is not confirmed.`);
dep.attestations ??= [];
const history = dep.attestations as Rec[];
const open = history.find((h) => h.status !== "confirmed");
if (open)
  die(
    `${FILE}: attestation ${String(open.tx)} is "${String(open.status)}". Check it on Cardanoscan; mark it confirmed or remove it.`,
  );
const save = () => writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
const tsra = (u: bigint) => `${(u / 1_000_000n).toLocaleString("en-US")} TSRA`;

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  const reserve = applyReserve(dep.reserve.seed);
  if (reserve.hash !== dep.reserve.scriptHash)
    die("Re-derived reserve hash does not match the record.");

  const one = async (unit: string): Promise<UTxO> => {
    const xs = (await lucid.utxosAt(dep.reserve.address)).filter(
      (u) => (u.assets[unit] ?? 0n) === 1n,
    );
    if (xs.length !== 1)
      die(`Expected one UTxO holding ${unit} at the reserve; found ${xs.length}.`);
    return xs[0]!;
  };
  const configRef = await one(dep.reserve.configUnit);
  const supply = await one(dep.reserve.supplyUnit);
  const now = Date.now();
  const f = freshness(supply, now);

  console.log(
    `== Tessera reserve attestation — ${LABEL} (${STATUS ? "STATUS" : SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`,
  );
  console.log(
    `minted         ${tsra(f.minted)} · attested reserve ${tsra(f.attestedReserve)} · cap ${tsra(f.mintCap)}`,
  );
  console.log(
    `last attested  ${sydney(f.attestedAt)} Sydney (attestation #${f.attestationEpoch}) — ` +
      (f.fresh
        ? `fresh until ${sydney(f.freshUntil)} Sydney`
        : `STALE since ${sydney(f.freshUntil)} Sydney: no TSRA can be minted`),
  );
  console.log(`mintable now   ${tsra(f.mintable)}`);
  if (STATUS) return;

  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const dirty = git("status --porcelain -- contracts/tessera scripts/tessera");
  if (SUBMIT && dirty)
    die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);

  const committee = committeeOf(configRef.datum!);
  const signerKeys = SIGNERS.map((n) => {
    const file = join(KEYS_DIR!, `${n}.skey`);
    if (!existsSync(file)) die(`${file} not found.`);
    return skeyFileToBech32(file);
  });
  const signers = signerKeys.map(keyHashOf);
  for (const [i, h] of signers.entries())
    if (!committee.operators.includes(h)) die(`${SIGNERS[i]!} is not on the reserve committee.`);
  if (new Set(signers).size < committee.threshold)
    die(
      `Attest needs ${committee.threshold} distinct committee signers; got ${new Set(signers).size}.`,
    );

  let built;
  try {
    built = await buildReattest(
      lucid,
      { reserve, reserveAddress: dep.reserve.address, configRef, signers },
      supply,
      now,
      {
        reserve: RESERVE ? tsraToUnits(RESERVE) : undefined,
        allowBelowMinted: a.flag("--allow-below-minted"),
      },
    );
  } catch (e) {
    die((e as Error).message);
  }
  const { step } = built;
  const attestedAt = Number(step.record.attestedAt);
  const fee = CML.Transaction.from_cbor_hex(step.tx.toCBOR()).body().fee();
  console.log(`\n[attest]  ${step.tx.toCBOR().length / 2} bytes · fee ${ada(fee)}`);
  console.log(
    `   reserve       ${tsra(built.reserve)}${built.reserve === f.attestedReserve ? " (unchanged)" : ""}`,
  );
  console.log(`   attested at   ${sydney(attestedAt)} Sydney`);
  console.log(`   fresh until   ${sydney(attestedAt + 7 * 86_400_000)} Sydney`);
  console.log(
    `   signers       ${SIGNERS.join(", ")} (${committee.threshold} of ${committee.operators.length} needed)`,
  );
  console.log("Validated: the reserve script accepted this exact transaction in local evaluation.");
  if (!SUBMIT) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }

  let s = step.tx.sign.withWallet();
  for (const k of signerKeys) s = s.sign.withPrivateKey(k);
  const hash = await (await s.complete()).submit();
  const rec: Rec = {
    attestedReserve: built.reserve.toString(),
    attestedAt,
    attestationEpoch: (f.attestationEpoch + 1n).toString(),
    signers: SIGNERS,
    tx: hash,
    status: "submitted",
    submittedAt: new Date().toISOString(),
  };
  history.push(rec);
  save();
  console.log(`\n[attest] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`);
  if (!(await lucid.awaitTx(hash, 5_000)))
    die(`Not confirmed yet; ${FILE} records it as submitted.`);
  rec.status = "confirmed";
  rec.confirmedAt = new Date().toISOString();
  save();
  console.log(
    `[attest] confirmed. TSRA can be minted until ${sydney(attestedAt + 7 * 86_400_000)} Sydney.`,
  );
  console.log(`Commit ${FILE} (no keys in it).`);
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
