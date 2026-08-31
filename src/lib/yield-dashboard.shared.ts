/**
 * Shapes for the public yield dashboard feed (`GET /api/v1/yield`).
 *
 * Every figure here is derived from the vault state UTxOs and their
 * transaction history. Where a figure has no on-chain or published source
 * (reserve composition, redemption queue), the feed returns `null` plus a
 * plain-language reason so the UI can say "not published" instead of
 * inventing a number.
 */

export interface YieldFeedVault {
  assetId: string;
  address: string;
  network: string;
  /** Total assets accounted by the vault state datum, in lovelace. */
  totalAssetsLovelace: string;
  totalShares: string;
  sharePrice: number | null;
  epoch: number | null;
  apyPct: number | null;
  accrualCount: number;
  /** Lovelace accrued in the trailing 7 days across observed accruals. */
  weeklyYieldLovelace: string;
  /** Lovelace accrued in the trailing 24 hours. */
  dailyYieldLovelace: string;
  lastAccrualBlockTime: number | null;
}

export interface ReserveSlice {
  label: string;
  /** Share of reserves, 0-100. */
  pct: number;
  amountLovelace: string;
}

export interface RedemptionStatus {
  /** Depositor queue length, when the vault operates a queue. */
  queueLength: number | null;
  /** The connected wallet's place in the queue, 1-based. */
  queuePosition: number | null;
  /** Days until the wallet's withdrawal unlocks (cap 7). */
  daysUntilAvailable: number | null;
  /** Why the above are null, when they are. */
  unavailableReason: string | null;
}

export interface YieldFeed {
  network: string;
  /** Server time the feed was assembled, unix ms. */
  checkedAt: number;
  /** Sum of every bootstrapped vault's accounted assets, in lovelace. */
  tvlLovelace: string;
  /** Change in accounted assets over the trailing 24h, in percent. */
  tvlChange24hPct: number | null;
  /** Share-weighted realised APY across vaults with enough history. */
  apyPct: number | null;
  weeklyYieldLovelace: string;
  vaults: YieldFeedVault[];
  /** Published reserve breakdown, or null when no attestation is wired. */
  reserves: ReserveSlice[] | null;
  reservesUnavailableReason: string | null;
  redemption: RedemptionStatus;
}

const DAY_SECONDS = 24 * 60 * 60;

/** Sum accrual lovelace inside a trailing window ending now. */
export function sumAccrualsSince(
  accruals: Array<{ blockTime: number; amountLovelace: string }>,
  sinceUnixSeconds: number,
): bigint {
  return accruals
    .filter((a) => a.blockTime >= sinceUnixSeconds)
    .reduce((total, a) => total + BigInt(a.amountLovelace), 0n);
}

export function trailingWindowStart(nowMs: number, days: number): number {
  return Math.floor(nowMs / 1000) - days * DAY_SECONDS;
}

/**
 * Percentage growth of accounted assets over the trailing 24h, computed from
 * the assets that actually accrued in that window. Null when nothing accrued —
 * a flat vault has no honest "change since yesterday" to report.
 */
export function change24hPct(tvlLovelace: bigint, dailyLovelace: bigint): number | null {
  if (dailyLovelace === 0n) return null;
  const before = tvlLovelace - dailyLovelace;
  if (before <= 0n) return null;
  return (Number(dailyLovelace) / Number(before)) * 100;
}

/** Share-weighted APY across the vaults that have enough history to quote one. */
export function weightedApy(
  vaults: Array<{ apyPct: number | null; totalAssetsLovelace: string }>,
): number | null {
  let weight = 0;
  let acc = 0;
  for (const v of vaults) {
    if (v.apyPct === null || !Number.isFinite(v.apyPct)) continue;
    const w = Number(v.totalAssetsLovelace);
    if (!(w > 0)) continue;
    weight += w;
    acc += v.apyPct * w;
  }
  return weight > 0 ? acc / weight : null;
}
