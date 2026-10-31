/**
 * Pure helpers for the Tessera action screens (/stake, the keeper panel on
 * /tessera): parsing what people type, formatting 6-decimal amounts, quotes
 * from the live snapshot, and which of the viewer's Tickets and Requests are
 * ready. No Lucid, no I/O, so every rule is unit-tested.
 */
import type { TesseraLive } from "./tessera-live.shared";

export const DECIMALS = 6;
const ONE = 1_000_000n;
const DAY = 86_400_000;

/** "12.5" → 12_500_000n. Null for anything that isn't a plain positive amount. */
export function parseAmount(text: string): bigint | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const v = BigInt(whole!) * ONE + BigInt(frac.padEnd(DECIMALS, "0"));
  return v > 0n ? v : null;
}

/** 12_500_000n → "12.5"; thousands separated; up to `dp` decimals, trailing zeros dropped. */
export function formatUnits(units: bigint | string, dp = 6): string {
  const u = typeof units === "string" ? BigInt(units) : units;
  const neg = u < 0n;
  const a = neg ? -u : u;
  const whole = (a / ONE).toLocaleString("en-US");
  const frac = (a % ONE).toString().padStart(DECIMALS, "0").slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** sTSRA a stake of `amount` TSRA gets at the snapshot price (the builder re-quotes). */
export function quoteStake(amount: bigint, priceE6: string): bigint {
  const p = BigInt(priceE6);
  return p > 0n ? (amount * ONE) / p : 0n;
}

/** TSRA a Ticket for `shares` sTSRA would hold at the snapshot price. */
export function quoteUnstake(shares: bigint, priceE6: string): bigint {
  return (shares * BigInt(priceE6)) / ONE;
}

/** Largest instant swap possible now: the per-swap cap and the best shard's room and balance. */
export function instantRoom(live: TesseraLive, nowMs: number): bigint {
  const c = live.queue.config;
  if (c.suspendedUntil > nowMs) return 0n;
  const day = Math.floor(nowMs / DAY);
  const month = Math.floor(day / 30);
  const dailyCap = BigInt(c.dailyLimit) / BigInt(c.shards);
  const monthlyCap = BigInt(c.monthlyLimit) / BigInt(c.shards);
  let best = 0n;
  for (const s of live.queue.shards) {
    if (day < s.day || month < s.month) continue;
    const d = dailyCap - (s.day === day ? BigInt(s.paidDay) : 0n);
    const m = monthlyCap - (s.month === month ? BigInt(s.paidMonth) : 0n);
    const room = [d, m, BigInt(s.tusd)].reduce((a, b) => (b < a ? b : a));
    if (room > best) best = room;
  }
  const max = BigInt(c.instantMax);
  return best < max ? (best > 0n ? best : 0n) : max;
}

/** Minutes left before UTC midnight; Requests need 15 (the builder refuses below that). */
export function requestMinutesLeft(nowMs: number): number {
  return Math.floor((DAY - (nowMs % DAY)) / 60_000);
}
export const REQUEST_MIN_MINUTES = 15;

/** When a Request made now becomes payable (next UTC day + the settle delay). */
export function payableAfterIfNow(live: TesseraLive, nowMs: number): number {
  return (Math.floor(nowMs / DAY) + 1) * DAY + live.queue.config.settleDelayMs;
}

export type TicketView = TesseraLive["vault"]["tickets"][number] & { claimable: boolean };
export type RequestView = TesseraLive["queue"]["requests"][number] & { payable: boolean };

/** Tickets owned by `address`, with whether they can be claimed now (2 min margin). */
export function ticketsOf(live: TesseraLive, address: string | null, nowMs: number): TicketView[] {
  return live.vault.tickets
    .filter((t) => address !== null && t.owner === address)
    .map((t) => ({ ...t, claimable: t.claimAfter <= nowMs - 120_000 }))
    .sort((a, b) => a.claimAfter - b.claimAfter);
}

/** Requests whose owner key is `keyHash` (or all, for the keeper), with whether they're payable. */
export function requestsOf(
  live: TesseraLive,
  keyHash: string | null | "all",
  nowMs: number,
): RequestView[] {
  return live.queue.requests
    .filter((r) => keyHash === "all" || (keyHash !== null && r.owner === keyHash))
    .map((r) => ({ ...r, payable: r.payableAfter <= nowMs - 120_000 }))
    .sort((a, b) => a.payableAfter - b.payableAfter);
}

/** At most this many Requests per Settle from the browser (size and budget). */
export const SETTLE_BATCH = 5;

/** Short, honest status line for an amount check against a balance. */
export function amountProblem(
  amount: bigint | null,
  balance: bigint | null,
  min = 0n,
): string | null {
  if (amount === null) return "Enter an amount, e.g. 25 or 12.5.";
  if (amount < min) return `The minimum is ${formatUnits(min)}.`;
  if (balance !== null && amount > balance) return "That's more than your wallet holds.";
  return null;
}
