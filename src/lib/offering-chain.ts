/**
 * Offering datum — the single encoder/decoder, plus the arithmetic the
 * validator re-derives.
 *
 * Everything here mirrors `contracts/fraction-vault/lib/stellaris/offering.ak`
 * field for field. As with the yield vault's State datum (AUDIT.md O-02),
 * exactly one writer exists: a field written in the wrong position produces a
 * UTxO nothing can ever spend, and no build error would warn anyone.
 *
 * Pure and browser-safe — no network, no secrets, no env.
 */

import { decodePlutusDatum, asInt, asBytes, asList, type PlutusData } from "./plutus-cbor";

/** Hard cap on either fee rate, mirroring `offering.max_fee_bps`. */
export const MAX_OFFERING_FEE_BPS = 500;

/** Min-ADA rider the script UTxO must always keep, mirroring `units.ak`. */
export const MIN_RIDER_LOVELACE = 2_000_000n;

export type OfferingStatus = "open" | "closed" | "redeeming";

const STATUS_ORDER: OfferingStatus[] = ["open", "closed", "redeeming"];

export function statusIndex(status: OfferingStatus): number {
  return STATUS_ORDER.indexOf(status);
}

export interface OfferingDatum {
  /** Fractions that may ever exist. Immutable. */
  totalFractions: string;
  /** Fractions minted so far, cumulative. */
  minted: string;
  /** Fractions in circulation right now. */
  outstanding: string;
  /** Price of one fraction, in base units of the denomination. */
  price: string;
  /** Units held for holders. */
  pool: string;
  /** Units owed to the treasury, unclaimed. */
  fees: string;
  issuer: string;
  treasury: string;
  operators: string[];
  threshold: number;
  status: OfferingStatus;
  mintFeeBps: number;
  redeemFeeBps: number;
  /** Minting policy id of the fraction token bound to this offering. */
  fractionPolicy: string;
}

function decodeStatus(d: PlutusData): OfferingStatus | null {
  if (d.kind !== "constr" || d.fields.length !== 0) return null;
  return STATUS_ORDER[d.index] ?? null;
}

export function decodeOffering(d: PlutusData): OfferingDatum | null {
  if (d.kind !== "constr" || d.index !== 0 || d.fields.length !== 14) return null;
  const status = decodeStatus(d.fields[10]!);
  if (!status) return null;
  return {
    totalFractions: asInt(d.fields[0]!).toString(),
    minted: asInt(d.fields[1]!).toString(),
    outstanding: asInt(d.fields[2]!).toString(),
    price: asInt(d.fields[3]!).toString(),
    pool: asInt(d.fields[4]!).toString(),
    fees: asInt(d.fields[5]!).toString(),
    issuer: asBytes(d.fields[6]!),
    treasury: asBytes(d.fields[7]!),
    operators: asList(d.fields[8]!).map((o) => asBytes(o)),
    threshold: Number(asInt(d.fields[9]!)),
    status,
    mintFeeBps: Number(asInt(d.fields[11]!)),
    redeemFeeBps: Number(asInt(d.fields[12]!)),
    fractionPolicy: asBytes(d.fields[13]!),
  };
}

/** Decode an inline datum hex into an offering, or `null` if it is not one. */
export function readOfferingDatum(datumHex: string | null | undefined): OfferingDatum | null {
  if (!datumHex) return null;
  try {
    const parsed = decodePlutusDatum(datumHex);
    return parsed ? decodeOffering(parsed) : null;
  } catch {
    return null;
  }
}

type LucidDataMod = {
  Data: { to: (v: unknown) => string };
  Constr: new (index: number, fields: unknown[]) => unknown;
};

/** The single writer for the offering datum (constructor index 0). */
export function encodeOfferingDatum(lucidMod: unknown, o: OfferingDatum): string {
  const { Data, Constr } = lucidMod as LucidDataMod;
  return Data.to(
    new Constr(0, [
      BigInt(o.totalFractions),
      BigInt(o.minted),
      BigInt(o.outstanding),
      BigInt(o.price),
      BigInt(o.pool),
      BigInt(o.fees),
      o.issuer.toLowerCase(),
      o.treasury.toLowerCase(),
      o.operators.map((k) => k.toLowerCase()),
      BigInt(o.threshold),
      new Constr(statusIndex(o.status), []),
      BigInt(o.mintFeeBps),
      BigInt(o.redeemFeeBps),
      o.fractionPolicy.toLowerCase(),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Arithmetic — floored integers, identical to offering.ak
// ---------------------------------------------------------------------------

/** Floored basis points of a non-negative amount. */
export function bpsOf(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}

/** Cost of `qty` fractions at `price` each. */
export function buyCost(price: bigint, qty: bigint): bigint {
  if (price <= 0n || qty <= 0n) return 0n;
  return price * qty;
}

/** Pro-rata slice of the pool for `qty` of `outstanding` fractions, floored. */
export function redeemGross(pool: bigint, qty: bigint, outstanding: bigint): bigint {
  if (pool <= 0n || qty <= 0n || outstanding <= 0n || qty > outstanding) return 0n;
  return (pool * qty) / outstanding;
}

/** Fractions still available to buy. */
export function fractionsRemaining(o: OfferingDatum): bigint {
  return BigInt(o.totalFractions) - BigInt(o.minted);
}

export interface BuyQuote {
  qty: bigint;
  cost: bigint;
  /** Platform fee taken out of the cost and credited to the treasury. */
  fee: bigint;
  /** What actually reaches the pool backing the fractions. */
  toPool: bigint;
}

/** What a purchase costs, and how that cost splits — shown before signing. */
export function quoteBuy(o: OfferingDatum, qty: bigint): BuyQuote {
  const cost = buyCost(BigInt(o.price), qty);
  const fee = bpsOf(cost, o.mintFeeBps);
  return { qty, cost, fee, toPool: cost - fee };
}

export interface RedeemQuote {
  qty: bigint;
  /** Pro-rata slice of the pool before the exit fee. */
  gross: bigint;
  fee: bigint;
  /** What the redeemer is actually paid. */
  net: bigint;
}

/** What burning `qty` fractions pays out right now. */
export function quoteRedeem(o: OfferingDatum, qty: bigint): RedeemQuote {
  const gross = redeemGross(BigInt(o.pool), qty, BigInt(o.outstanding));
  const fee = bpsOf(gross, o.redeemFeeBps);
  return { qty, gross, fee, net: gross - fee };
}

/**
 * Backing per fraction right now: what one fraction would redeem for, before
 * the exit fee. This is the honest "what is it worth" number — it moves only
 * when income is actually distributed on chain, never on a projection.
 */
export function backingPerFraction(o: OfferingDatum): bigint {
  const outstanding = BigInt(o.outstanding);
  if (outstanding <= 0n) return 0n;
  return BigInt(o.pool) / outstanding;
}
