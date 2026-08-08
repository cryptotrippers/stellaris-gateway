/**
 * Pure decoding + accounting helpers for the Stage 4 yield vault.
 *
 * Kept separate from `yield-chain.functions.ts` because server-function modules
 * must contain nothing but imports, types, and the server-function declarations
 * themselves — the build strips handler bodies and would delete any runtime
 * sibling declared alongside them.
 *
 * Everything here is pure and browser-safe: no secrets, no network, no env.
 */

import { decodePlutusDatum, asInt, asBytes, asList, asBool, type PlutusData } from "./plutus-cbor";

export interface BfAmount {
  unit: string;
  quantity: string;
}

export interface BfUtxo {
  tx_hash: string;
  output_index: number;
  amount: BfAmount[];
  inline_datum: string | null;
  data_hash: string | null;
}

export interface BfAddressTx {
  tx_hash: string;
  tx_index: number;
  block_height: number;
  block_time: number;
}

export interface BfTxUtxos {
  hash: string;
  inputs: Array<{ address: string; inline_datum: string | null }>;
  outputs: Array<{
    address: string;
    amount: BfAmount[];
    inline_datum: string | null;
    output_index: number;
  }>;
}

// ---------------------------------------------------------------------------
// YieldDatum — mirrors contracts/vault/validators/yield_vault.ak
//   Position { owner, shares }                                 -> constructor 0
//   State { total_shares, total_assets, epoch, operators,
//           threshold, paused, fee_bps, treasury,
//           treasury_shares, last_fee_time }                   -> constructor 1
// ---------------------------------------------------------------------------

export interface VaultStateDatum {
  totalShares: string;
  totalAssets: string;
  epoch: number;
  operators: string[];
  threshold: number;
  paused: boolean;
  /** Annual management fee in basis points, charged on accounted assets. */
  feeBps: number;
  /** Treasury payment key hash entitled to claim fee shares. */
  treasury: string;
  /** Unclaimed fee shares held by the treasury. */
  treasuryShares: string;
  /** POSIX milliseconds the fee was last settled to. */
  lastFeeTime: string;
}

export interface VaultPositionDatum {
  owner: string;
  shares: string;
}

export function lovelaceOf(utxo: { amount: BfAmount[] }): bigint {
  const entry = utxo.amount.find((a) => a.unit === "lovelace");
  return entry ? BigInt(entry.quantity) : 0n;
}

export function decodeState(d: PlutusData): VaultStateDatum | null {
  if (d.kind !== "constr" || d.index !== 1 || d.fields.length !== 10) return null;
  return {
    totalShares: asInt(d.fields[0]).toString(),
    totalAssets: asInt(d.fields[1]).toString(),
    epoch: Number(asInt(d.fields[2])),
    operators: asList(d.fields[3]).map((o) => asBytes(o)),
    threshold: Number(asInt(d.fields[4])),
    paused: asBool(d.fields[5]),
    feeBps: Number(asInt(d.fields[6])),
    treasury: asBytes(d.fields[7]),
    treasuryShares: asInt(d.fields[8]).toString(),
    lastFeeTime: asInt(d.fields[9]).toString(),
  };
}

export function decodePosition(d: PlutusData): VaultPositionDatum | null {
  if (d.kind !== "constr" || d.index !== 0 || d.fields.length !== 2) return null;
  return { owner: asBytes(d.fields[0]), shares: asInt(d.fields[1]).toString() };
}


/** Safely read a State datum from an inline datum hex string. */
export function readStateDatum(datumHex: string | null): VaultStateDatum | null {
  if (!datumHex) return null;
  try {
    return decodeState(decodePlutusDatum(datumHex));
  } catch {
    return null;
  }
}

/** Safely read a Position datum from an inline datum hex string. */
export function readPositionDatum(datumHex: string | null): VaultPositionDatum | null {
  if (!datumHex) return null;
  try {
    return decodePosition(decodePlutusDatum(datumHex));
  } catch {
    return null;
  }
}

/** Share price = total_assets / total_shares; exactly 1.0 before any deposit. */
export function sharePriceOf(state: { totalAssets: string; totalShares: string }): number {
  const shares = Number(state.totalShares);
  if (!Number.isFinite(shares) || shares <= 0) return 1;
  return Number(state.totalAssets) / shares;
}

// ---------------------------------------------------------------------------
// Shapes returned to the UI
// ---------------------------------------------------------------------------

export interface VaultChainState {
  address: string;
  found: boolean;
  state: VaultStateDatum | null;
  sharePrice: number | null;
  stateUtxo: { txHash: string; outputIndex: number; lovelace: string } | null;
  positions: Array<VaultPositionDatum & { txHash: string; outputIndex: number; lovelace: string }>;
  lockedLovelace: string;
  checkedAt: number;
}

export interface ChainAccrual {
  txHash: string;
  epoch: number;
  blockHeight: number;
  blockTime: number;
  amountLovelace: string;
  totalAssetsAfter: string;
  totalSharesAfter: string;
  sharePriceBefore: number;
  sharePriceAfter: number;
}

export interface VaultHistory {
  address: string;
  accruals: ChainAccrual[];
  bootstrapTxHash: string | null;
  apyPct: number | null;
  scanned: number;
  truncated: boolean;
  checkedAt: number;
}

/** Derive accrual events from an ordered series of observed vault states. */
export function deriveAccruals(
  points: Array<{ tx: BfAddressTx; state: VaultStateDatum }>,
): ChainAccrual[] {
  const sorted = [...points].sort(
    (a, b) => a.state.epoch - b.state.epoch || a.tx.block_height - b.tx.block_height,
  );
  const accruals: ChainAccrual[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const assetsDelta = BigInt(curr.state.totalAssets) - BigInt(prev.state.totalAssets);
    if (
      curr.state.totalShares !== prev.state.totalShares ||
      curr.state.epoch <= prev.state.epoch ||
      assetsDelta <= 0n
    ) {
      continue;
    }
    accruals.push({
      txHash: curr.tx.tx_hash,
      epoch: curr.state.epoch,
      blockHeight: curr.tx.block_height,
      blockTime: curr.tx.block_time,
      amountLovelace: assetsDelta.toString(),
      totalAssetsAfter: curr.state.totalAssets,
      totalSharesAfter: curr.state.totalShares,
      sharePriceBefore: sharePriceOf(prev.state),
      sharePriceAfter: sharePriceOf(curr.state),
    });
  }
  return accruals;
}

/**
 * Annualised return between the first and last accrual.
 * Returns null with fewer than two observations — an APY cannot be honestly
 * quoted from a single data point, so the UI shows "not enough history".
 */
export function annualisedReturnPct(accruals: ChainAccrual[]): number | null {
  if (accruals.length < 2) return null;
  const first = accruals[0]!;
  const last = accruals[accruals.length - 1]!;
  const seconds = last.blockTime - first.blockTime;
  const growth = last.sharePriceAfter / first.sharePriceBefore;
  if (seconds <= 0 || !(growth > 0)) return null;
  const years = seconds / (365 * 24 * 60 * 60);
  const apy = (Math.pow(growth, 1 / years) - 1) * 100;
  return Number.isFinite(apy) ? apy : null;
}

export const BECH32_ADDRESS_RE = /^addr(_test)?1[0-9a-z]{20,120}$/;
export const TX_HASH_RE = /^[0-9a-f]{64}$/;
