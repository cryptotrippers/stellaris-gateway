/**
 * Operator script: the fraction_vault v2 keeper for one Preprod offering.
 *
 *   npx tsx scripts/fv2/keeper.ts
 *       dry run (default): reads the offering and its pledges, prints what the
 *       keeper would do now and any notes for the committee, and builds the
 *       first job (Blockfrost evaluates its scripts; the S1 guard checks it).
 *       Nothing is signed.
 *
 *   ... --submit [--max-jobs N]
 *       runs the jobs one at a time, re-reading the chain before each, until
 *       nothing is left to do now (or N jobs, default 10).
 *
 *   ... --submit --watch [--every <minutes>]
 *       keeps running: a pass every <minutes> (default 10) until Ctrl+C. A
 *       failed pass is logged and the next one starts from the chain again.
 *
 * What the keeper does (src/lib/offering-v2-keeper.ts):
 *   - Settle: marked pledges, first come first served, 15 per transaction, up
 *     to the hard cap, while 10+ minutes of the settle window remain. Only if
 *     this wallet holds the offering's keeper key.
 *   - FailRaise: once the settle window is over with the soft cap missed (anyone may).
 *   - Refunds: returns pledges the raise can no longer take to their owners,
 *     15 per transaction (anyone may). Unmarked UTxOs only with --return-strays.
 *   - Never signs a committee action; prints when one is due (e.g. CloseRaise).
 *
 * Options
 *   --label <name>     deployment label (default fv2-preprod-test): reads
 *                      deployments/<name>.json for the offering and its refs
 *   --submit           sign and submit
 *   --max-jobs <n>     jobs per pass (default 10)
 *   --watch            repeat passes until stopped
 *   --every <minutes>  minutes between passes with --watch (default 10)
 *   --return-strays    also return unmarked UTxOs that name this offering
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE (the
 * keeper wallet; pays the fees). Log: logs/<label>-keeper.jsonl (git-ignored).
 * Preprod only. Test TSRA only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as L from "@lucid-evolution/lucid";
import { Blockfrost, CML, Lucid, getAddressDetails } from "@lucid-evolution/lucid";
import { ada, args, makeDie, preprodKey, selectOperator } from "../tessera/lib/cli";
import { deriveTestOffering, guard, walletCaughtUp } from "./lib/bootstrap";
import {
  findPledges,
  findState,
  type LucidModTx,
  type V2Context,
} from "../../src/lib/offering-v2-tx";
import {
  buildKeeperJob,
  describeJob,
  planKeeper,
  runKeeper,
  type KeeperOptions,
} from "../../src/lib/offering-v2-keeper";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[fv2-keeper]");

const a = args();
try {
  for (const o of ["--label", "--max-jobs", "--every"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const WATCH = a.flag("--watch");
const LABEL = a.opt("--label") ?? "fv2-preprod-test";
const MAX_JOBS = Number(a.opt("--max-jobs") ?? "10");
const EVERY_MIN = Number(a.opt("--every") ?? "10");
const FILE = `deployments/${LABEL}.json`;
const LOG = `logs/${LABEL}-keeper.jsonl`;

if (WATCH && !SUBMIT) die("--watch needs --submit.");
if (!Number.isInteger(MAX_JOBS) || MAX_JOBS < 1) die("--max-jobs must be a whole number ≥ 1.");
if (!(EVERY_MIN >= 1)) die("--every must be at least 1 minute.");
if (!existsSync(FILE)) die(`${FILE} not found. Run from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, unknown> & { status?: string };
const deployment = JSON.parse(readFileSync(FILE, "utf8")) as { open?: Rec; refs?: Rec };
if (deployment.open?.status !== "confirmed" || deployment.refs?.status !== "confirmed")
  die(`${FILE}: the offering's open and refs stages must both be confirmed.`);

function log(event: Record<string, unknown>) {
  mkdirSync("logs", { recursive: true });
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

async function setup() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const address = await lucid.wallet().address();
  if (!address.startsWith("addr_test1")) die("The keeper wallet is not a testnet address.");
  const cred = getAddressDetails(address).paymentCredential;
  if (!cred || cred.type !== "Key") die("The keeper wallet must be a key address.");
  const keyHash = cred.hash;

  const open = deployment.open!;
  const scripts = deriveTestOffering(
    open.seed as { txHash: string; outputIndex: number },
    "Preprod",
  );
  if (scripts.offering.hash !== open.offeringHash)
    die(
      `Re-derived offering hash ${scripts.offering.hash} ≠ recorded ${String(open.offeringHash)}.`,
    );
  const refsRec = deployment.refs!;
  const outRef = (s: string) => {
    const [txHash, ix] = s.split("#");
    return { txHash: txHash!, outputIndex: Number(ix) };
  };
  const [r0, r1, r2] = await lucid.utxosByOutRef([
    outRef(refsRec.offering as string),
    outRef(refsRec.pledge as string),
    outRef(refsRec.fraction as string),
  ]);
  if (!r0?.scriptRef || !r1?.scriptRef || !r2?.scriptRef)
    die("A recorded reference script is missing on chain.");
  const ctx: V2Context = {
    lucid,
    mod: L as unknown as LucidModTx,
    scripts,
    refs: { offering: r0, pledge: r1, fraction: r2 },
  };
  return { lucid, ctx, address, keyHash };
}

async function pass(env: Awaited<ReturnType<typeof setup>>) {
  const { lucid, ctx, address, keyHash } = env;
  const { state, utxo } = await findState(ctx);
  const pledges = await findPledges(ctx);
  const opts: KeeperOptions = {
    isKeeper: state.terms.keeper.toLowerCase() === keyHash,
    returnStrays: a.flag("--return-strays"),
  };
  const now = Date.now();
  const plan = planKeeper(state, pledges, now, opts);
  const lovelace = (await lucid.wallet().getUtxos()).reduce(
    (x, u) => x + (u.assets.lovelace ?? 0n),
    0n,
  );
  const t = state.terms;

  console.log(
    `\n== fv2 keeper — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) — ${new Date(now).toISOString()} ==`,
  );
  console.log(`offering       ${ctx.scripts.offering.hash}`);
  console.log(
    `state          ${state.status} · settled ${state.book.settled}/${t.totalFractions} (soft cap ${t.softCap}) · State tx ${utxo.txHash.slice(0, 16)}…`,
  );
  console.log(
    `deadline       ${new Date(Number(t.deadline)).toISOString()} · settle window ends ${new Date(Number(plan.windowEnd)).toISOString()}`,
  );
  console.log(
    `pledges        ${pledges.filter((p) => p.marked).length} marked, ${pledges.filter((p) => !p.marked).length} unmarked`,
  );
  console.log(
    `wallet         ${address} · ${ada(lovelace)} · ${opts.isKeeper ? "holds the keeper key" : "NOT the keeper key"}`,
  );
  console.log(`jobs           ${plan.jobs.length ? plan.jobs.map(describeJob).join(" → ") : "-"}`);
  for (const n of plan.notes) console.log(`${n.level.toUpperCase().padEnd(15)}${n.text}`);
  log({
    event: "plan",
    status: state.status,
    settled: String(state.book.settled),
    jobs: plan.jobs.map(describeJob),
    notes: plan.notes,
  });

  if (plan.jobs.length === 0) return;
  if (lovelace < 10_000_000n) die("Keep at least 10 tADA in the keeper wallet for fees.");

  if (!SUBMIT) {
    const job = plan.jobs[0]!;
    const built = await buildKeeperJob(ctx, job, keyHash, Date.now());
    await guard(lucid, { name: "open", tx: built.tx, intent: built.intent, record: {} });
    const fee = CML.Transaction.from_cbor_hex(built.tx.toCBOR()).body().fee();
    console.log(`\n[${describeJob(job)}]  ${built.tx.toCBOR().length / 2} bytes · fee ${ada(fee)}`);
    console.log("Validated: Blockfrost evaluated its scripts and it passed the S1 intent guard.");
    console.log("DRY RUN — nothing signed or submitted.");
    return;
  }

  const r = await runKeeper(
    ctx,
    keyHash,
    opts,
    {
      now: () => Date.now(),
      log,
      submit: async (built, job) => {
        await guard(lucid, { name: "open", tx: built.tx, intent: built.intent, record: {} });
        const hash = await (await built.tx.sign.withWallet().complete()).submit();
        log({ event: "submitted", job: describeJob(job), txHash: hash });
        console.log(
          `\n[${describeJob(job)}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
        );
        if (!(await lucid.awaitTx(hash, 5_000))) throw new Error(`${hash} not confirmed in time`);
        console.log("  confirmed.");
        if (!(await walletCaughtUp(lucid, built.tx.toCBOR())))
          throw new Error("the wallet view still lists inputs this transaction spent");
        return hash;
      },
    },
    MAX_JOBS,
  );
  console.log(
    `\n${r.done.length} job(s) done.` +
      (r.stopped
        ? ` Stopped: ${r.stopped}`
        : r.plan.jobs.length
          ? ` ${r.plan.jobs.length} left for the next pass.`
          : " Nothing left to do now."),
  );
  for (const n of r.plan.notes)
    if (n.level !== "info") console.log(`${n.level.toUpperCase().padEnd(15)}${n.text}`);
  log({
    event: "pass_done",
    jobs: r.done.map((d) => ({ job: describeJob(d.job), txHash: d.txHash })),
    stopped: r.stopped,
  });
}

async function main() {
  const env = await setup();
  if (!WATCH) return pass(env);
  console.log(`Watching: a pass every ${EVERY_MIN} minute(s). Ctrl+C to stop. Log: ${LOG}`);
  for (;;) {
    try {
      await pass(env);
    } catch (e) {
      console.error(`[fv2-keeper] pass failed: ${(e as Error).message}`);
      log({ event: "pass_failed", error: (e as Error).message });
    }
    await new Promise((r) => setTimeout(r, EVERY_MIN * 60_000));
  }
}

main().catch((e) => die((e as Error).message));
