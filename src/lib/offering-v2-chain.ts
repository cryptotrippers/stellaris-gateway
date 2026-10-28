/**
 * fraction_vault v2 — the State and pledge datums, the redeemers, and the
 * next-State rules (E07).
 *
 * Mirrors `contracts/fraction-vault/lib/stellaris/fv2.ak` and the redeemers in
 * `validators/offering_v2.ak` and `validators/pledge.ak` field for field. Like
 * the v1 offering datum (AUDIT.md O-02) there is exactly ONE writer per datum:
 * a field in the wrong position produces a UTxO nothing can ever spend.
 *
 * `nextState` computes, for each action, the one next State the validator
 * accepts, and refuses early with a readable reason when the validator would.
 * The builders in `offering-v2-tx.ts` only ever pay the State this returns.
 *
 * Pure and browser-safe: no network, no secrets, no env, no Lucid import.
 */
import { asBytes, asInt, asList, decodePlutusDatum, type PlutusData } from "./plutus-cbor";

/** Hard cap on the settlement fee, mirroring `fv2.max_fee_bps`. */
export const V2_MAX_FEE_BPS = 500;
/** Min-ADA rider on every script UTxO, mirroring `units.min_rider_lovelace`. */
export const V2_MIN_RIDER = 2_000_000n;
/** Asset name (hex) of the pledge marker: UTF-8 "pledge". */
export const PLEDGE_MARKER_HEX = "706c65646765";
/**
 * Pledges per Settle the keeper builds: the largest batch that leaves 20%
 * headroom in the worst input order (SPEC-v2 §11.4; CI gate fv2-budget-report).
 */
export const KEEPER_BATCH = 15;

export type V2Status = "raising" | "operating" | "refunding" | "windingDown" | "closed";
const STATUSES: V2Status[] = ["raising", "operating", "refunding", "windingDown", "closed"];

export type Credential = { type: "key" | "script"; hash: string };

/** A Shelley address as Plutus sees it. Pointer stake credentials are not supported. */
export interface PlutusAddress {
  payment: Credential;
  stake: Credential | null;
}

export interface V2Terms {
  totalFractions: bigint;
  softCap: bigint;
  price: bigint;
  /** POSIX milliseconds. */
  deadline: bigint;
  settleWindow: bigint;
  retained: bigint;
  docsHash: string;
  spvPayout: Credential;
  treasury: string;
  issuer: string;
  keeper: string;
  fractionPolicy: string;
  eligibilityPolicy: string | null;
  unitPolicy: string;
  unitName: string;
}

export interface V2Book {
  settled: bigint;
  outstanding: bigint;
  escrowed: bigint;
  released: bigint;
  fees: bigint;
  pool: bigint;
  netProceeds: bigint;
}

export interface V2State {
  status: V2Status;
  terms: V2Terms;
  book: V2Book;
  feeBps: number;
  period: bigint;
  manifestRoot: string;
  committee: string[];
  threshold: number;
}

export interface V2Pledge {
  /** The offering's script hash (its thread-token policy). */
  offering: string;
  owner: PlutusAddress;
  qty: bigint;
  /** POSIX ms: the pledge transaction's lower validity bound. */
  created: bigint;
}

export const EMPTY_BOOK: V2Book = {
  settled: 0n,
  outstanding: 0n,
  escrowed: 0n,
  released: 0n,
  fees: 0n,
  pool: 0n,
  netProceeds: 0n,
};

// ---------------------------------------------------------------------------
// Encoding (the single writer) — Lucid's Data/Constr are passed in
// ---------------------------------------------------------------------------

type ConstrCtor = new (index: number, fields: unknown[]) => unknown;
interface DataMod {
  Data: { to: (v: unknown) => string };
  Constr: ConstrCtor;
}

const lc = (s: string) => s.toLowerCase();

function credData(C: ConstrCtor, c: Credential): unknown {
  return new C(c.type === "key" ? 0 : 1, [lc(c.hash)]);
}

function addressData(C: ConstrCtor, a: PlutusAddress): unknown {
  // Address { payment_credential, stake_credential: Option<StakeCredential> };
  // StakeCredential::Inline(Credential) is constructor 0.
  const stake = a.stake ? new C(0, [new C(0, [credData(C, a.stake)])]) : new C(1, []);
  return new C(0, [credData(C, a.payment), stake]);
}

function termsData(C: ConstrCtor, t: V2Terms): unknown {
  return new C(0, [
    t.totalFractions,
    t.softCap,
    t.price,
    t.deadline,
    t.settleWindow,
    t.retained,
    lc(t.docsHash),
    credData(C, t.spvPayout),
    lc(t.treasury),
    lc(t.issuer),
    lc(t.keeper),
    lc(t.fractionPolicy),
    t.eligibilityPolicy ? new C(0, [lc(t.eligibilityPolicy)]) : new C(1, []),
    lc(t.unitPolicy),
    lc(t.unitName),
  ]);
}

function bookData(C: ConstrCtor, b: V2Book): unknown {
  return new C(0, [
    b.settled,
    b.outstanding,
    b.escrowed,
    b.released,
    b.fees,
    b.pool,
    b.netProceeds,
  ]);
}

/** Plutus data (unserialised) of a State datum, for embedding. */
export function stateData(mod: unknown, s: V2State): unknown {
  const { Constr: C } = mod as DataMod;
  return new C(0, [
    new C(STATUSES.indexOf(s.status), []),
    termsData(C, s.terms),
    bookData(C, s.book),
    BigInt(s.feeBps),
    s.period,
    lc(s.manifestRoot),
    s.committee.map(lc),
    BigInt(s.threshold),
  ]);
}

/** CBOR hex of a State datum. */
export function encodeState(mod: unknown, s: V2State): string {
  return (mod as DataMod).Data.to(stateData(mod, s));
}

/** CBOR hex of a pledge datum. */
export function encodePledge(mod: unknown, p: V2Pledge): string {
  const { Data, Constr: C } = mod as DataMod;
  return Data.to(new C(0, [lc(p.offering), addressData(C, p.owner), p.qty, p.created]));
}

/** CBOR hex of an `OutputReference` (the tag on a refund or cancel payout). */
export function encodeOutRef(mod: unknown, ref: { txHash: string; outputIndex: number }): string {
  const { Data, Constr: C } = mod as DataMod;
  return Data.to(new C(0, [lc(ref.txHash), BigInt(ref.outputIndex)]));
}

export type OfferingAction =
  | { kind: "settle" }
  | { kind: "closeRaise" }
  | { kind: "failRaise" }
  | { kind: "cancelRaise" }
  | { kind: "refundFraction"; qty: bigint }
  | { kind: "release"; amount: bigint; evidenceHash: string }
  | { kind: "commitPeriod"; period: bigint; manifestRoot: string }
  | { kind: "setFees"; feeBps: number }
  | { kind: "claimFee"; amount: bigint }
  | { kind: "rotate"; committee: string[]; threshold: number }
  | { kind: "beginWindDown"; finalPool: bigint }
  | { kind: "redeem"; qty: bigint };

/** CBOR hex of an `OfferingAction` redeemer (constructor order of offering_v2.ak). */
export function encodeOfferingAction(mod: unknown, a: OfferingAction): string {
  const { Data, Constr: C } = mod as DataMod;
  const r = (() => {
    switch (a.kind) {
      case "settle":
        return new C(0, []);
      case "closeRaise":
        return new C(1, []);
      case "failRaise":
        return new C(2, []);
      case "cancelRaise":
        return new C(3, []);
      case "refundFraction":
        return new C(4, [a.qty]);
      case "release":
        return new C(5, [a.amount, lc(a.evidenceHash)]);
      case "commitPeriod":
        return new C(6, [a.period, lc(a.manifestRoot)]);
      case "setFees":
        return new C(7, [BigInt(a.feeBps)]);
      case "claimFee":
        return new C(8, [a.amount]);
      case "rotate":
        return new C(9, [a.committee.map(lc), BigInt(a.threshold)]);
      case "beginWindDown":
        return new C(10, [a.finalPool]);
      case "redeem":
        return new C(11, [a.qty]);
    }
  })();
  return Data.to(r);
}

export type PledgeAction =
  | { kind: "settlePledge" }
  | { kind: "cancelPledge"; outIx: number }
  | { kind: "refundPledge"; outIx: number };

export function encodePledgeAction(mod: unknown, a: PledgeAction): string {
  const { Data, Constr: C } = mod as DataMod;
  if (a.kind === "settlePledge") return Data.to(new C(0, []));
  return Data.to(new C(a.kind === "cancelPledge" ? 1 : 2, [BigInt(a.outIx)]));
}

/** `MintPledge` (0) or `BurnPledges` (1). */
export function encodePledgeMint(mod: unknown, kind: "mint" | "burn"): string {
  const { Data, Constr: C } = mod as DataMod;
  return Data.to(new C(kind === "mint" ? 0 : 1, []));
}

// ---------------------------------------------------------------------------
// Decoding (reader) — strict: anything not exactly this shape is null
// ---------------------------------------------------------------------------

function constr(d: PlutusData | undefined, index: number | null, n: number): PlutusData[] {
  if (!d || d.kind !== "constr" || d.fields.length !== n) throw new Error("shape");
  if (index !== null && d.index !== index) throw new Error("shape");
  return d.fields;
}

function decodeCred(d: PlutusData | undefined): Credential {
  if (!d || d.kind !== "constr" || d.fields.length !== 1 || d.index > 1) throw new Error("cred");
  return { type: d.index === 0 ? "key" : "script", hash: asBytes(d.fields[0]) };
}

function decodeAddress(d: PlutusData | undefined): PlutusAddress {
  const [pay, stake] = constr(d, 0, 2);
  let s: Credential | null = null;
  if (!stake || stake.kind !== "constr") throw new Error("addr");
  if (stake.index === 0) {
    const [inner] = constr(stake, 0, 1);
    s = decodeCred(constr(inner, 0, 1)[0]);
  } else if (stake.index !== 1 || stake.fields.length !== 0) {
    throw new Error("addr");
  }
  return { payment: decodeCred(pay), stake: s };
}

function decodeTerms(d: PlutusData | undefined): V2Terms {
  const f = constr(d, 0, 15);
  const elig = f[12]!;
  if (elig.kind !== "constr") throw new Error("elig");
  return {
    totalFractions: asInt(f[0]),
    softCap: asInt(f[1]),
    price: asInt(f[2]),
    deadline: asInt(f[3]),
    settleWindow: asInt(f[4]),
    retained: asInt(f[5]),
    docsHash: asBytes(f[6]),
    spvPayout: decodeCred(f[7]),
    treasury: asBytes(f[8]),
    issuer: asBytes(f[9]),
    keeper: asBytes(f[10]),
    fractionPolicy: asBytes(f[11]),
    eligibilityPolicy:
      elig.index === 0 ? asBytes(constr(elig, 0, 1)[0]) : (constr(elig, 1, 0), null),
    unitPolicy: asBytes(f[13]),
    unitName: asBytes(f[14]),
  };
}

function decodeBook(d: PlutusData | undefined): V2Book {
  const f = constr(d, 0, 7);
  return {
    settled: asInt(f[0]),
    outstanding: asInt(f[1]),
    escrowed: asInt(f[2]),
    released: asInt(f[3]),
    fees: asInt(f[4]),
    pool: asInt(f[5]),
    netProceeds: asInt(f[6]),
  };
}

export function decodeState(d: PlutusData): V2State | null {
  try {
    const f = constr(d, 0, 8);
    const st = f[0]!;
    if (st.kind !== "constr" || st.fields.length !== 0 || !STATUSES[st.index]) return null;
    return {
      status: STATUSES[st.index]!,
      terms: decodeTerms(f[1]),
      book: decodeBook(f[2]),
      feeBps: Number(asInt(f[3])),
      period: asInt(f[4]),
      manifestRoot: asBytes(f[5]),
      committee: asList(f[6]).map((x) => asBytes(x)),
      threshold: Number(asInt(f[7])),
    };
  } catch {
    return null;
  }
}

export function decodePledge(d: PlutusData): V2Pledge | null {
  try {
    const f = constr(d, 0, 4);
    return {
      offering: asBytes(f[0]),
      owner: decodeAddress(f[1]),
      qty: asInt(f[2]),
      created: asInt(f[3]),
    };
  } catch {
    return null;
  }
}

export function readState(hex: string | null | undefined): V2State | null {
  if (!hex) return null;
  try {
    return decodeState(decodePlutusDatum(hex));
  } catch {
    return null;
  }
}

export function readPledge(hex: string | null | undefined): V2Pledge | null {
  if (!hex) return null;
  try {
    return decodePledge(decodePlutusDatum(hex));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Arithmetic — floored integers, identical to fv2.ak
// ---------------------------------------------------------------------------

export function bpsOf(amount: bigint, bps: number): bigint {
  if (amount <= 0n || bps <= 0) return 0n;
  return (amount * BigInt(bps)) / 10_000n;
}

export function proRata(pool: bigint, qty: bigint, outstanding: bigint): bigint {
  if (pool <= 0n || qty <= 0n || outstanding <= 0n || qty > outstanding) return 0n;
  return (pool * qty) / outstanding;
}

/** Deposit units the State must hold (invariant 4). */
export function accounted(b: V2Book): bigint {
  return b.escrowed - b.released + b.pool;
}

/** Units the committee may still release to the SPV. */
export function releaseRoom(s: V2State): bigint {
  return s.book.netProceeds - s.terms.retained - s.book.released;
}

// ---------------------------------------------------------------------------
// Next-State rules (what offering_v2 accepts), with readable refusals
// ---------------------------------------------------------------------------

export class V2Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2Refused";
  }
}

const refuse = (msg: string): never => {
  throw new V2Refused(msg);
};

const HEX32 = /^[0-9a-f]{64}$/;
const HEX28 = /^[0-9a-f]{56}$/;

/** Is a fee rate inside the cap? */
export function feeBpsOk(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= V2_MAX_FEE_BPS;
}

/** The State after settling pledges of `qtys`. */
export function settledState(s: V2State, qtys: readonly bigint[]): V2State {
  if (s.status !== "raising") refuse("This raise is no longer taking pledges.");
  if (qtys.length === 0) refuse("There are no pledges to settle.");
  if (qtys.some((q) => q <= 0n)) refuse("A pledge for zero fractions cannot be settled.");
  const q = qtys.reduce((a, b) => a + b, 0n);
  if (s.book.settled + q > s.terms.totalFractions) {
    refuse(
      `Settling these would exceed the ${s.terms.totalFractions} fractions on offer ` +
        `(${s.terms.totalFractions - s.book.settled} left).`,
    );
  }
  const cost = q * s.terms.price;
  return {
    ...s,
    book: {
      ...s.book,
      settled: s.book.settled + q,
      outstanding: s.book.outstanding + q,
      escrowed: s.book.escrowed + cost,
      fees: s.book.fees + bpsOf(cost, s.feeBps),
    },
  };
}

/**
 * The next State for every action except `settle` (use `settledState`).
 * `now` (POSIX ms) is needed for `failRaise`.
 */
export function nextState(s: V2State, a: OfferingAction, now?: bigint): V2State {
  const b = s.book;
  switch (a.kind) {
    case "settle":
      return refuse("Use settledState for Settle.");
    case "closeRaise":
      if (s.status !== "raising") refuse("Only a raise in progress can be closed.");
      if (b.settled < s.terms.softCap) {
        refuse(`The soft cap is ${s.terms.softCap} fractions; only ${b.settled} are settled.`);
      }
      return { ...s, status: "operating", book: { ...b, netProceeds: b.escrowed - b.fees } };
    case "failRaise":
      if (s.status !== "raising") refuse("Only a raise in progress can fail.");
      if (b.settled >= s.terms.softCap) refuse("The soft cap was met; this raise cannot fail.");
      if (now === undefined || now <= s.terms.deadline + s.terms.settleWindow) {
        refuse("A raise can only be failed once the settle window after the deadline has ended.");
      }
      return { ...s, status: "refunding", book: { ...b, fees: 0n } };
    case "cancelRaise":
      if (s.status !== "raising") refuse("Only a raise in progress can be cancelled.");
      return { ...s, status: "refunding", book: { ...b, fees: 0n } };
    case "refundFraction": {
      if (s.status !== "refunding")
        refuse("Fractions are refunded only after a failed or cancelled raise.");
      if (a.qty <= 0n) refuse("Enter how many fractions to refund.");
      if (a.qty > b.outstanding) refuse("That is more fractions than are in circulation.");
      const left = b.outstanding - a.qty;
      return {
        ...s,
        status: left === 0n ? "closed" : "refunding",
        book: { ...b, outstanding: left, escrowed: b.escrowed - a.qty * s.terms.price },
      };
    }
    case "release":
      if (s.status !== "operating")
        refuse("Funds are released only while the offering is operating.");
      if (a.amount <= 0n) refuse("Enter an amount to release.");
      if (a.amount > releaseRoom(s)) refuse(`At most ${releaseRoom(s)} can still be released.`);
      if (!HEX32.test(lc(a.evidenceHash))) refuse("The evidence hash must be 32 bytes (64 hex).");
      return { ...s, book: { ...b, released: b.released + a.amount } };
    case "commitPeriod":
      if (s.status !== "operating" && s.status !== "windingDown") {
        refuse("Periods are committed only while operating or winding down.");
      }
      if (a.period !== s.period + 1n) refuse(`The next period is ${s.period + 1n}.`);
      if (!HEX32.test(lc(a.manifestRoot))) refuse("The manifest root must be 32 bytes (64 hex).");
      return { ...s, period: a.period, manifestRoot: lc(a.manifestRoot) };
    case "setFees":
      if (s.status !== "raising") refuse("The fee can only change while raising.");
      if (!feeBpsOk(a.feeBps))
        refuse(`The fee must be whole basis points from 0 to ${V2_MAX_FEE_BPS}.`);
      return { ...s, feeBps: a.feeBps };
    case "claimFee":
      if (s.status === "raising" || s.status === "refunding") {
        refuse("Fees can be claimed only after a successful raise.");
      }
      if (a.amount <= 0n) refuse("There is nothing to claim.");
      if (a.amount > b.fees) refuse(`Only ${b.fees} in fees has accrued.`);
      return { ...s, book: { ...b, fees: b.fees - a.amount, escrowed: b.escrowed - a.amount } };
    case "rotate": {
      const c = a.committee.map(lc);
      if (c.length === 0 || c.some((k) => !HEX28.test(k)))
        refuse("Committee keys must be 28-byte key hashes.");
      if (new Set(c).size !== c.length) refuse("The committee lists a key twice.");
      if (a.threshold < 1 || a.threshold > c.length)
        refuse("The threshold must be between 1 and the committee size.");
      return { ...s, committee: c, threshold: a.threshold };
    }
    case "beginWindDown":
      if (s.status !== "operating") refuse("Only an operating offering can begin winding down.");
      if (a.finalPool < 0n) refuse("The final pool cannot be negative.");
      return {
        ...s,
        status: "windingDown",
        book: {
          ...b,
          escrowed: b.released + b.fees,
          pool: b.pool + a.finalPool + b.escrowed - b.released - b.fees,
        },
      };
    case "redeem": {
      if (s.status !== "windingDown")
        refuse("Fractions are redeemed only while the offering winds down.");
      if (a.qty <= 0n) refuse("Enter how many fractions to redeem.");
      if (a.qty > b.outstanding) refuse("That is more fractions than are in circulation.");
      const left = b.outstanding - a.qty;
      return {
        ...s,
        status: left === 0n ? "closed" : "windingDown",
        book: { ...b, outstanding: left, pool: b.pool - proRata(b.pool, a.qty, b.outstanding) },
      };
    }
  }
}

/** Units the State pays out (positive) or takes in (negative) for a transition. */
export function stateOutflow(before: V2State, after: V2State): bigint {
  return accounted(before.book) - accounted(after.book);
}

/**
 * Validate a new offering's opening State. Throws V2Refused with the first
 * problem, mirroring `terms_ok`, `committee_ok` and the `Open` checks.
 */
export function checkOpening(s: V2State, nowMs: bigint): void {
  const t = s.terms;
  if (s.status !== "raising") refuse("A new offering starts raising.");
  if (Object.values(s.book).some((x) => x !== 0n))
    refuse("A new offering starts with an empty book.");
  if (s.period !== 0n || s.manifestRoot !== "")
    refuse("A new offering starts at period 0 with no root.");
  if (!feeBpsOk(s.feeBps)) refuse(`The fee must be 0 to ${V2_MAX_FEE_BPS} basis points.`);
  if (t.totalFractions <= 0n) refuse("Offer at least one fraction.");
  if (t.softCap <= 0n || t.softCap > t.totalFractions)
    refuse("The soft cap must be between 1 and the hard cap.");
  if (t.price <= 0n) refuse("Set a price above zero.");
  if (t.settleWindow < 0n) refuse("The settle window cannot be negative.");
  if (t.retained < 0n) refuse("The retained amount cannot be negative.");
  if (!HEX32.test(lc(t.docsHash))) refuse("The documents hash must be 32 bytes (64 hex).");
  for (const [k, v] of [
    ["treasury", t.treasury],
    ["issuer", t.issuer],
    ["keeper", t.keeper],
    ["fraction policy", t.fractionPolicy],
  ] as const) {
    if (!HEX28.test(lc(v))) refuse(`The ${k} must be 28 bytes (56 hex).`);
  }
  if (t.deadline <= nowMs) refuse("The deadline must be in the future.");
  const c = s.committee.map(lc);
  if (c.length === 0 || new Set(c).size !== c.length || c.some((k) => !HEX28.test(k))) {
    refuse("The committee must be distinct 28-byte key hashes.");
  }
  if (s.threshold < 1 || s.threshold > c.length)
    refuse("The threshold must be between 1 and the committee size.");
}
