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
  inputs: Array<{ address: string; amount: BfAmount[]; inline_datum: string | null }>;
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
//           treasury_shares, last_fee_time, receipt_policy,
//           entry_fee_bps, exit_fee_bps }                        -> constructor 1
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
  /** Stage 7: entry fee in basis points, withheld from each deposit. */
  entryFeeBps: number;
  /** Stage 7: exit fee in basis points, withheld from each redemption. */
  exitFeeBps: number;
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
  if (d.kind !== "constr" || d.index !== 1 || d.fields.length !== 13) return null;
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
    entryFeeBps: Number(asInt(d.fields[11])),
    exitFeeBps: Number(asInt(d.fields[12])),
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
 * and `yield-position.ts` each hand-rolled this 13-field constructor
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
      BigInt(state.entryFeeBps),
      BigInt(state.exitFeeBps),
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

// ---------------------------------------------------------------------------
// Genuine-State selection (AUDIT.md F-1, O-03)
// ---------------------------------------------------------------------------

/** Asset name (hex) of every state-thread token: UTF-8 "state". */
const THREAD_NAME_HEX = "7374617465";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk;
}

/**
 * Script hash (hex) of a script-locked Shelley address, or null for anything
 * else. A tiny checksum-verifying bech32 decoder, so server readers can derive
 * a vault's thread-token unit without importing Lucid into the SSR bundle.
 */
export function scriptHashOfAddress(address: string): string | null {
  const lower = address.toLowerCase();
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || lower.length - sep < 7) return null;
  const hrp = lower.slice(0, sep);
  const data: number[] = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const expanded = [
    ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map((c) => c.charCodeAt(0) & 31),
  ];
  if (bech32Polymod([...expanded, ...data]) !== 1) return null;
  // 5-bit groups -> bytes, dropping the 6-character checksum.
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  // Header: high nibble 1/3/5/7 = script payment credential (CIP-19).
  const header = bytes[0];
  if (header === undefined || bytes.length < 29 || ((header >> 4) & 1) !== 1) return null;
  return bytes
    .slice(1, 29)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Asset name (hex) of every position marker: UTF-8 "position" (F-4). */
const MARKER_NAME_HEX = "706f736974696f6e";

/** Lucid/Blockfrost unit of the position marker at a script address. */
export function markerUnitOfAddress(address: string): string | null {
  const hash = scriptHashOfAddress(address);
  return hash ? `${hash}${MARKER_NAME_HEX}` : null;
}

/** Lucid/Blockfrost unit of the state-thread token at a script address. */
export function threadUnitOfAddress(address: string): string | null {
  const hash = scriptHashOfAddress(address);
  return hash ? `${hash}${THREAD_NAME_HEX}` : null;
}

/** Quantity of `unit` in a Blockfrost amount list. */
export function quantityOf(amount: BfAmount[] | undefined, unit: string): bigint {
  const entry = (amount ?? []).find((a) => a.unit === unit);
  return entry ? BigInt(entry.quantity) : 0n;
}

/**
 * F-1: the genuine State is the one carrying the instance's state-thread
 * token. Anyone can pay a State-shaped datum to a vault address, so shape and
 * "most advanced epoch" prove nothing — an attacker picks those freely, which
 * is why the old `selectCanonicalState` (highest epoch wins) was unsafe for
 * building transactions (O-03 regression). Token-less candidates are ignored
 * and counted as `planted` so callers can surface them.
 *
 * At most one UTxO can ever hold the token on-chain; more than one means the
 * data is not from the chain (or the unit is wrong), so this throws rather than
 * guess.
 */
export function selectThreadState<T>(
  candidates: T[],
  holdsThread: (c: T) => boolean,
  address: string,
): { genuine: T | null; planted: number } {
  const genuine = candidates.filter(holdsThread);
  if (genuine.length > 1) {
    throw new Error(
      `Vault state ambiguous: ${String(genuine.length)} UTxOs at ${address} claim the state-thread ` +
        `token, which the validator makes impossible. Refusing to read or build from this address.`,
    );
  }
  return { genuine: genuine[0] ?? null, planted: candidates.length - genuine.length };
}

/**
 * F-6: does `candidate` sit under the same script payment credential as
 * `address`, whatever its stake credential? The validators pin every State to
 * its genesis address, so in practice the two are equal; matching on the
 * credential means a reader never loses the State if they ever differ.
 */
export function sameScriptCredential(candidate: string, address: string): boolean {
  const hash = scriptHashOfAddress(address);
  return hash !== null && scriptHashOfAddress(candidate) === hash;
}

/** Lucid credential of the script behind a vault address (F-6). */
export function scriptCredentialOf(address: string): { type: "Script"; hash: string } {
  const hash = scriptHashOfAddress(address);
  if (!hash) throw new Error(`Not a script address: ${address.slice(0, 24)}…`);
  return { type: "Script", hash };
}

/**
 * The genuine State datum among Blockfrost items (UTxOs, tx inputs or tx
 * outputs) under `address`'s script credential: State-shaped AND carrying the
 * thread token. Null when there is none — including when only planted,
 * token-less States exist.
 */
export function genuineStateAt(
  items: Array<{ address?: string; amount?: BfAmount[]; inline_datum: string | null }>,
  address: string,
): VaultStateDatum | null {
  const unit = threadUnitOfAddress(address);
  if (!unit) return null;
  const candidates = items
    .filter((i) => i.address === undefined || sameScriptCredential(i.address, address))
    .map((i) => ({ state: readStateDatum(i.inline_datum), amount: i.amount }))
    .filter((c): c is { state: VaultStateDatum; amount: BfAmount[] | undefined } => c.state !== null);
  return selectThreadState(candidates, (c) => quantityOf(c.amount, unit) === 1n, address).genuine
    ?.state ?? null;
}

/**
 * Transaction builders' version of `genuineStateAt`, over Lucid UTxOs: pick
 * the State UTxO carrying the instance's thread token (`threadUnit`). Returns
 * null when the vault has no genuine State; planted token-less States are
 * never returned, whatever epoch or price they claim (F-1, O-03).
 */
export function genuineLucidState<
  U extends {
    txHash: string;
    outputIndex: number;
    address?: string;
    datum?: string | null;
    assets: Record<string, bigint>;
  },
>(utxos: U[], threadUnit: string, address: string): { utxo: U; state: VaultStateDatum } | null {
  const candidates: Array<{ utxo: U; state: VaultStateDatum }> = [];
  for (const u of utxos) {
    if (u.address !== undefined && !sameScriptCredential(u.address, address)) continue;
    const state = readStateDatum(u.datum ?? null);
    if (state) candidates.push({ utxo: u, state });
  }
  return selectThreadState(candidates, (c) => (c.utxo.assets[threadUnit] ?? 0n) === 1n, address)
    .genuine;
}

/**
 * F-6: find the vault's genuine State by its thread token across the script's
 * whole payment credential (any stake credential), not just the derived
 * enterprise address. Builders must pay the continuing State (and any new
 * Position) back to `utxo.address`, which the validator requires.
 */
export async function findLucidState<
  U extends {
    txHash: string;
    outputIndex: number;
    address: string;
    datum?: string | null;
    assets: Record<string, bigint>;
  },
>(
  lucid: { utxosAtWithUnit: (c: { type: "Script"; hash: string }, unit: string) => Promise<U[]> },
  address: string,
  threadUnit: string,
): Promise<{ utxo: U; state: VaultStateDatum } | null> {
  const utxos = await lucid.utxosAtWithUnit(scriptCredentialOf(address), threadUnit);
  return genuineLucidState(utxos, threadUnit, address);
}

/**
 * F-6, Blockfrost side: the UTxOs of a vault, read where its genuine State
 * actually sits. The address holding the instance's thread token is looked up
 * by asset (`/assets/{unit}/addresses`) and accepted only under the same
 * script payment credential as `address`; the vault's Positions live beside
 * the State, so its UTxOs are read there. Falls back to `address` itself
 * before bootstrap (no token minted yet). `get` is the caller's Blockfrost
 * GET (server-side `bfGet`), so this module stays free of server imports.
 */
export async function bfVaultUtxos<U>(
  get: <T>(path: string) => Promise<T | null>,
  address: string,
  query = "",
): Promise<{ address: string; utxos: U[] }> {
  const unit = threadUnitOfAddress(address);
  let at = address;
  if (unit) {
    const holders = (await get<Array<{ address: string }>>(`/assets/${unit}/addresses`)) ?? [];
    const own = holders.filter((h) => sameScriptCredential(h.address, address));
    if (own.length > 1) {
      throw new Error(
        `Vault state ambiguous: the state-thread token of ${address} is held at ` +
          `${String(own.length)} addresses, which the validator makes impossible.`,
      );
    }
    if (own[0]) at = own[0].address;
  }
  const utxos = (await get<U[]>(`/addresses/${at}/utxos${query}`)) ?? [];
  return { address: at, utxos };
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
