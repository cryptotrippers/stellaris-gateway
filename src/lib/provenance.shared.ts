/**
 * Project Meridian — money, provenance and source metadata shared by the
 * Rail B (project fractions) ledger modules.
 *
 * Money is always a `bigint` count of a currency's minor units (cents for
 * AUD). There is no floating point anywhere in the ledger: a test reads these
 * modules' source and fails on `Number(`, `parseFloat`, `toFixed` or `Math.`.
 * Amounts cross a JSON boundary only as decimal strings (`toMinorString`).
 */

/** ISO 4217 code for fiat ("AUD", "PHP", "USD"); a ticker for a token unit. */
export type CurrencyCode = string;

export interface Money {
  readonly amount: bigint;
  readonly currency: CurrencyCode;
}

export const money = (amount: bigint, currency: CurrencyCode): Money => ({ amount, currency });

/** Integer minor units as a decimal string, for JSON. */
export const toMinorString = (m: Money): string => m.amount.toString();

/** Parse a decimal-string minor-unit amount; refuses anything but an integer. */
export function fromMinorString(s: string, currency: CurrencyCode): Money {
  if (!/^-?\d+$/.test(s)) throw new Error(`not an integer minor-unit amount: ${s}`);
  return money(BigInt(s), currency);
}

/** Where a record's evidence comes from. */
export type ProvenanceKind =
  | "bank_statement"
  | "invoice"
  | "audited_accounts"
  | "management_accounts"
  | "contract"
  | "chain_tx"
  | "reviewer_decision"
  | "manual_entry";

/**
 * Audit metadata carried by every ledger record: who recorded it, when, and
 * the evidence it rests on. `documentId` / `sha256` point into the private
 * document room; `txHash` is for chain evidence.
 */
export interface Provenance {
  readonly kind: ProvenanceKind;
  readonly documentId: string | null;
  readonly sha256: string | null;
  readonly txHash: string | null;
  readonly recordedBy: string;
  /** ISO 8601 UTC. */
  readonly recordedAt: string;
}

/** How a published value was verified (API contract level). */
export type Verification = "chain" | "attested" | "reviewed" | "self_reported" | "illustrative";

/** Metadata every product-facing value carries (Meridian §9). */
export interface SourceMeta {
  readonly source: string;
  /** ISO 8601 UTC. */
  readonly observedAt: string;
  readonly verification: Verification;
  /** The "does not prove" sentence; rendered next to the value. */
  readonly limitation: string | null;
  readonly provenance: readonly Provenance[];
}

export interface Sourced<T> {
  readonly value: T;
  readonly meta: SourceMeta;
}

/** Discriminated result used by every ledger operation: no exceptions for rule failures. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: LedgerError };

export interface LedgerError {
  readonly code: LedgerErrorCode;
  readonly message: string;
}

export type LedgerErrorCode =
  | "currency_mismatch"
  | "non_positive_amount"
  | "duplicate_reference"
  | "unknown_reference"
  | "period_not_open"
  | "period_not_approved"
  | "unknown_period"
  | "over_settlement"
  | "reserve_insufficient"
  | "unauthorised_release"
  | "missing_provenance"
  | "exceeds_distributable"
  | "exceeds_funded"
  | "exceeds_approved"
  | "distribution_exists"
  | "not_in_snapshot"
  | "ineligible_holder"
  | "already_paid"
  | "wrong_status"
  | "cross_rail_reference"
  | "invalid_snapshot"
  | "version_conflict";

/** True when the provenance names a recorder, a time and at least one piece of evidence. */
export function hasEvidence(p: Provenance | null | undefined): p is Provenance {
  if (!p) return false;
  if (!p.recordedBy.trim() || !p.recordedAt.trim()) return false;
  return Boolean(p.documentId || p.sha256 || p.txHash || p.kind === "reviewer_decision");
}

/**
 * Optimistic-concurrency cell. Every state change is computed from a read
 * version and committed only if nothing else committed first, so two payouts
 * computed from the same state cannot both land (I-B6 under concurrency).
 */
export interface Versioned<T> {
  readonly version: number;
  readonly value: T;
}

export const versioned = <T>(value: T): Versioned<T> => ({ version: 0, value });

export function commitIfCurrent<T>(
  cell: Versioned<T>,
  readVersion: number,
  next: T,
): Result<Versioned<T>> {
  if (cell.version !== readVersion) {
    return fail("version_conflict", `state moved from v${readVersion} to v${cell.version}`);
  }
  return ok({ version: cell.version + 1, value: next });
}

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T>(code: LedgerErrorCode, message: string): Result<T> => ({
  ok: false,
  error: { code, message },
});
