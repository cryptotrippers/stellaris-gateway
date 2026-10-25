/**
 * Test fixtures for the Meridian ledger. Hypothetical data only: no real
 * project, investor or bank record. Amounts are AUD cents.
 */
import {
  approvePeriod,
  closePeriod,
  createLedger,
  openPeriod,
  postAll,
  type EntryInput,
  type ProjectLedger,
} from "../financial-ledger.shared";
import { createSnapshot, type OwnershipSnapshot } from "../distribution-entitlement.shared";
import type { Provenance, Result } from "../provenance.shared";

export const PROJECT = "solar-farm-alpha";
export const AUD = "AUD";
export const P1 = "FY2027";
export const UNITS = 1_000n;
export const ISSUE_PRICE = 100_000n; // AUD 1,000 per unit

export const prov = (doc = "doc-1"): Provenance => ({
  kind: "bank_statement",
  documentId: doc,
  sha256: "0".repeat(64),
  txHash: null,
  recordedBy: "test-operator",
  recordedAt: "2027-07-01T00:00:00Z",
});

export function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

export const fresh = (periods: readonly string[] = [P1]): ProjectLedger => {
  let l = must(createLedger(PROJECT, AUD));
  for (const id of periods)
    l = must(openPeriod(l, { id, startsOn: "2026-07-01", endsOn: "2027-06-30" }));
  return l;
};

const base = (ref: string, amount: bigint, periodId = P1) => ({
  ref,
  amount,
  periodId,
  provenance: prov(ref),
});

export const invoice = (ref: string, amount: bigint, periodId = P1): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "invoice_issued",
  counterparty: "offtaker",
});
export const receipt = (
  ref: string,
  amount: bigint,
  invoiceRef: string | null = null,
  periodId = P1,
): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "receipt_settled",
  invoiceRef,
});
export const opex = (ref: string, amount: bigint, periodId = P1): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "expense_accrued",
  category: "operations",
});
export const opexPaid = (
  ref: string,
  amount: bigint,
  accruedRef: string | null,
  periodId = P1,
): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "expense_paid",
  accruedRef,
});
export const obligation = (ref: string, amount: bigint, rank = 1, periodId = P1): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "obligation_due",
  rank,
  creditor: "senior-lender",
});
export const reserveIn = (ref: string, amount: bigint, periodId = P1): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "reserve_contribution",
  reserve: "replacement",
});
export const reserveOut = (
  ref: string,
  amount: bigint,
  authorisedBy = "trustee",
  periodId = P1,
): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "reserve_release",
  reserve: "replacement",
  authorisedBy,
});
export const valuation = (ref: string, amount: bigint, periodId = P1): EntryInput => ({
  ...base(ref, amount, periodId),
  kind: "valuation_recorded",
  method: "independent-appraisal",
});

/**
 * Meridian solar reference model, one year:
 * 240,000 electricity + 20,000 other − 140,000 obligations − 30,000 reserve = 90,000.
 */
export const solarEntries = (periodId = P1): EntryInput[] => [
  invoice("INV-ELEC-2027", 24_000_000n, periodId),
  receipt("BANK-ELEC-2027", 24_000_000n, "INV-ELEC-2027", periodId),
  invoice("INV-OTHER-2027", 2_000_000n, periodId),
  receipt("BANK-OTHER-2027", 2_000_000n, "INV-OTHER-2027", periodId),
  opex("OPEX-OM-2027", 8_000_000n, periodId),
  opex("OPEX-INS-2027", 2_000_000n, periodId),
  obligation("TAX-2027", 2_500_000n, 1, periodId),
  obligation("SERVICING-2027", 1_500_000n, 2, periodId),
  reserveIn("RES-2027", 3_000_000n, periodId),
];

export const solarLedger = (approved = true): ProjectLedger => {
  let l = must(postAll(fresh(), solarEntries()));
  if (approved) l = must(approvePeriod(must(closePeriod(l, P1)), P1, "board"));
  return l;
};

/** 1,000 units over four holders. */
export const snapshot = (periodId = P1, holdings = defaultHoldings): OwnershipSnapshot =>
  must(
    createSnapshot({
      projectId: PROJECT,
      periodId,
      recordDate: "2027-06-30",
      holdings,
      provenance: { ...prov("register"), kind: "contract" },
    }),
  );

export const defaultHoldings = [
  { holderId: "h-a", units: 500n },
  { holderId: "h-b", units: 250n },
  { holderId: "h-c", units: 150n },
  { holderId: "h-d", units: 100n },
];

export const everyoneEligible = () => true;
