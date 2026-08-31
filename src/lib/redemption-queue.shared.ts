/**
 * Shapes for the per-wallet redemption queue feed
 * (`GET /api/v1/yield/user/:address/queue`).
 *
 * The vault currently settles withdrawals directly on chain, so no queue
 * exists yet — the feed returns `entries: []` with a plain-language reason
 * instead of fabricated positions. When a queued redemption mechanism is
 * deployed, entries are decoded from chain state and carry only sourced
 * figures.
 */

export type RedemptionEntryStatus = "processing" | "ready" | "completed" | "cancelled";

export interface RedemptionEntry {
  id: string;
  status: RedemptionEntryStatus;
  /** 1-based position in the queue (processing entries only). */
  queuePosition: number | null;
  /** Total entries in the queue at read time. */
  queueLength: number | null;
  /** Unix ms when the request entered the queue. */
  requestedAt: number;
  /** Unix ms when funds become available (cap: requestedAt + 7 days). */
  availableAt: number | null;
  /** Amount requested, in lovelace. */
  amountLovelace: string;
  /** Redemption fee in basis points (e.g. 25 = 0.25%). */
  feeBps: number | null;
  /** Fee amount, in lovelace. */
  feeLovelace: string | null;
  /** Net amount the wallet receives, in lovelace. */
  netLovelace: string | null;
  /** Settling tx hash, for completed entries. */
  txHash: string | null;
}

export interface RedemptionQueueFeed {
  network: string;
  address: string;
  /** Server time the feed was assembled, unix ms. */
  checkedAt: number;
  /** Queue window in days (protocol cap: 7). */
  windowDays: number;
  entries: RedemptionEntry[];
  /** Why the list is empty, when it is. */
  unavailableReason: string | null;
}

export const REDEMPTION_WINDOW_DAYS = 7;
export const REDEMPTION_WINDOW_MS = REDEMPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Fee in lovelace for a given amount and bps; null when either side is missing. */
export function redemptionFeeLovelace(amountLovelace: string, feeBps: number | null): string | null {
  if (feeBps === null) return null;
  return ((BigInt(amountLovelace) * BigInt(feeBps)) / 10_000n).toString();
}

/** Net receive = amount - fee; null when the fee is unknown. */
export function redemptionNetLovelace(amountLovelace: string, feeLovelace: string | null): string | null {
  if (feeLovelace === null) return null;
  return (BigInt(amountLovelace) - BigInt(feeLovelace)).toString();
}

/** Day index (1-based) within the 7-day window at `nowMs`. */
export function queueDayIndex(entry: RedemptionEntry, nowMs: number): number {
  if (entry.availableAt === null) return 1;
  const elapsed = nowMs - entry.requestedAt;
  const day = Math.floor(elapsed / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, Math.min(REDEMPTION_WINDOW_DAYS, day));
}
