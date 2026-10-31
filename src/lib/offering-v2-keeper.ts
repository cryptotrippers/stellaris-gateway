/**
 * fraction_vault v2 keeper (SPEC-v2 §2, §5, §11.4).
 *
 * The keeper is the off-chain job that keeps an offering moving without the
 * committee: it settles marked pledges in batches while the raise is open,
 * fails a raise that missed its soft cap once the settle window is over (anyone
 * may), and returns pledges that can no longer be settled to their owners
 * (anyone may). It never signs a committee action; when one is due it says so.
 *
 * Two halves:
 *   - `planKeeper` is pure: from one snapshot of the chain (the State, the
 *     pledges, the time) it lists every job that is legal now, in the order to
 *     run them, plus notes for the operator. No I/O, so every rule is unit-tested.
 *   - `buildKeeperJob` turns one job into an unsigned transaction and its S1
 *     intent through the E07 builders. The caller signs, submits, waits until
 *     the chain shows the result, then plans again from a fresh snapshot.
 *
 * Running one job per snapshot keeps the keeper idempotent: a crash, a rival
 * keeper or a rollback only means the next plan starts from what is on chain.
 */
import { KEEPER_BATCH, type V2State } from "./offering-v2-chain";
import {
  VALIDITY_SLACK_MS,
  buildAction,
  buildRefundPledges,
  buildSettle,
  findPledges,
  findState,
  type Built,
  type LivePledge,
  type V2Context,
} from "./offering-v2-tx";
import type { UTxO } from "@lucid-evolution/lucid";

/**
 * Pledges returned per refund transaction. Each refunded pledge runs the pledge
 * script once, and each run searches the reference inputs for the State;
 * measured on the emulator with reference scripts (tests/contracts/
 * fv2-keeper.test.ts), this batch leaves at least 20% headroom under the
 * per-transaction memory, CPU and size limits.
 */
export const KEEPER_REFUND_BATCH = 15;

/**
 * Settle only while at least this long is left before deadline + settle
 * window. A Settle must be valid entirely before that moment, and a
 * transaction can wait in the mempool for a while.
 */
export const SETTLE_MARGIN_MS = 10 * 60_000;

/**
 * After deadline + settle window, a FailRaise or a refund of a marked pledge
 * while `Raising` is legal only once the transaction's validity START is past
 * that moment, and the builders start validity VALIDITY_SLACK_MS before now
 * (rounded down to a slot). Wait this long past it.
 */
export const AFTER_WINDOW_MS = VALIDITY_SLACK_MS + 60_000;

export type KeeperJob =
  | { kind: "failRaise" }
  | { kind: "settle"; pledges: LivePledge[]; fractions: bigint }
  | {
      kind: "refund";
      pledges: LivePledge[];
      /** "unsettleable": marked pledges the raise can no longer take. "stray": unmarked UTxOs. */
      reason: "unsettleable" | "stray";
    };

export interface KeeperNote {
  /** "action": something a person (usually the committee) must do. */
  level: "info" | "action" | "warn";
  text: string;
}

export interface KeeperPlan {
  jobs: KeeperJob[];
  notes: KeeperNote[];
  /** Deadline + settle window, POSIX ms. */
  windowEnd: bigint;
}

export interface KeeperOptions {
  /** Pledges per Settle; never above KEEPER_BATCH. */
  settleBatch?: number;
  /** Pledges per refund; never above KEEPER_REFUND_BATCH. */
  refundBatch?: number;
  /** The wallet running the keeper holds the offering's keeper key. */
  isKeeper: boolean;
  /**
   * Return unmarked UTxOs at the pledge address that name this offering. Off by
   * default: anyone can create them, so paying fees to return them is opt-in.
   */
  returnStrays?: boolean;
  /**
   * Offerings with an eligibility policy: the reference UTxO holding the
   * owner's eligibility token, or null if the owner is not eligible. Without
   * it the keeper does not settle such an offering.
   */
  eligibility?: (ownerKeyHash: string) => UTxO | null;
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const byArrival = (a: LivePledge, b: LivePledge) =>
  a.pledge.created !== b.pledge.created
    ? a.pledge.created < b.pledge.created
      ? -1
      : 1
    : a.utxo.txHash !== b.utxo.txHash
      ? a.utxo.txHash < b.utxo.txHash
        ? -1
        : 1
      : a.utxo.outputIndex - b.utxo.outputIndex;

/** Every job legal now, in the order to run them, and notes for the operator. */
export function planKeeper(
  state: V2State,
  pledges: LivePledge[],
  nowMs: number,
  opts: KeeperOptions,
): KeeperPlan {
  const settleBatch = Math.min(opts.settleBatch ?? KEEPER_BATCH, KEEPER_BATCH);
  const refundBatch = Math.min(opts.refundBatch ?? KEEPER_REFUND_BATCH, KEEPER_REFUND_BATCH);
  if (settleBatch < 1 || refundBatch < 1) throw new Error("Batch sizes must be at least 1.");

  const t = state.terms;
  const b = state.book;
  const now = BigInt(nowMs);
  const windowEnd = t.deadline + t.settleWindow;
  const jobs: KeeperJob[] = [];
  const notes: KeeperNote[] = [];
  const marked = pledges.filter((p) => p.marked).sort(byArrival);
  const strays = pledges.filter((p) => !p.marked).sort(byArrival);
  const raising = state.status === "raising";
  const windowOver = now > windowEnd + BigInt(AFTER_WINDOW_MS);

  if (raising && !windowOver && now + BigInt(SETTLE_MARGIN_MS) < windowEnd) {
    // ---- Settle, first come first served, up to the hard cap. -------------
    let room = t.totalFractions - b.settled;
    const take: LivePledge[] = [];
    let tooBig = 0;
    let ineligible = 0;
    const needsEligibility = t.eligibilityPolicy !== null;
    if (needsEligibility && !opts.eligibility) {
      notes.push({
        level: "warn",
        text: "This offering checks eligibility and no eligibility source is configured; the keeper will not settle it.",
      });
    } else {
      for (const p of marked) {
        if (needsEligibility && opts.eligibility!(p.pledge.owner.payment.hash) === null) {
          ineligible++;
          continue;
        }
        if (p.pledge.qty > room) {
          tooBig++;
          continue;
        }
        take.push(p);
        room -= p.pledge.qty;
      }
    }
    if (tooBig)
      notes.push({
        level: "info",
        text: `${tooBig} pledge(s) do not fit the ${t.totalFractions - b.settled} fractions left; they stay with their owners' deposits until refunded.`,
      });
    if (ineligible)
      notes.push({
        level: "warn",
        text: `${ineligible} pledge(s) have owners without an eligibility token; not settled.`,
      });
    if (take.length && !opts.isKeeper) {
      notes.push({
        level: "warn",
        text: `${take.length} pledge(s) are ready to settle, but this wallet is not the offering's keeper (${t.keeper}).`,
      });
    } else {
      for (const ps of chunk(take, settleBatch))
        jobs.push({
          kind: "settle",
          pledges: ps,
          fractions: ps.reduce((a, p) => a + p.pledge.qty, 0n),
        });
    }
    const settledAfter = b.settled + take.reduce((a, p) => a + p.pledge.qty, 0n);
    if (now > t.deadline && settledAfter >= t.softCap)
      notes.push({
        level: "action",
        text: `The deadline has passed and the soft cap (${t.softCap}) is met: the committee can CloseRaise.`,
      });
    if (now > t.deadline && settledAfter < t.softCap)
      notes.push({
        level: "info",
        text: `The deadline has passed below the soft cap (${settledAfter} of ${t.softCap}); the raise can be failed after ${new Date(Number(windowEnd)).toISOString()}.`,
      });
  } else if (raising && !windowOver) {
    notes.push({
      level: "info",
      text: `Too close to the end of the settle window to settle safely; the keeper waits until ${new Date(Number(windowEnd) + AFTER_WINDOW_MS).toISOString()}.`,
    });
  }

  if (raising && windowOver) {
    if (b.settled < t.softCap) {
      // ---- Fail the raise; the refunds follow on the next plan. ---------------
      jobs.push({ kind: "failRaise" });
    } else {
      notes.push({
        level: "action",
        text: "The settle window is over with the soft cap met, and the raise is still open: the committee should CloseRaise.",
      });
      for (const ps of chunk(marked, refundBatch))
        jobs.push({ kind: "refund", pledges: ps, reason: "unsettleable" });
    }
  } else if (!raising) {
    for (const ps of chunk(marked, refundBatch))
      jobs.push({ kind: "refund", pledges: ps, reason: "unsettleable" });
    if (state.status === "refunding" && b.outstanding > 0n)
      notes.push({
        level: "info",
        text: `${b.outstanding} fraction(s) are outstanding; holders get ${t.price} units each back with RefundFraction (their own action).`,
      });
  }

  if (strays.length) {
    if (opts.returnStrays) {
      for (const ps of chunk(strays, refundBatch))
        jobs.push({ kind: "refund", pledges: ps, reason: "stray" });
    } else {
      notes.push({
        level: "info",
        text: `${strays.length} unmarked UTxO(s) at the pledge address name this offering. They are not pledges; return them with --return-strays.`,
      });
    }
  }

  if (jobs.length === 0 && notes.length === 0)
    notes.push({ level: "info", text: `Nothing to do (${state.status}).` });
  return { jobs, notes, windowEnd };
}

/** Build one job as the selected wallet. `keeperKey` signs a Settle. */
export async function buildKeeperJob(
  ctx: V2Context,
  job: KeeperJob,
  keeperKey: string,
  nowMs: number,
  eligibility?: KeeperOptions["eligibility"],
): Promise<Built> {
  switch (job.kind) {
    case "settle": {
      const refs = eligibility
        ? job.pledges
            .map((p) => eligibility(p.pledge.owner.payment.hash))
            .filter((u): u is UTxO => !!u)
        : [];
      return buildSettle(ctx, job.pledges, [keeperKey], nowMs, refs);
    }
    case "failRaise":
      return buildAction(ctx, { kind: "failRaise" }, { nowMs });
    case "refund":
      return buildRefundPledges(ctx, job.pledges, nowMs);
  }
}

export interface KeeperDeps {
  now: () => number;
  /** Check (S1 guard), sign, submit and wait for confirmation; returns the tx hash. */
  submit: (built: Built, job: KeeperJob) => Promise<string>;
  /** Wait until the chain view shows the job's result; defaults to keeperCaughtUp. */
  caughtUp?: (job: KeeperJob, txHash: string) => Promise<boolean>;
  log?: (event: Record<string, unknown>) => void;
}

export interface KeeperRun {
  done: { job: KeeperJob; txHash: string }[];
  /** The plan from the last snapshot (empty jobs = nothing left to do now). */
  plan: KeeperPlan;
  /** Why the run stopped early, if it did. */
  stopped?: string;
}

/**
 * Run jobs one at a time, re-reading the chain and re-planning before each,
 * until nothing is left to do or `maxJobs` have run.
 */
export async function runKeeper(
  ctx: V2Context,
  keeperKey: string,
  opts: KeeperOptions,
  deps: KeeperDeps,
  maxJobs = 20,
): Promise<KeeperRun> {
  const done: KeeperRun["done"] = [];
  const caughtUp = deps.caughtUp ?? ((job, h) => keeperCaughtUp(ctx, job, h));
  for (;;) {
    const { state } = await findState(ctx);
    const plan = planKeeper(state, await findPledges(ctx), deps.now(), opts);
    if (plan.jobs.length === 0 || done.length >= maxJobs) return { done, plan };
    const job = plan.jobs[0]!;
    let built: Built;
    try {
      built = await buildKeeperJob(ctx, job, keeperKey, deps.now(), opts.eligibility);
    } catch (e) {
      deps.log?.({ event: "build_failed", job: describeJob(job), error: (e as Error).message });
      return {
        done,
        plan,
        stopped: `Could not build "${describeJob(job)}": ${(e as Error).message}`,
      };
    }
    let txHash: string;
    try {
      txHash = await deps.submit(built, job);
    } catch (e) {
      // A rival (the committee, another keeper, an owner cancelling) spent an
      // input first, the guard refused, or the node did. The next run plans
      // again from the chain.
      deps.log?.({ event: "submit_failed", job: describeJob(job), error: (e as Error).message });
      return {
        done,
        plan,
        stopped: `"${describeJob(job)}" was not accepted: ${(e as Error).message}`,
      };
    }
    deps.log?.({ event: "confirmed", job: describeJob(job), txHash });
    done.push({ job, txHash });
    if (!(await caughtUp(job, txHash)))
      return {
        done,
        plan,
        stopped: `The chain view has not caught up with ${txHash} yet; run again shortly.`,
      };
  }
}

/** One line describing a job, for logs and the console. */
export function describeJob(job: KeeperJob): string {
  switch (job.kind) {
    case "settle":
      return `settle ${job.pledges.length} pledge(s), ${job.fractions} fraction(s)`;
    case "failRaise":
      return "fail the raise (soft cap missed, settle window over)";
    case "refund":
      return `return ${job.pledges.length} ${job.reason === "stray" ? "unmarked UTxO(s)" : "pledge(s)"} to their owners`;
  }
}

/** The UTxOs a job spends that are not the State (for the caught-up check). */
export function jobPledgeRefs(job: KeeperJob): string[] {
  return job.kind === "failRaise"
    ? []
    : job.pledges.map((p) => `${p.utxo.txHash}#${p.utxo.outputIndex}`);
}

/**
 * Has the chain view caught up with a confirmed job? Blockfrost reports a
 * transaction before its script-address index moves (seen on Preprod, 30 Oct),
 * so planning right after can see the old State or pledges that are already
 * spent. True once none of the job's pledges are listed and, for a job that
 * spends the State, the State comes from `txHash`. Read errors count as "not yet".
 */
export async function keeperCaughtUp(
  ctx: V2Context,
  job: KeeperJob,
  txHash: string,
  attempts = 30,
  waitMs = 4_000,
): Promise<boolean> {
  const gone = new Set(jobPledgeRefs(job));
  const spendsState = job.kind !== "refund";
  for (let i = 0; i < attempts; i++) {
    try {
      const ps = await findPledges(ctx);
      const pledgesGone = !ps.some((p) => gone.has(`${p.utxo.txHash}#${p.utxo.outputIndex}`));
      const stateMoved = !spendsState || (await findState(ctx)).utxo.txHash === txHash;
      if (pledgesGone && stateMoved) return true;
    } catch {
      // The index can be mid-update; try again.
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}
