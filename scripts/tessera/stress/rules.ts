/**
 * Pure queue rules for the 2.8 stress model. Each function mirrors the Aiken
 * function of the same name in contracts/tessera/lib/tessera/queue_state.ak (and
 * the constants in rules.ak / SPEC.md §4.13), so the unit tests can replay the
 * Aiken test vectors. No state, no randomness, no I/O.
 *
 * Amounts are integers in 1e-6 units (1 TSRA = 1_000_000), times are POSIX ms,
 * exactly as on chain. Division is integer division (all values are >= 0).
 */

export const TSRA = 1_000_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// -- constants (queue_state.ak) -------------------------------------------------
export const MONTH_DAYS = 30;
export const MAX_SETTLE_DELAY_MS = 604_800_000; // 7 days, hard
export const MAX_SUSPEND_MS = 259_200_000; // 3 days
export const SUSPEND_REOPEN_GAP_MS = 604_800_000; // 7 days
export const SHORT_OVERDUE_MS = DAY_MS; // probe Request must be 24 h past payable_after
export const SHORT_WINDOW_MS = DAY_MS; // registration window, no payments
export const SHORT_REENTRY_MS = DAY_MS; // gap after an exit
export const MIN_DAILY_LIMIT = 10_000 * TSRA;
export const FLOOR_DIV = 100;
export const MAX_SHARDS = 8;
// -- constants (rules.ak) -------------------------------------------------------
export const MAX_LOSS_PENDING_MS = 604_800_000; // one freeze lasts at most 7 days
export const LOSS_REOPEN_GAP_MS = 604_800_000; // a new freeze only 7 days after the last
export const MAX_ATTEST_WINDOW_MS = DAY_MS;
// -- batch caps (SPEC.md §4.13, measured in 2.6) --------------------------------
export const SETTLE_CAP = 20;
export const SWEEP_CAP = 20;
export const PAYSHORT_CAP = 16;
export const REGISTER_CAP = 12;
export const VETO_CAP = 30;
/** Average Cardano block interval; one transaction per shard (or per ShortState) per block. */
export const BLOCK_MS = 20_000;

const idiv = (a: number, b: number) => Math.floor(a / b);

/** Day index of a POSIX time. */
export const dayOf = (t: number) => idiv(t, DAY_MS);
/** Month (30-day block) index of a day index. */
export const monthOf = (day: number) => idiv(day, MONTH_DAYS);
/** A Request's payable_after, fixed when it is created. */
export const payableAfterOf = (bucket: number, settleDelay: number) =>
  (bucket + 1) * DAY_MS + settleDelay;
/** floor = max(min_daily_limit, minted_supply / 100) (D-34). */
export const limitFloor = (minted: number) => Math.max(MIN_DAILY_LIMIT, idiv(minted, FLOOR_DIV));
/** Both limits at or above the floor, monthly never below daily. */
export const limitsOk = (daily: number, monthly: number, floor: number) =>
  daily >= floor && monthly >= daily;

export interface ShardState {
  day: number;
  paidDay: number;
  month: number;
  paidMonth: number;
}

/**
 * A payment of `qty` fits a shard on `day`: counters reset when the window index
 * moved, never go backwards, and the caps (global limit / shards) hold.
 */
export function shardAfter(
  s: ShardState,
  day: number,
  qty: number,
  dailyCap: number,
  monthlyCap: number,
): ShardState | null {
  const month = monthOf(day);
  if (day >= s.day && month >= s.month) {
    const pd = (day === s.day ? s.paidDay : 0) + qty;
    const pm = (month === s.month ? s.paidMonth : 0) + qty;
    if (pd <= dailyCap && pm <= monthlyCap) return { day, paidDay: pd, month, paidMonth: pm };
  }
  return null;
}

export interface Tally {
  day: number;
  open: number;
}

/** Add qty to the tally of `day`, keeping the list sorted by day. */
export function tallyAdd(ts: Tally[], day: number, qty: number): Tally[] {
  const out: Tally[] = [];
  let placed = false;
  for (const t of ts) {
    if (!placed && day === t.day) {
      out.push({ day, open: t.open + qty });
      placed = true;
    } else if (!placed && day < t.day) {
      out.push({ day, open: qty }, t);
      placed = true;
    } else out.push(t);
  }
  if (!placed) out.push({ day, open: qty });
  return out;
}

/** Take qty off the tally of `day`; null if the day is absent or holds less. */
export function tallySub(ts: Tally[], day: number, qty: number): Tally[] | null {
  const i = ts.findIndex((t) => t.day === day);
  if (i < 0) return null;
  const t = ts[i]!;
  if (t.open < qty) return null;
  const rest = ts.filter((_, j) => j !== i);
  if (t.open === qty) return rest;
  return [...ts.slice(0, i), { day, open: t.open - qty }, ...ts.slice(i + 1)];
}

/** Strictly increasing by day, positive amounts. */
export const talliesSorted = (ts: Tally[]) =>
  ts.every((t, i) => t.open > 0 && (i === 0 || ts[i - 1]!.day < t.day));
export const headDay = (ts: Tally[]) => (ts.length ? ts[0]!.day : null);

/** can_suspend (queue_state.ak): a finite window of at most a day, spaced, at most 3 days long. */
export const canSuspend = (lo: number, hi: number, until: number, previousUntil: number) =>
  hi >= lo &&
  hi - lo <= DAY_MS &&
  lo >= previousUntil + SUSPEND_REOPEN_GAP_MS &&
  hi < until &&
  until <= lo + MAX_SUSPEND_MS;
export const suspended = (until: number, lo: number) => until > lo;

/** rules.ak: a freeze may open. */
export const canOpenFreeze = (lo: number, hi: number, until: number, previousUntil: number) =>
  hi >= lo &&
  hi - lo <= MAX_ATTEST_WINDOW_MS &&
  lo >= previousUntil + LOSS_REOPEN_GAP_MS &&
  hi < until &&
  until <= lo + MAX_LOSS_PENDING_MS;
export const frozen = (until: number, lo: number) => until > lo;

/** Per-shard caps from the global limits (QueueConfig.daily_limit / shards). */
export const shardCap = (limit: number, shards: number) => idiv(limit, shards);
