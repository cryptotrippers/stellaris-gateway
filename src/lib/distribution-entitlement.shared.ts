/**
 * Project Meridian — distributions and unit-holder entitlements (Phase 3).
 *
 * Lifecycle: forecast → approved → funded → paid.
 *  - A FORECAST is a view over an unapproved period. It has no entitlements
 *    and nothing can be paid against it.
 *  - APPROVED needs an approved period, provenance, an amount no greater than
 *    the period's distributable cash (I-B1) and no earlier distribution for
 *    the same period (I-B13). Entitlements are fixed at approval from an
 *    immutable ownership snapshot (I-B5), floored per holder with the
 *    remainder carried, so Σ entitlements ≤ approved (I-B2).
 *  - FUNDED records cash actually set aside, cumulatively ≤ approved.
 *  - PAID once every entitlement is settled. Each holder is paid at most once
 *    (I-B6), only if in the snapshot and eligible, with a settlement reference,
 *    and Σ paid ≤ funded (I-B3).
 *
 * Ownership changes after the record date create a new snapshot for a later
 * period; they never touch a closed distribution.
 */

import { computeWaterfall } from "./asset-cashflow.shared";
import { findPeriod, type ProjectLedger } from "./financial-ledger.shared";
import {
  fail,
  hasEvidence,
  ok,
  type CurrencyCode,
  type Provenance,
  type Result,
} from "./provenance.shared";

export type DistributionStatus = "forecast" | "approved" | "funded" | "paid";

export interface Holding {
  readonly holderId: string;
  readonly units: bigint;
}

export interface OwnershipSnapshot {
  readonly projectId: string;
  readonly periodId: string;
  /** ISO date; ownership as legally recorded at this date. */
  readonly recordDate: string;
  readonly holdings: readonly Holding[];
  readonly totalUnits: bigint;
  readonly provenance: Provenance;
}

export function createSnapshot(
  input: Omit<OwnershipSnapshot, "totalUnits">,
): Result<OwnershipSnapshot> {
  if (!hasEvidence(input.provenance)) {
    return fail("missing_provenance", "a snapshot must cite the register it was taken from");
  }
  if (input.holdings.length === 0) return fail("invalid_snapshot", "snapshot has no holders");
  const seen = new Set<string>();
  let total = 0n;
  for (const h of input.holdings) {
    if (!h.holderId.trim()) return fail("invalid_snapshot", "holder id is required");
    if (seen.has(h.holderId)) return fail("invalid_snapshot", `holder ${h.holderId} appears twice`);
    if (h.units <= 0n) return fail("invalid_snapshot", `holder ${h.holderId} has no units`);
    seen.add(h.holderId);
    total += h.units;
  }
  const holdings = Object.freeze(input.holdings.map((h) => Object.freeze({ ...h })));
  return ok(Object.freeze({ ...input, holdings, totalUnits: total }));
}

export interface Allocation {
  readonly entitlements: ReadonlyMap<string, bigint>;
  readonly allocated: bigint;
  /** Carried forward to the next period; never paid out in this one. */
  readonly remainder: bigint;
}

/** Per-holder floor of amount × units / totalUnits; the remainder is carried (D4). */
export function allocate(amount: bigint, snap: OwnershipSnapshot): Allocation {
  const entitlements = new Map<string, bigint>();
  let allocated = 0n;
  for (const h of snap.holdings) {
    const share = (amount * h.units) / snap.totalUnits;
    entitlements.set(h.holderId, share);
    allocated += share;
  }
  return { entitlements, allocated, remainder: amount - allocated };
}

export interface Payment {
  readonly holderId: string;
  readonly amount: bigint;
  readonly settlementRef: string;
  readonly provenance: Provenance;
}

export interface Funding {
  readonly fundingRef: string;
  readonly amount: bigint;
  readonly provenance: Provenance;
}

export interface Distribution {
  readonly projectId: string;
  readonly periodId: string;
  readonly currency: CurrencyCode;
  readonly status: Exclude<DistributionStatus, "forecast">;
  readonly approvedAmount: bigint;
  readonly approvedBy: string;
  readonly approval: Provenance;
  readonly snapshot: OwnershipSnapshot;
  readonly entitlements: ReadonlyMap<string, bigint>;
  readonly remainder: bigint;
  readonly fundings: readonly Funding[];
  readonly payments: readonly Payment[];
}

export interface DistributionForecast {
  readonly projectId: string;
  readonly periodId: string;
  readonly currency: CurrencyCode;
  readonly status: "forecast";
  /** Estimate only: the period is not approved and nothing is payable. */
  readonly estimatedDistributable: bigint;
  readonly basis: "unapproved_period";
}

export const fundedTotal = (d: Distribution) => d.fundings.reduce((s, f) => s + f.amount, 0n);
export const paidTotal = (d: Distribution) => d.payments.reduce((s, p) => s + p.amount, 0n);
export const entitlementTotal = (d: Distribution) =>
  [...d.entitlements.values()].reduce((s, v) => s + v, 0n);

export function forecastDistribution(
  l: ProjectLedger,
  periodId: string,
): Result<DistributionForecast> {
  const w = computeWaterfall(l, periodId);
  if (!w.ok) return w;
  if (w.value.periodStatus === "approved") {
    return fail(
      "wrong_status",
      "period is approved; approve a distribution instead of forecasting",
    );
  }
  return ok({
    projectId: l.projectId,
    periodId,
    currency: l.currency,
    status: "forecast",
    estimatedDistributable: w.value.distributable,
    basis: "unapproved_period",
  });
}

export function approveDistribution(
  l: ProjectLedger,
  existing: readonly Distribution[],
  input: {
    periodId: string;
    amount: bigint;
    approvedBy: string;
    approval: Provenance;
    snapshot: OwnershipSnapshot;
  },
): Result<Distribution> {
  const period = findPeriod(l, input.periodId);
  if (!period) return fail("unknown_period", `period ${input.periodId} does not exist`);
  if (period.status !== "approved") {
    return fail("period_not_approved", "distributions are approved only from an approved period");
  }
  if (!input.approvedBy.trim() || !hasEvidence(input.approval)) {
    return fail("missing_provenance", "a distribution needs a named approver and evidence");
  }
  if (input.amount <= 0n)
    return fail("non_positive_amount", "distribution amount must be positive");
  if (existing.some((d) => d.projectId === l.projectId && d.periodId === input.periodId)) {
    return fail("distribution_exists", `period ${input.periodId} already has a distribution`);
  }
  const snap = input.snapshot;
  if (snap.projectId !== l.projectId || snap.periodId !== input.periodId) {
    return fail("invalid_snapshot", "snapshot belongs to a different project or period");
  }
  const w = computeWaterfall(l, input.periodId);
  if (!w.ok) return w;
  if (input.amount > w.value.distributable) {
    return fail(
      "exceeds_distributable",
      `approved ${input.amount} exceeds distributable ${w.value.distributable}`,
    );
  }
  const a = allocate(input.amount, snap);
  return ok({
    projectId: l.projectId,
    periodId: input.periodId,
    currency: l.currency,
    status: "approved",
    approvedAmount: input.amount,
    approvedBy: input.approvedBy,
    approval: input.approval,
    snapshot: snap,
    entitlements: a.entitlements,
    remainder: a.remainder,
    fundings: [],
    payments: [],
  });
}

/** Record cash set aside for the distribution (cumulative ≤ approved). */
export function confirmFunding(d: Distribution, f: Funding): Result<Distribution> {
  if (d.status === "paid") return fail("wrong_status", "distribution is already paid");
  if (f.amount <= 0n) return fail("non_positive_amount", "funding must be positive");
  if (!f.fundingRef.trim() || !hasEvidence(f.provenance)) {
    return fail("missing_provenance", "funding needs a reference and evidence");
  }
  if (d.fundings.some((x) => x.fundingRef === f.fundingRef)) {
    return fail("duplicate_reference", `funding ${f.fundingRef} already recorded`);
  }
  if (fundedTotal(d) + f.amount > d.approvedAmount) {
    return fail("exceeds_approved", "funding would exceed the approved amount");
  }
  return ok({ ...d, status: "funded", fundings: [...d.fundings, f] });
}

/**
 * Settle one holder's entitlement in full. `isEligible` is the current
 * eligibility decision for the holder (KYC / permitted-investor check); the
 * ledger never stores why.
 */
export function payEntitlement(
  d: Distribution,
  holderId: string,
  settlementRef: string,
  provenance: Provenance,
  isEligible: (holderId: string) => boolean,
): Result<Distribution> {
  if (d.status !== "funded") {
    return fail("wrong_status", `cannot pay a ${d.status} distribution; it must be funded`);
  }
  const owed = d.entitlements.get(holderId);
  if (owed === undefined)
    return fail("not_in_snapshot", `${holderId} is not in the ownership snapshot`);
  if (d.payments.some((p) => p.holderId === holderId)) {
    return fail("already_paid", `${holderId} has already been paid for ${d.periodId}`);
  }
  if (!isEligible(holderId))
    return fail("ineligible_holder", `${holderId} is not currently eligible`);
  if (!settlementRef.trim() || !hasEvidence(provenance)) {
    return fail("missing_provenance", "a payment needs a settlement reference and evidence");
  }
  if (d.payments.some((p) => p.settlementRef === settlementRef)) {
    return fail("duplicate_reference", `settlement ${settlementRef} already used`);
  }
  if (paidTotal(d) + owed > fundedTotal(d)) {
    return fail("exceeds_funded", "payment would exceed the funded amount");
  }
  const payments = [...d.payments, { holderId, amount: owed, settlementRef, provenance }];
  const allPaid = payments.length === d.entitlements.size;
  return ok({ ...d, payments, status: allPaid ? "paid" : "funded" });
}
