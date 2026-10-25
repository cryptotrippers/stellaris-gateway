/**
 * Project Meridian — contractual cash waterfall for one accounting period.
 *
 * Cash basis: only SETTLED receipts are available. Unpaid invoices appear as
 * receivables and never as distributable cash (Phase 2). Valuation entries
 * are reported separately and never enter the waterfall.
 *
 * Order (each tier funded in full before the next gets anything):
 *   1. operating expenses — accrued in the period, plus cash expenses paid in
 *      the period with no accrual (an accrual's later payment is not counted
 *      again);
 *   2. senior obligations due in the period, by rank (1 = most senior);
 *   3. restricted reserve contributions.
 * What is left is distributable; a negative remainder is an explicit
 * shortfall. Reserve releases may cover unfunded expense / obligation tiers
 * but are never distributable (I-B7).
 */

import {
  entriesIn,
  findPeriod,
  invoiceOutstanding,
  type LedgerEntry,
  type ProjectLedger,
} from "./financial-ledger.shared";
import { fail, ok, type CurrencyCode, type Result } from "./provenance.shared";

export interface WaterfallTier {
  readonly key: "operating_expenses" | `senior_obligation_rank_${number}` | "reserve_contributions";
  readonly label: string;
  readonly required: bigint;
  /** Funded from settled receipts. */
  readonly fundedFromReceipts: bigint;
  /** Funded from an authorised reserve release (never for the reserve tier). */
  readonly fundedFromReserve: bigint;
  readonly unfunded: bigint;
  /** Source references that make up `required`, for traceability. */
  readonly refs: readonly string[];
}

export interface PeriodWaterfall {
  readonly projectId: string;
  readonly periodId: string;
  readonly currency: CurrencyCode;
  readonly periodStatus: "open" | "closed" | "approved";
  readonly settledReceipts: bigint;
  readonly receiptRefs: readonly string[];
  /** Invoices issued in this period that are still outstanding (not cash). */
  readonly receivables: bigint;
  readonly receivableRefs: readonly string[];
  readonly tiers: readonly WaterfallTier[];
  readonly reserveReleased: bigint;
  /** Release not needed to cover a shortfall; stays restricted. */
  readonly reserveReleaseUnapplied: bigint;
  readonly distributable: bigint;
  readonly shortfall: bigint;
  /** Reported only; excluded from every figure above. */
  readonly valuationRecorded: bigint;
}

const sum = (es: readonly LedgerEntry[]) => es.reduce((s, e) => s + e.amount, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function computeWaterfall(l: ProjectLedger, periodId: string): Result<PeriodWaterfall> {
  const period = findPeriod(l, periodId);
  if (!period) return fail("unknown_period", `period ${periodId} does not exist`);
  const es = entriesIn(l, periodId);

  const receipts = es.filter((e) => e.kind === "receipt_settled");
  const invoices = es.filter((e) => e.kind === "invoice_issued");
  const receivableRefs = invoices
    .filter((i) => invoiceOutstanding(l, i.ref) > 0n)
    .map((i) => i.ref);
  const receivables = invoices.reduce((s, i) => s + invoiceOutstanding(l, i.ref), 0n);

  const opex = es.filter(
    (e) => e.kind === "expense_accrued" || (e.kind === "expense_paid" && e.accruedRef === null),
  );
  const obligations = es.filter((e) => e.kind === "obligation_due");
  const ranks = [
    ...new Set(obligations.map((o) => (o.kind === "obligation_due" ? o.rank : 0))),
  ].sort((a, b) => a - b);
  const contributions = es.filter((e) => e.kind === "reserve_contribution");
  const releases = es.filter((e) => e.kind === "reserve_release");

  const needs: {
    key: WaterfallTier["key"];
    label: string;
    entries: LedgerEntry[];
    reserveMayFund: boolean;
  }[] = [
    { key: "operating_expenses", label: "Operating expenses", entries: opex, reserveMayFund: true },
    ...ranks.map((r) => ({
      key: `senior_obligation_rank_${r}` as const,
      label: `Senior obligations · rank ${r}`,
      entries: obligations.filter((o) => o.kind === "obligation_due" && o.rank === r),
      reserveMayFund: true,
    })),
    {
      key: "reserve_contributions",
      label: "Restricted reserve contributions",
      entries: contributions,
      reserveMayFund: false,
    },
  ];

  const settledReceipts = sum(receipts);
  const reserveReleased = sum(releases);
  let cash = settledReceipts;
  let release = reserveReleased;

  const tiers: WaterfallTier[] = needs.map((n) => {
    const required = sum(n.entries);
    const fromReceipts = min(cash, required);
    cash -= fromReceipts;
    let fromReserve = 0n;
    if (n.reserveMayFund) {
      fromReserve = min(release, required - fromReceipts);
      release -= fromReserve;
    }
    return {
      key: n.key,
      label: n.label,
      required,
      fundedFromReceipts: fromReceipts,
      fundedFromReserve: fromReserve,
      unfunded: required - fromReceipts - fromReserve,
      refs: n.entries.map((e) => e.ref),
    };
  });

  return ok({
    projectId: l.projectId,
    periodId,
    currency: l.currency,
    periodStatus: period.status,
    settledReceipts,
    receiptRefs: receipts.map((r) => r.ref),
    receivables,
    receivableRefs,
    tiers,
    reserveReleased,
    reserveReleaseUnapplied: release,
    distributable: cash,
    shortfall: tiers.reduce((s, t) => s + t.unfunded, 0n),
    valuationRecorded: sum(es.filter((e) => e.kind === "valuation_recorded")),
  });
}

/**
 * Cash yield in basis points of an issue price, integer-floored.
 * e.g. 9,000 cents per unit on a 100,000-cent unit → 900 bp (9%).
 */
export function yieldBasisPoints(perUnit: bigint, issuePricePerUnit: bigint): bigint {
  if (issuePricePerUnit <= 0n) return 0n;
  return (perUnit * 10_000n) / issuePricePerUnit;
}
