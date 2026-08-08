/**
 * Management-fee arithmetic, mirroring `contracts/vault/lib/stellaris/shares.ak`
 * exactly. The validator re-derives every number here on chain; this module is
 * for previews, transaction building and honest UI disclosure.
 *
 * Model: the fee is an annual rate in basis points charged on accounted
 * assets, prorated by wall-clock time and settled by MINTING shares to the
 * treasury. No lovelace leaves the vault when the fee is charged — holders are
 * diluted by exactly the fee, and the treasury cashes out later.
 *
 * Pure and browser-safe.
 */

/** Milliseconds in the protocol's 365-day fee year. */
export const MS_PER_YEAR = 31_536_000_000n;

/** Hard on-chain cap on the annual management fee: 5.00%/yr. */
export const MAX_FEE_BPS = 500;

export function feeBpsOk(feeBps: number): boolean {
  return Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= MAX_FEE_BPS;
}

/** Lovelace of fee owed for `elapsedMs`, floored, clamped below total assets. */
export function feeAssetsFor(
  acc: { totalShares: bigint; totalAssets: bigint },
  feeBps: number,
  elapsedMs: bigint,
): bigint {
  if (elapsedMs <= 0n || feeBps <= 0 || acc.totalAssets <= 0n || acc.totalShares <= 0n) return 0n;
  const raw = (acc.totalAssets * BigInt(feeBps) * elapsedMs) / (10_000n * MS_PER_YEAR);
  return raw >= acc.totalAssets ? acc.totalAssets - 1n : raw;
}

/** Shares minted to the treasury so its redeemable value equals `feeAssets`. */
export function feeSharesFor(
  acc: { totalShares: bigint; totalAssets: bigint },
  feeAssets: bigint,
): bigint {
  if (feeAssets <= 0n || acc.totalShares <= 0n || acc.totalAssets <= feeAssets) return 0n;
  return (feeAssets * acc.totalShares) / (acc.totalAssets - feeAssets);
}

export interface FeeSettlement {
  elapsedMs: bigint;
  feeAssets: bigint;
  feeShares: bigint;
  /** Share supply after the fee mint. */
  totalSharesAfter: bigint;
  /** Treasury's unclaimed fee shares after the mint. */
  treasurySharesAfter: bigint;
}

/**
 * Settle the fee owed by a vault state at time `nowMs` (POSIX milliseconds).
 * `nowMs` must be the transaction's validity lower bound — the validator
 * anchors proration to exactly that value.
 */
export function settleFee(
  state: {
    totalShares: string;
    totalAssets: string;
    feeBps: number;
    treasuryShares: string;
    lastFeeTime: string;
  },
  nowMs: bigint,
): FeeSettlement {
  const acc = { totalShares: BigInt(state.totalShares), totalAssets: BigInt(state.totalAssets) };
  const elapsedMs = nowMs - BigInt(state.lastFeeTime);
  const feeAssets = feeAssetsFor(acc, state.feeBps, elapsedMs);
  const feeShares = feeSharesFor(acc, feeAssets);
  return {
    elapsedMs,
    feeAssets,
    feeShares,
    totalSharesAfter: acc.totalShares + feeShares,
    treasurySharesAfter: BigInt(state.treasuryShares) + feeShares,
  };
}

/** Gross price = assets/shares. Net price is what a holder gets after the fee owed today. */
export function grossSharePrice(state: { totalAssets: string; totalShares: string }): number {
  const shares = Number(state.totalShares);
  if (!Number.isFinite(shares) || shares <= 0) return 1;
  return Number(state.totalAssets) / shares;
}

export function netSharePrice(
  state: {
    totalShares: string;
    totalAssets: string;
    feeBps: number;
    treasuryShares: string;
    lastFeeTime: string;
  },
  nowMs: bigint,
): number {
  const settled = settleFee(state, nowMs);
  const shares = Number(settled.totalSharesAfter);
  if (!Number.isFinite(shares) || shares <= 0) return 1;
  return Number(state.totalAssets) / shares;
}

/** Shares a depositor owns, i.e. total supply minus the treasury's unclaimed fee. */
export function depositorShares(state: { totalShares: string; treasuryShares: string }): bigint {
  return BigInt(state.totalShares) - BigInt(state.treasuryShares);
}

export function formatFeeBps(feeBps: number): string {
  return `${(feeBps / 100).toFixed(2)}% / yr`;
}
