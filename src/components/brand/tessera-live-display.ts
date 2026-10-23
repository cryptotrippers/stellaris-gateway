export const LIVE_REFETCH_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Ratios remain integer arithmetic until conversion of the display percentage. */
export function ratioPercent(numerator: bigint, denominator: bigint): number | null {
  return denominator > 0n ? Number((numerator * 10_000n) / denominator) / 100 : null;
}

export function firstLossCapPercent(balance: string, minted: string): number | null {
  return ratioPercent(BigInt(balance) * 100n, BigInt(minted) * 3n);
}

export function shardDailyUsage(day: number, paidDay: string, dailyLimit: string, shards: number, now: number) {
  return {
    paid: day === Math.floor(now / DAY_MS) ? BigInt(paidDay) : 0n,
    cap: shards > 0 ? BigInt(dailyLimit) / BigInt(shards) : 0n,
  };
}

export function attestationState(freshUntil: number, now: number) {
  if (freshUntil <= now) return "expired";
  return freshUntil - now < DAY_MS ? "warning" : "fresh";
}

export function vestingPercent(from: number, until: number, now: number): number {
  if (until <= from) return now >= until ? 100 : 0;
  return Math.max(0, Math.min(100, ((now - from) / (until - from)) * 100));
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m ${seconds % 60}s`;
}