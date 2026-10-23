/**
 * Operator script: Stage 5c on Preprod — close the loops opened in 5b.
 * Needs Stage 5b confirmed in deployments/<label>.json. No committee keys:
 * every step here is permissionless (the operator wallet pays the fees).
 *
 *   npx tsx scripts/tessera/stage5c.ts            dry run (default). Nothing signed.
 *   npx tsx scripts/tessera/stage5c.ts --submit   submit what is ready, record each
 *                                                 under "stage5c". Re-run later for the rest.
 *
 * Steps, each run only once its time has come:
 *   settle  pay every payable Request in tUSD from --shard (default 0)
 *           — opens at the Request's payable_after (26 Oct 00:00 UTC, 11:00 Sydney).
 *   sweep   burn the TSRA in every Sink through the reserve (after settle).
 *   claim   pay the 400 TSRA Ticket to its owner
 *           — opens at its claim_after (30 Oct 01:48 UTC, 12:48 Sydney).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Blockfrost, CML, Lucid, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import {
  applyQueueScripts,
  applyRedeemQueue,
  applyReserve,
  applyVault,
  applyVaultOps,
  rewardAddress,
} from "./lib/blueprint";
import type { Step } from "./lib/build-actions";
import {
  buildClaim,
  buildSettle,
  buildSweep,
  payable,
  payableAfterOf,
  sinksAt,
  ticketFields,
} from "./lib/build-5c";
import { ada, args, git, makeDie, preprodKey, selectOperator } from "./lib/cli";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[tessera-5c]");
const STEPS = ["settle", "sweep", "claim"] as const;
type StepName = (typeof STEPS)[number];

const a = args();
try {
  for (const o of ["--label", "--shard"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const LABEL = a.opt("--label") ?? "preprod-v1";
const SHARD = Number(a.opt("--shard") ?? "0");
const FILE = `deployments/${LABEL}.json`;
if (!existsSync(FILE)) die(`${FILE} not found — run from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, any>;
const dep = JSON.parse(readFileSync(FILE, "utf8")) as Rec;
for (const s of ["refVault", "refOps", "refReserve", "unstake", "request", "instant"])
  if (dep.stage5b?.[s]?.status !== "confirmed")
    die(`${FILE}: stage5b.${s} is not confirmed — run Stage 5b first.`);
dep.stage5c ??= {};
const s5 = dep.stage5c as Record<string, Rec>;
for (const s of STEPS)
  if (s5[s]?.status && s5[s].status !== "confirmed")
    die(`${FILE}: stage5c.${s} is "${String(s5[s].status)}". Check it on Cardanoscan first.`);
const pending = STEPS.filter((s) => s5[s]?.status !== "confirmed");
if (!pending.length) {
  console.log("Stage 5c is already confirmed. Nothing to do.");
  process.exit(0);
}
const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty)
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);
const save = () => writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
const sydney = (ms: number | bigint) =>
  new Date(Number(ms)).toLocaleString("en-AU", { timeZone: "Australia/Sydney" });

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const opKey = getAddressDetails(operator).paymentCredential!.hash;

  const reserve = applyReserve(dep.reserve.seed);
  const ops = applyVaultOps(reserve.hash);
  const vault = applyVault(dep.vault.seed, reserve.hash, ops.hash);
  const qs = applyQueueScripts(reserve.hash);
  const queue = applyRedeemQueue(dep.queue.seed, reserve.hash, {
    flow: qs.flow.hash,
    admin: qs.admin.hash,
    short: qs.short.hash,
  });
  for (const [n, h, r] of [
    ["reserve", reserve.hash, dep.reserve.scriptHash],
    ["vault", vault.hash, dep.vault.scriptHash],
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
  const now = Date.now();
  const built: Step[] = [];
  const notYet: string[] = [];
  const atQ = await lucid.utxosAt(dep.queue.address);
  const reqUnit = queue.hash + "72657175657374";
  let sinks = sinksAt(atQ);

  if (pending.includes("settle")) {
    const reqs = atQ.filter((u) => (u.assets[reqUnit] ?? 0n) === 1n);
    const ready = payable(reqs, now);
    if (!reqs.length) die("No Request at the queue to settle.");
    if (!ready.length) {
      const first = Math.min(...reqs.map((r) => Number(payableAfterOf(r))));
      notYet.push(`settle  opens ${sydney(first)} Sydney (${new Date(first).toISOString()})`);
    } else {
      const unit = (dep.queue.shardUnits as string[])[SHARD];
      if (!unit) die("--shard out of range.");
      const st = await buildSettle(
        lucid,
        {
          queue,
          flowReward: rewardAddress("Preprod", qs.flow),
          reserveHash: reserve.hash,
          refs: { flow: await byRef(dep.refFlow.refUtxo) },
          queueConfig: await one(dep.queue.address, dep.queue.configUnit),
          queueShort: await one(dep.queue.address, dep.queue.shortUnit),
          reserveConfig,
        },
        await one(dep.queue.address, unit),
        ready,
        now,
      );
      built.push(st);
      sinks = [...sinks, ...sinksAt(st.derived)];
    }
  }

  const settleDone = s5.settle?.status === "confirmed" || built.some((b) => b.name === "settle");
  if (pending.includes("sweep")) {
    if (!settleDone) notYet.push("sweep   after settle (one sweep burns every Sink)");
    else if (!sinks.length) notYet.push("sweep   no Sinks to sweep");
    else
      built.push(
        await buildSweep(
          lucid,
          {
            queue,
            flowReward: rewardAddress("Preprod", qs.flow),
            reserveHash: reserve.hash,
            reserveAddress: dep.reserve.address,
            refs: {
              flow: await byRef(dep.refFlow.refUtxo),
              reserve: await byRef(dep.stage5b.refReserve.refUtxo),
            },
            reserveConfig,
          },
          sinks,
          await one(dep.reserve.address, dep.reserve.supplyUnit),
          opKey,
          now,
        ),
      );
  }

  if (pending.includes("claim")) {
    const [h, i] = (dep.stage5b.unstake.ticket as string).split("#");
    const [tk] = await lucid.utxosByOutRef([{ txHash: h!, outputIndex: Number(i) }]);
    if (!tk)
      die(`Ticket ${String(dep.stage5b.unstake.ticket)} is not on chain (already claimed?).`);
    const t = ticketFields(tk);
    if (BigInt(now - 120_000) < t.claimAfter)
      notYet.push(
        `claim   opens ${sydney(t.claimAfter)} Sydney (${new Date(Number(t.claimAfter)).toISOString()})`,
      );
    else
      built.push(
        await buildClaim(
          lucid,
          {
            vault,
            opsReward: rewardAddress("Preprod", ops),
            reserveHash: reserve.hash,
            refs: {
              vault: await byRef(dep.stage5b.refVault.refUtxo),
              ops: await byRef(dep.stage5b.refOps.refUtxo),
            },
            reserveConfig,
          },
          await one(dep.vault.address, dep.vault.stateUnit),
          tk,
          now,
        ),
      );
  }

  console.log(`== Tessera Stage 5c — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator     ${operator}`);
  if (STEPS.some((s) => s5[s]?.status === "confirmed"))
    console.log(`already done ${STEPS.filter((s) => s5[s]?.status === "confirmed").join(", ")}`);
  for (const n of notYet) console.log(`not yet      ${n}`);
  for (const b of built) {
    const fee = CML.Transaction.from_cbor_hex(b.tx.toCBOR()).body().fee();
    console.log(
      `\n[${b.name}]  ${String(b.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${b.tx.toHash()}`,
    );
    for (const [k, v] of Object.entries(b.record))
      if (k !== "tx") console.log(`   ${k.padEnd(18)}${String(v)}`);
  }
  if (!built.length) {
    console.log("\nNothing is ready yet. Re-run at the time shown above.");
    return;
  }
  console.log("\nValidated: every script accepted these exact transactions in local evaluation.");
  if (!SUBMIT) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }
  for (const b of built) {
    const hash = await (await b.tx.sign.withWallet().complete()).submit();
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
  const left: StepName[] = STEPS.filter((s) => s5[s]?.status !== "confirmed");
  console.log(
    left.length
      ? `\nRecorded in ${FILE}. Still to do: ${left.join(", ")} — re-run then. Commit ${FILE}.`
      : `\nStage 5c confirmed. Commit ${FILE}.`,
  );
}

main().catch((e: unknown) => {
  console.error(`[tessera-5c] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
