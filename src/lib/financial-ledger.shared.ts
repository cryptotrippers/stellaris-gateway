/**
 * Project Meridian — Rail B project ledger (Phase 2).
 *
 * A pure, append-only ledger for ONE project in ONE currency. Every function
 * returns a new ledger value; nothing is mutated and nothing touches I/O, so
 * the same history always produces the same numbers.
 *
 * Rules enforced here (invariant ids from the Meridian proposal):
 *  - I-B4 / I-B8  every source reference is unique project-wide, so one
 *                 receipt (or expense, or obligation) cannot be booked twice
 *                 or fund two periods.
 *  - I-B9         Rail B never references Rail A: no `tessera:` project ids or
 *                 references and no TSRA / sTSRA currency.
 *  - I-B11        entries post only to an OPEN period; an approved period is
 *                 immutable and corrections go into an adjustment period.
 *  - Settlements, write-offs, payments and reserve releases can never exceed
 *    what they reconcile against.
 *
 * Money is bigint minor units throughout (see provenance.shared.ts).
 */

import {
  fail,
  hasEvidence,
  ok,
  type CurrencyCode,
  type Provenance,
  type Result,
} from "./provenance.shared";

export type PeriodStatus = "open" | "closed" | "approved";

export interface AccountingPeriod {
  readonly id: string;
  readonly kind: "regular" | "adjustment";
  /** For an adjustment period: the approved period it corrects. */
  readonly adjustsPeriodId: string | null;
  /** ISO date range, informational. */
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: PeriodStatus;
  readonly approvedBy: string | null;
}

interface EntryBase {
  /** Source reference, unique project-wide (invoice no., bank txn id …). */
  readonly ref: string;
  readonly periodId: string;
  readonly amount: bigint;
  readonly provenance: Provenance;
}

export type LedgerEntry =
  | (EntryBase & { readonly kind: "invoice_issued"; readonly counterparty: string })
  | (EntryBase & { readonly kind: "receipt_settled"; readonly invoiceRef: string | null })
  | (EntryBase & { readonly kind: "invoice_written_off"; readonly invoiceRef: string })
  | (EntryBase & { readonly kind: "expense_accrued"; readonly category: string })
  | (EntryBase & { readonly kind: "expense_paid"; readonly accruedRef: string | null })
  | (EntryBase & {
      readonly kind: "obligation_due";
      readonly rank: number;
      readonly creditor: string;
    })
  | (EntryBase & { readonly kind: "obligation_paid"; readonly obligationRef: string })
  | (EntryBase & { readonly kind: "reserve_contribution"; readonly reserve: string })
  | (EntryBase & {
      readonly kind: "reserve_release";
      readonly reserve: string;
      readonly authorisedBy: string;
    })
  | (EntryBase & { readonly kind: "valuation_recorded"; readonly method: string });

export type EntryKind = LedgerEntry["kind"];

/** Entry as submitted (the ledger fills in nothing; it only validates). */
export type EntryInput = LedgerEntry;

export interface ProjectLedger {
  readonly projectId: string;
  readonly currency: CurrencyCode;
  readonly periods: readonly AccountingPeriod[];
  readonly entries: readonly LedgerEntry[];
}

const RAIL_A_PREFIX = /^tessera[:/]/i;
const RAIL_A_CURRENCIES = new Set(["TSRA", "STSRA"]);

/** Idempotency key for an entry; equal keys mean the same economic event. */
export const idempotencyKey = (
  projectId: string,
  e: Pick<LedgerEntry, "periodId" | "kind" | "ref">,
) => `${projectId}:${e.periodId}:${e.kind}:${e.ref}`;

export function createLedger(projectId: string, currency: CurrencyCode): Result<ProjectLedger> {
  if (!projectId.trim()) return fail("unknown_reference", "project id is required");
  if (RAIL_A_PREFIX.test(projectId)) {
    return fail("cross_rail_reference", "a Rail B ledger cannot use a Tessera project id");
  }
  if (RAIL_A_CURRENCIES.has(currency.toUpperCase())) {
    return fail("cross_rail_reference", "TSRA / sTSRA are Rail A units, not project currency");
  }
  return ok({ projectId, currency, periods: [], entries: [] });
}

export const findPeriod = (l: ProjectLedger, id: string) => l.periods.find((p) => p.id === id);

export function openPeriod(
  l: ProjectLedger,
  p: { id: string; startsOn: string; endsOn: string; adjustsPeriodId?: string | null },
): Result<ProjectLedger> {
  if (findPeriod(l, p.id)) return fail("duplicate_reference", `period ${p.id} already exists`);
  const adjusts = p.adjustsPeriodId ?? null;
  if (adjusts !== null) {
    const target = findPeriod(l, adjusts);
    if (!target) return fail("unknown_period", `adjusted period ${adjusts} does not exist`);
    if (target.status !== "approved") {
      return fail("period_not_approved", "only an approved period needs an adjustment period");
    }
  }
  const period: AccountingPeriod = {
    id: p.id,
    kind: adjusts ? "adjustment" : "regular",
    adjustsPeriodId: adjusts,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    status: "open",
    approvedBy: null,
  };
  return ok({ ...l, periods: [...l.periods, period] });
}

function setStatus(
  l: ProjectLedger,
  id: string,
  from: PeriodStatus,
  to: PeriodStatus,
  approvedBy: string | null,
): Result<ProjectLedger> {
  const p = findPeriod(l, id);
  if (!p) return fail("unknown_period", `period ${id} does not exist`);
  if (p.status !== from)
    return fail("wrong_status", `period ${id} is ${p.status}, expected ${from}`);
  const next = { ...p, status: to, approvedBy: approvedBy ?? p.approvedBy };
  return ok({ ...l, periods: l.periods.map((x) => (x.id === id ? next : x)) });
}

/** Stop new postings; the period can still be reviewed before approval. */
export const closePeriod = (l: ProjectLedger, id: string) =>
  setStatus(l, id, "open", "closed", null);

/** Approve a closed period. After this it is immutable (I-B11). */
export function approvePeriod(
  l: ProjectLedger,
  id: string,
  approvedBy: string,
): Result<ProjectLedger> {
  if (!approvedBy.trim()) return fail("unauthorised_release", "approval needs a named approver");
  return setStatus(l, id, "closed", "approved", approvedBy);
}

const byRef = (l: ProjectLedger, ref: string) => l.entries.find((e) => e.ref === ref);

const sumWhere = (l: ProjectLedger, pred: (e: LedgerEntry) => boolean) =>
  l.entries.reduce((s, e) => (pred(e) ? s + e.amount : s), 0n);

/** Amount still owed on an invoice: issued − settled − written off. */
export function invoiceOutstanding(l: ProjectLedger, invoiceRef: string): bigint {
  const inv = byRef(l, invoiceRef);
  if (!inv || inv.kind !== "invoice_issued") return 0n;
  const settled = sumWhere(
    l,
    (e) =>
      (e.kind === "receipt_settled" && e.invoiceRef === invoiceRef) ||
      (e.kind === "invoice_written_off" && e.invoiceRef === invoiceRef),
  );
  return inv.amount - settled;
}

export function accrualOutstanding(l: ProjectLedger, accruedRef: string): bigint {
  const acc = byRef(l, accruedRef);
  if (!acc || acc.kind !== "expense_accrued") return 0n;
  return acc.amount - sumWhere(l, (e) => e.kind === "expense_paid" && e.accruedRef === accruedRef);
}

export function obligationOutstanding(l: ProjectLedger, obligationRef: string): bigint {
  const ob = byRef(l, obligationRef);
  if (!ob || ob.kind !== "obligation_due") return 0n;
  return (
    ob.amount -
    sumWhere(l, (e) => e.kind === "obligation_paid" && e.obligationRef === obligationRef)
  );
}

/** Restricted reserve balance across all periods (contributions − releases). */
export function reserveBalance(l: ProjectLedger, reserve?: string): bigint {
  return l.entries.reduce((s, e) => {
    if (reserve !== undefined && "reserve" in e && e.reserve !== reserve) return s;
    if (e.kind === "reserve_contribution") return s + e.amount;
    if (e.kind === "reserve_release") return s - e.amount;
    return s;
  }, 0n);
}

/** Validate and append one entry. Rejections never change the ledger. */
export function post(l: ProjectLedger, e: EntryInput): Result<ProjectLedger> {
  const period = findPeriod(l, e.periodId);
  if (!period) return fail("unknown_period", `period ${e.periodId} does not exist`);
  if (period.status !== "open") {
    return fail(
      "period_not_open",
      period.status === "approved"
        ? `period ${period.id} is approved and immutable; post to an adjustment period`
        : `period ${period.id} is ${period.status}`,
    );
  }
  if (typeof e.amount !== "bigint")
    return fail("non_positive_amount", "amount must be bigint minor units");
  if (e.amount <= 0n) return fail("non_positive_amount", `amount must be positive (${e.ref})`);
  if (!e.ref.trim()) return fail("unknown_reference", "source reference is required");
  if (RAIL_A_PREFIX.test(e.ref)) {
    return fail("cross_rail_reference", `${e.ref} is a Tessera reference; Rail B cannot book it`);
  }
  if (!hasEvidence(e.provenance)) {
    return fail("missing_provenance", `${e.ref} needs a recorder, a time and evidence`);
  }
  if (byRef(l, e.ref)) {
    return fail("duplicate_reference", `${e.ref} is already booked in this project`);
  }

  switch (e.kind) {
    case "receipt_settled":
      if (e.invoiceRef !== null) {
        const inv = byRef(l, e.invoiceRef);
        if (!inv || inv.kind !== "invoice_issued") {
          return fail("unknown_reference", `invoice ${e.invoiceRef} not found`);
        }
        if (e.amount > invoiceOutstanding(l, e.invoiceRef)) {
          return fail(
            "over_settlement",
            `receipt ${e.ref} exceeds invoice ${e.invoiceRef} outstanding`,
          );
        }
      }
      break;
    case "invoice_written_off": {
      const inv = byRef(l, e.invoiceRef);
      if (!inv || inv.kind !== "invoice_issued") {
        return fail("unknown_reference", `invoice ${e.invoiceRef} not found`);
      }
      if (e.amount > invoiceOutstanding(l, e.invoiceRef)) {
        return fail("over_settlement", `write-off ${e.ref} exceeds invoice outstanding`);
      }
      break;
    }
    case "expense_paid":
      if (e.accruedRef !== null) {
        const acc = byRef(l, e.accruedRef);
        if (!acc || acc.kind !== "expense_accrued") {
          return fail("unknown_reference", `accrual ${e.accruedRef} not found`);
        }
        if (e.amount > accrualOutstanding(l, e.accruedRef)) {
          return fail("over_settlement", `payment ${e.ref} exceeds accrual outstanding`);
        }
      }
      break;
    case "obligation_due":
      if (!Number.isInteger(e.rank) || e.rank < 1) {
        return fail(
          "unknown_reference",
          "obligation rank must be a positive integer (1 = most senior)",
        );
      }
      break;
    case "obligation_paid": {
      const ob = byRef(l, e.obligationRef);
      if (!ob || ob.kind !== "obligation_due") {
        return fail("unknown_reference", `obligation ${e.obligationRef} not found`);
      }
      if (e.amount > obligationOutstanding(l, e.obligationRef)) {
        return fail("over_settlement", `payment ${e.ref} exceeds obligation outstanding`);
      }
      break;
    }
    case "reserve_release":
      if (!e.authorisedBy.trim()) {
        return fail("unauthorised_release", "a reserve release needs a named authoriser");
      }
      if (e.amount > reserveBalance(l, e.reserve)) {
        return fail(
          "reserve_insufficient",
          `release ${e.ref} exceeds reserve ${e.reserve} balance`,
        );
      }
      break;
    default:
      break;
  }

  return ok({ ...l, entries: [...l.entries, e] });
}

/** Post several entries atomically: all or none. */
export function postAll(l: ProjectLedger, es: readonly EntryInput[]): Result<ProjectLedger> {
  let cur = l;
  for (const e of es) {
    const r = post(cur, e);
    if (!r.ok) return r;
    cur = r.value;
  }
  return ok(cur);
}

export const entriesIn = (l: ProjectLedger, periodId: string) =>
  l.entries.filter((e) => e.periodId === periodId);
