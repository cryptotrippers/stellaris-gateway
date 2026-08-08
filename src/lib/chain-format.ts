/**
 * Small formatting helpers for on-chain values. Pure and browser-safe.
 */

/** Truncate a hash for display. */
export function short(value: string, head = 8, tail = 6): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Relative time from a unix-ms timestamp. */
export function timeAgo(ms: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

const EXPLORER = "https://preprod.cardanoscan.io";

export function cardanoscanTx(hash: string): string {
  return `${EXPLORER}/transaction/${hash}`;
}

export function cardanoscanAddress(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

export function cardanoscanBlock(height: number | string): string {
  return `${EXPLORER}/block/${height}`;
}

/** Lovelace (as a string, to survive bigint precision) rendered as ADA. */
export function lovelaceToAda(lovelace: string | number | bigint, dp = 2): string {
  const n = Number(lovelace) / 1_000_000;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Share price with the six decimals the accounting actually carries. */
export function formatSharePrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return "—";
  return price.toFixed(6);
}
