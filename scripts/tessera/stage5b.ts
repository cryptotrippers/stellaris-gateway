/**
 * Operator script: Stage 5b on Preprod — yield, exit and redemption.
 * Needs Stage 5a confirmed in deployments/<label>.json.
 *
 *   npx tsx scripts/tessera/stage5b.ts --keys-dir <dir> --signers c1,c2,c3
 *       dry run (default). Nothing signed.
 *   ... --submit
 *       submits step by step, recording each under "stage5b". Re-running resumes.
 *
 * Steps: refVault → refOps → refFirstLoss → refReserve (reference scripts,
 * ~200 tADA locked for good) → reportYield → unstake → request → instant.
 *
 * Amounts (whole units; defaults): --yield 100 (TSRA paid into the vault as
 * yield) --unstake 400 (sTSRA) --request 500 (TSRA queued for tUSD)
 * --instant 250 (TSRA swapped for tUSD now, from --shard 0).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import {
  applyFirstLoss,
  applyQueueScripts,
  applyRedeemQueue,
  applyReserve,
  applyVault,
  applyVaultOps,
  rewardAddress,
} from "./lib/blueprint";
import type { Step } from "./lib/build-actions";
import {
  buildInstant,
  buildRef,
  buildReportYield,
  buildRequest,
  buildRequestUnstake,
  type QueueCtx,
  type VaultCtx,
} from "./lib/build-5b";
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
const die: (msg: string) => never = makeDie("[tessera-5b]");
const STEPS = [
  "refVault",
  "refOps",
  "refFirstLoss",
  "refReserve",
  "reportYield",
  "unstake",
  "request",
  "instant",
] as const;
type StepName = (typeof STEPS)[number];
const COMMITTEE_STEPS: StepName[] = ["reportYield"];

const a = args();
try {
  for (const o of [
    "--label",
    "--keys-dir",
    "--signers",
    "--yield",
    "--unstake",
    "--request",
    "--instant",
    "--shard",
  ])
    a.opt(o);
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
const AMT = {
  yield: tsraToUnits(a.opt("--yield") ?? "100"),
  unstake: tsraToUnits(a.opt("--unstake") ?? "400"),
  request: tsraToUnits(a.opt("--request") ?? "500"),
  instant: tsraToUnits(a.opt("--instant") ?? "250"),
};
const SHARD = Number(a.opt("--shard") ?? "0");
const FILE = `deployments/${LABEL}.json`;
if (!existsSync(FILE)) die(`${FILE} not found — run from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, any>;
const dep = JSON.parse(readFileSync(FILE, "utf8")) as Rec;
for (const s of ["attest", "mint", "stake", "fund"])
  if (dep.stage5a?.[s]?.status !== "confirmed")
    die(`${FILE}: stage5a.${s} is not confirmed — run Stage 5a first.`);
dep.stage5b ??= {};
const s5 = dep.stage5b as Record<string, Rec>;
for (const s of STEPS)
  if (s5[s]?.status && s5[s].status !== "confirmed")
    die(`${FILE}: stage5b.${s} is "${String(s5[s].status)}". Check it on Cardanoscan first.`);
const pending = STEPS.filter((s) => s5[s]?.status !== "confirmed");
if (!pending.length) {
  console.log("Stage 5b is already confirmed. Nothing to do.");
  process.exit(0);
}
const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty)
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);
const save = () => writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const opKey = getAddressDetails(operator).paymentCredential!.hash;

  const reserve = applyReserve(dep.reserve.seed);
  const ops = applyVaultOps(reserve.hash);
  const vault = applyVault(dep.vault.seed, reserve.hash, ops.hash);
  const fl = applyFirstLoss(dep.firstLoss.seed, reserve.hash);
  const qs = applyQueueScripts(reserve.hash);
  const queue = applyRedeemQueue(dep.queue.seed, reserve.hash, {
    flow: qs.flow.hash,
    admin: qs.admin.hash,
    short: qs.short.hash,
  });
  for (const [n, h, r] of [
    ["reserve", reserve.hash, dep.reserve.scriptHash],
    ["vault", vault.hash, dep.vault.scriptHash],
    ["first-loss", fl.hash, dep.firstLoss.scriptHash],
    ["queue", queue.hash, dep.queue.scriptHash],
  ] as const)
    if (h !== r) die(`Re-derived ${n} hash does not match the record.`);

  const one = async (addr: string, unit: string): Promise<UTxO> => {
    const xs = (await lucid.utxosAt(addr)).filter((u) => (u.assets[unit] ?? 0n) === 1n);
    if (xs.length !== 1)
      die(`Expected one UTxO holding ${unit} at ${addr}; found ${String(xs.length)}.`);
    return xs[0]!;
  };
  const byRef = async (ref: string): Promise<UTxO> => {
    const [h, i] = ref.split("#");
    const [u] = await lucid.utxosByOutRef([{ txHash: h!, outputIndex: Number(i) }]);
    if (!u?.scriptRef) die(`Reference script ${ref} not found on chain.`);
    return u;
  };
  const reserveConfig = await one(dep.reserve.address, dep.reserve.configUnit);
  const reserveSupply = await one(dep.reserve.address, dep.reserve.supplyUnit);
  const committee = committeeOf(reserveConfig.datum!);

  let signerKeys: string[] = [];
  let signers: string[] = [];
  if (pending.some((s) => COMMITTEE_STEPS.includes(s))) {
    const dir = KEYS_DIR;
    if (!dir || !SIGNERS.length) die("ReportYield needs --keys-dir <dir> and --signers c1,c2,c3.");
    signerKeys = SIGNERS.map((n) => {
      const f = join(dir, `${n}.skey`);
      if (!existsSync(f)) die(`${f} not found.`);
      return skeyFileToBech32(f);
    });
    signers = signerKeys.map(keyHashOf);
    for (const [i, h] of signers.entries())
      if (!committee.operators.includes(h)) die(`${SIGNERS[i]!} is not on the reserve committee.`);
    if (new Set(signers).size < committee.threshold)
      die(`Need ${String(committee.threshold)} distinct committee signers.`);
  }

  const now = Date.now();
  const built: Step[] = [];
  const refs: Record<string, UTxO> = {};
  const scripts = { refVault: vault, refOps: ops, refFirstLoss: fl, refReserve: reserve } as const;
  for (const r of ["refVault", "refOps", "refFirstLoss", "refReserve"] as const) {
    if (s5[r]?.status === "confirmed") refs[r] = await byRef(s5[r].refUtxo);
    else if (pending.includes(r)) {
      const st = await buildRef(lucid, r, scripts[r]);
      refs[r] = st.derived.find((u) => u.scriptRef)!;
      built.push(st);
    }
  }
  const vc: VaultCtx = {
    vault,
    ops,
    opsReward: rewardAddress("Preprod", ops),
    reserveHash: reserve.hash,
    refs: { vault: refs.refVault!, ops: refs.refOps!, firstLoss: refs.refFirstLoss! },
    reserveConfig,
    reserveSupply,
    signers,
  };
  let state = await one(dep.vault.address, dep.vault.stateUnit);
  if (pending.includes("reportYield")) {
    const st = await buildReportYield(
      lucid,
      vc,
      state,
      await one(dep.firstLoss.address, dep.firstLoss.stateUnit),
      AMT.yield,
      now,
    );
    state = st.derived.find((u) => (u.assets[dep.vault.stateUnit] ?? 0n) === 1n)!;
    built.push(st);
  }
  if (pending.includes("unstake"))
    built.push(await buildRequestUnstake(lucid, vc, state, AMT.unstake, operator, now));
  const [flowRef] = await lucid.utxosByOutRef([
    {
      txHash: dep.refFlow.refUtxo.split("#")[0],
      outputIndex: Number(dep.refFlow.refUtxo.split("#")[1]),
    },
  ]);
  if (!flowRef?.scriptRef) die("queue_flow reference script not found on chain.");
  const qc: QueueCtx = {
    queue,
    flowReward: rewardAddress("Preprod", qs.flow),
    reserveHash: reserve.hash,
    refs: { flow: flowRef },
    queueConfig: await one(dep.queue.address, dep.queue.configUnit),
    queueShort: await one(dep.queue.address, dep.queue.shortUnit),
    reserveConfig,
  };
  if (pending.includes("request"))
    built.push(await buildRequest(lucid, qc, AMT.request, opKey, operator, now));
  if (pending.includes("instant")) {
    const unit = (dep.queue.shardUnits as string[])[SHARD];
    if (!unit) die("--shard out of range.");
    built.push(
      await buildInstant(
        lucid,
        qc,
        await one(dep.queue.address, unit),
        AMT.instant,
        opKey,
        operator,
        now,
      ),
    );
  }

  console.log(`== Tessera Stage 5b — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator     ${operator}`);
  if (STEPS.some((s) => s5[s]?.status === "confirmed"))
    console.log(`already done ${STEPS.filter((s) => s5[s]?.status === "confirmed").join(", ")}`);
  for (const b of built) {
    const fee = CML.Transaction.from_cbor_hex(b.tx.toCBOR()).body().fee();
    console.log(
      `\n[${b.name}]  ${String(b.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${b.tx.toHash()}`,
    );
    for (const [k, v] of Object.entries(b.record))
      if (k !== "tx") console.log(`   ${k.padEnd(16)}${String(v)}`);
  }
  console.log("\nValidated: every script accepted these exact transactions in local evaluation.");
  if (!SUBMIT) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }
  for (const b of built) {
    let s = b.tx.sign.withWallet();
    if (COMMITTEE_STEPS.includes(b.name as StepName))
      for (const k of signerKeys) s = s.sign.withPrivateKey(k);
    const hash = await (await s.complete()).submit();
    s5[b.name] = { ...b.record, status: "submitted", submittedAt: new Date().toISOString() };
    save();
    console.log(
      `\n[${b.name}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
    );
    if (!(await lucid.awaitTx(hash, 5_000)))
      die(`[${b.name}] not confirmed yet; recorded as submitted.`);
    s5[b.name] = { ...s5[b.name], status: "confirmed", confirmedAt: new Date().toISOString() };
    save();
    console.log(`[${b.name}] confirmed.`);
  }
  const u = s5.unstake;
  const r = s5.request;
  console.log(`\nStage 5b confirmed. Commit ${FILE}.`);
  if (u?.claimAfterIso) console.log(`Ticket claimable after ${String(u.claimAfterIso)} (UTC).`);
  if (r?.payableAfterIso)
    console.log(`Request settleable after ${String(r.payableAfterIso)} (UTC).`);
}

main().catch((e: unknown) => {
  console.error(`[tessera-5b] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
