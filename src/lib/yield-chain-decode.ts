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
//           treasury_shares, last_fee_time, receipt_policy }    -> constructor 1
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
  /** Stage 6: receipt minting policy id bound to this vault (28-byte hex). */
  receiptPolicy: string;
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
  if (d.kind !== "constr" || d.index !== 1 || d.fields.length !== 11) return null;
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
    receiptPolicy: asBytes(d.fields[10]),
  };
}

export function decodePosition(d: PlutusData): VaultPositionDatum | null {
  if (d.kind !== "constr" || d.index !== 0 || d.fields.length !== 2) return null;
  return { owner: asBytes(d.fields[0]), shares: asInt(d.fields[1]).toString() };
}

type LucidDataMod = {
  Data: { to: (v: unknown) => string };
  Constr: new (index: number, fields: unknown[]) => unknown;
};

/**
 * AUDIT.md O-02: the single writer for the yield-vault's State datum
 * (constructor index 1). Previously `vault-bootstrap.ts`, `vault-accrual.ts`
 * and `yield-position.ts` each hand-rolled this 11-field constructor
 * independently; a field written in the wrong position or CBOR type produces
 * a UTxO the validator can never spend, with no build-time error to warn
 * anyone. Every writer must go through this function so its output always
 * matches `decodeState` field-for-field — see
 * `scripts/verify-state-datum-roundtrip.ts` for the regression test.
 */
export function encodeStateDatum(lucidMod: unknown, state: VaultStateDatum): string {
  const { Data, Constr } = lucidMod as LucidDataMod;
  return Data.to(
    new Constr(1, [
      BigInt(state.totalShares),
      BigInt(state.totalAssets),
      BigInt(state.epoch),
      state.operators.map((o) => o.toLowerCase()),
      BigInt(state.threshold),
      new Constr(state.paused ? 1 : 0, []),
      BigInt(state.feeBps),
      state.treasury,
      BigInt(state.treasuryShares),
      BigInt(state.lastFeeTime),
      state.receiptPolicy,
    ]),
  );
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

/**
 * AUDIT.md O-03: never silently trust the first State-shaped UTxO found at a
 * vault address. With V-01 fixed a planted State is unspendable on-chain, but
 * the decoder must not read one for display or for transaction building —
 * a second State means the address is ambiguous and the operator has to look.
 */
export function soleStateOrThrow<T>(candidates: T[], address: string): T | null {
  if (candidates.length > 1) {
    throw new Error(
      `Vault state ambiguous: found ${String(candidates.length)} State UTxOs at ${address}, ` +
        `expected exactly one. A duplicate or planted vault state is present — ` +
        `it cannot be spent on-chain, but no balance or transaction may be built ` +
        `from this address until an operator identifies the genuine state UTxO.`,
    );
  }
  return candidates[0] ?? null;
}

/**
 * Pick the live ledger when an address carries more than one State UTxO — the
 * usual cause being a vault that was bootstrapped twice, which leaves a second,
 * never-used State sitting at the same script address.
 *
 * The validator only ever spends ONE State per transaction, so duplicates are
 * harmless on-chain; what matters is that every reader and every transaction
 * builder agrees on the SAME one. The ordering below is fully deterministic:
 *
 *   1. the most advanced ledger wins (epoch, then accounted assets, then
 *      shares, then fee clock) — a used vault beats an untouched bootstrap;
 *   2. ties go to the State descended from the registered bootstrap tx;
 *   3. remaining ties break lexicographically on `txHash#index`.
 */
export function selectCanonicalState<T>(
  candidates: T[],
  ref: (c: T) => { txHash: string; outputIndex: number; state: VaultStateDatum },
  opts: { bootstrapTxHash?: string | null } = {},
): T | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const boot = (opts.bootstrapTxHash ?? "").toLowerCase();
  const scored = candidates.map((c) => ({ c, r: ref(c) }));
  scored.sort((a, b) => {
    const sa = a.r.state;
    const sb = b.r.state;
    if (sb.epoch !== sa.epoch) return sb.epoch - sa.epoch;
    const cmp = (x: string, y: string) => (BigInt(y) > BigInt(x) ? 1 : BigInt(y) < BigInt(x) ? -1 : 0);
    const assets = cmp(sa.totalAssets, sb.totalAssets);
    if (assets !== 0) return assets;
    const shares = cmp(sa.totalShares, sb.totalShares);
    if (shares !== 0) return shares;
    const clock = cmp(sa.lastFeeTime, sb.lastFeeTime);
    if (clock !== 0) return clock;
    const ba = a.r.txHash.toLowerCase() === boot ? 0 : 1;
    const bb = b.r.txHash.toLowerCase() === boot ? 0 : 1;
    if (ba !== bb) return ba - bb;
    return `${a.r.txHash}#${a.r.outputIndex}`.localeCompare(`${b.r.txHash}#${b.r.outputIndex}`);
  });
  return scored[0]?.c ?? null;
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
  /** How many State UTxOs sit at this address (>1 means a duplicate bootstrap). */
  stateCount: number;
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
  /** Shares minted to the treasury as the management fee in this accrual. */
  feeSharesMinted: string;
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
    const sharesDelta = BigInt(curr.state.totalShares) - BigInt(prev.state.totalShares);
    const treasuryDelta =
      BigInt(curr.state.treasuryShares) - BigInt(prev.state.treasuryShares);
    // An accrual bumps the epoch and adds lovelace. The only share supply
    // movement it may cause is the management fee minted to the treasury.
    if (
      curr.state.epoch <= prev.state.epoch ||
      assetsDelta <= 0n ||
      sharesDelta < 0n ||
      sharesDelta !== treasuryDelta
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
      feeSharesMinted: treasuryDelta.toString(),
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
