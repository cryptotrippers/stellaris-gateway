/**
 * Operator script: stand up the redemption queue on Preprod (Phase 4, step 3).
 * Needs a confirmed Reserve genesis in deployments/<label>.json.
 *
 *   npx tsx scripts/tessera/bootstrap-queue.ts --keys-dir <dir> --signers c1,c2,c3
 *       dry run (default): builds the remaining stages as a chain, evaluates every
 *       script against those exact transactions, prints the plan. Nothing signed.
 *
 *   ... --submit --accept-provisional
 *       submits stage by stage, waiting for each to confirm and recording it in
 *       deployments/<label>.json first. Re-running resumes after the last
 *       confirmed stage.
 *
 * Stages: tusd → refFlow → refAdmin → refShort → queueStake → queue
 * (see lib/build-queue.ts). Queue settings: SPEC §4.12 defaults (settle delay
 * 2 d, min request 100, instant max 10,000, tip 0.2 ADA, 4 shards, grace 14 d)
 * with launch limits 50,000/day and 500,000/month in tUSD.
 *
 * About 155 tADA is locked for good under the three reference scripts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import { applyReserve } from "./lib/blueprint";
import {
  QUEUE_BUILDERS,
  QUEUE_STAGES,
  type QueueContext,
  type QueueStage,
} from "./lib/build-queue";
import type { Built } from "./lib/build-vault";
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
import { committeeOf } from "./lib/vault-genesis";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[tessera-queue]");

const a = args();
try {
  for (const o of ["--label", "--keys-dir", "--signers"]) a.opt(o);
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
const FILE = `deployments/${LABEL}.json`;

if (SUBMIT && !a.flag("--accept-provisional"))
  die(
    "--submit needs --accept-provisional (queue and reserve datums are provisional, SPEC.md §1).",
  );
if (!existsSync(FILE)) die(`${FILE} not found — run bootstrap-reserve first, from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, unknown> & { status?: string };
const deployment = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown> & {
  reserve?: Rec;
};
const rec = (s: string) => deployment[s] as Rec | undefined;
if (rec("reserve")?.status !== "confirmed") die(`${FILE}: the reserve genesis is not confirmed.`);
const done = (s: QueueStage) => rec(s)?.status === "confirmed";
for (const s of QUEUE_STAGES) {
  const st = rec(s)?.status;
  if (st && st !== "confirmed")
    die(
      `${FILE}: stage ${s} is "${st}". Check its tx on Cardanoscan; mark it confirmed or remove it, then re-run.`,
    );
}
const pending = QUEUE_STAGES.filter((s) => !done(s));
if (!pending.length) {
  console.log(`All queue stages are already confirmed in ${FILE}. Nothing to do.`);
  process.exit(0);
}
const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty)
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);
const save = () => writeFileSync(FILE, JSON.stringify(deployment, null, 2) + "\n");

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const operatorKeyHash = getAddressDetails(operator).paymentCredential!.hash;

  const r = rec("reserve")!;
  const reserve = applyReserve(r.seed as { txHash: string; outputIndex: number });
  if (reserve.hash !== r.scriptHash)
    die(`Re-derived reserve hash ${reserve.hash} ≠ recorded ${String(r.scriptHash)}.`);
  const atReserve = await lucid.utxosAt(r.address as string);
  const one = (unit: string): UTxO => {
    const xs = atReserve.filter((u) => (u.assets[unit] ?? 0n) === 1n);
    if (xs.length !== 1)
      die(`Expected one genuine reserve UTxO holding ${unit}, found ${String(xs.length)}.`);
    return xs[0]!;
  };
  const reserveConfig = one(r.configUnit as string);
  const reserveSupply = one(r.supplyUnit as string);
  const committee = committeeOf(reserveConfig.datum!);

  let signerKeys: string[] = [];
  let signerHashes: string[] = [];
  if (pending.includes("queue")) {
    const dir = KEYS_DIR;
    if (!dir || SIGNERS.length === 0)
      die("Queue Genesis needs --keys-dir <dir> and --signers c1,c2,c3.");
    signerKeys = SIGNERS.map((n) => {
      const f = join(dir, `${n}.skey`);
      if (!existsSync(f)) die(`${f} not found.`);
      return skeyFileToBech32(f);
    });
    signerHashes = signerKeys.map(keyHashOf);
    for (const [i, h] of signerHashes.entries())
      if (!committee.operators.includes(h))
        die(`${SIGNERS[i]!} (${h}) is not on the reserve committee.`);
    if (new Set(signerHashes).size < committee.threshold)
      die(`Genesis needs ${String(committee.threshold)} distinct committee signers.`);
  }

  // Resume: reference scripts and tUSD from earlier confirmed stages.
  const ctx: QueueContext = {
    reserve,
    operatorKeyHash,
    reserveConfig,
    reserveSupply,
    signers: signerHashes,
    refs: {},
    tusdPolicyId: rec("tusd")?.policyId as string | undefined,
  };
  if (
    ctx.tusdPolicyId &&
    rec("tusd")!.nativeScript &&
    (rec("tusd")!.nativeScript as { keyHash: string }).keyHash !== operatorKeyHash
  )
    die("This operator key is not the tUSD minting key recorded in the deployment.");
  for (const [stage, k] of [
    ["refFlow", "flow"],
    ["refAdmin", "admin"],
    ["refShort", "short"],
  ] as const) {
    const ref = rec(stage)?.refUtxo as string | undefined;
    if (!done(stage) || !ref) continue;
    const [txHash, ix] = ref.split("#");
    const [u] = await lucid.utxosByOutRef([{ txHash: txHash!, outputIndex: Number(ix) }]);
    if (!u?.scriptRef) die(`Reference script ${ref} (${stage}) not found on chain.`);
    ctx.refs[k] = u;
  }

  const built: Built[] = [];
  for (const s of pending) built.push(await QUEUE_BUILDERS[s](lucid, ctx, Date.now()));

  console.log(
    `== Tessera redemption queue bootstrap — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`,
  );
  console.log(`operator       ${operator}`);
  console.log(`reserve        ${reserve.hash}`);
  console.log(
    `committee      ${String(committee.threshold)}-of-${String(committee.operators.length)}; signing Genesis: ${SIGNERS.join(", ") || "-"}`,
  );
  if (QUEUE_STAGES.some(done))
    console.log(`already done   ${QUEUE_STAGES.filter(done).join(", ")}`);
  for (const b of built) {
    const fee = CML.Transaction.from_cbor_hex(b.tx.toCBOR()).body().fee();
    console.log(
      `\n[${b.name}]  ${String(b.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${b.tx.toHash()}`,
    );
    for (const [k, v] of Object.entries(b.record))
      if (
        ![
          "mintTx",
          "registrationTx",
          "genesisTx",
          "seed",
          "nativeScript",
          "shardUnits",
          "signers",
        ].includes(k)
      )
        console.log(`   ${k.padEnd(15)}${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  console.log("\nValidated: every script accepted these exact transactions in local evaluation.");
  if (!SUBMIT) {
    console.log(
      "\nDRY RUN — nothing signed or submitted. The queue seed is chosen afresh on the --submit run.",
    );
    return;
  }

  for (const b of built) {
    let s = b.tx.sign.withWallet();
    if (b.name === "queue") for (const k of signerKeys) s = s.sign.withPrivateKey(k);
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
      die(`[${b.name}] not confirmed yet; ${FILE} records it as submitted.`);
    deployment[b.name] = {
      ...(deployment[b.name] as Rec),
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    };
    save();
    console.log(`[${b.name}] confirmed.`);
  }

  const q = rec("queue");
  if (q?.status === "confirmed") {
    const at = await lucid.utxosAt(q.address as string);
    const ok = at.length === (q.shardUnits as string[]).length + 2;
    console.log(
      ok
        ? `\nConfirmed: queue address holds Config + Short + ${String((q.shardUnits as string[]).length)} shards.`
        : "\nWARNING: unexpected UTxOs at the queue address; inspect it.",
    );
  }
  console.log(`Commit ${FILE} (no keys in it).`);
}

main().catch((e: unknown) => {
  console.error(`[tessera-queue] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
