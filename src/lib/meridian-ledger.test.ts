/**
 * Meridian M1 — solar reference model, the seven companion fixtures and one
 * test per Rail B invariant (I-B1 … I-B14). Run: npx tsx --test src/lib/meridian-ledger.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  approvePeriod,
  closePeriod,
  createLedger,
  idempotencyKey,
  openPeriod,
  post,
  postAll,
  reserveBalance,
} from "./financial-ledger.shared";
import { computeWaterfall, yieldBasisPoints } from "./asset-cashflow.shared";
import {
  allocate,
  approveDistribution,
  confirmFunding,
  createSnapshot,
  entitlementTotal,
  forecastDistribution,
  fundedTotal,
  paidTotal,
  payEntitlement,
  type Distribution,
} from "./distribution-entitlement.shared";
import {
  commitIfCurrent,
  fromMinorString,
  toMinorString,
  versioned,
  money,
} from "./provenance.shared";
import {
  AUD,
  ISSUE_PRICE,
  P1,
  PROJECT,
  UNITS,
  everyoneEligible,
  fresh,
  invoice,
  must,
  obligation,
  opex,
  opexPaid,
  prov,
  receipt,
  reserveIn,
  reserveOut,
  snapshot,
  solarEntries,
  solarLedger,
  valuation,
} from "./__fixtures__/meridian";

const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? "ok" : r.error!.code);

const approveAll = (l = solarLedger(), amount = 9_000_000n) =>
  must(
    approveDistribution(l, [], {
      periodId: P1,
      amount,
      approvedBy: "board",
      approval: { ...prov("minutes"), kind: "reviewer_decision" },
      snapshot: snapshot(),
    }),
  );

const fundAll = (d: Distribution, amount = d.approvedAmount) =>
  must(confirmFunding(d, { fundingRef: "FUND-1", amount, provenance: prov("fund") }));

describe("solar reference model", () => {
  test("AUD 90,000 distributable, AUD 90 per unit, 9% on issue price", () => {
    const w = must(computeWaterfall(solarLedger(), P1));
    assert.equal(w.settledReceipts, 26_000_000n);
    assert.equal(w.receivables, 0n);
    assert.deepEqual(
      w.tiers.map((t) => [t.key, t.required, t.unfunded]),
      [
        ["operating_expenses", 10_000_000n, 0n],
        ["senior_obligation_rank_1", 2_500_000n, 0n],
        ["senior_obligation_rank_2", 1_500_000n, 0n],
        ["reserve_contributions", 3_000_000n, 0n],
      ],
    );
    const obligations = w.tiers
      .filter((t) => t.key !== "reserve_contributions")
      .reduce((s, t) => s + t.required, 0n);
    assert.equal(obligations, 14_000_000n);
    assert.equal(w.distributable, 9_000_000n);
    assert.equal(w.shortfall, 0n);
    const perUnit = w.distributable / UNITS;
    assert.equal(perUnit, 9_000n);
    assert.equal(yieldBasisPoints(perUnit, ISSUE_PRICE), 900n);
  });

  test("full lifecycle forecast → approved → funded → paid", () => {
    const open = solarLedger(false);
    const fc = must(forecastDistribution(open, P1));
    assert.equal(fc.status, "forecast");
    assert.equal(fc.estimatedDistributable, 9_000_000n);
    let d = approveAll();
    assert.equal(d.status, "approved");
    assert.equal(d.entitlements.get("h-a"), 4_500_000n);
    d = fundAll(d);
    assert.equal(d.status, "funded");
    for (const h of ["h-a", "h-b", "h-c", "h-d"])
      d = must(payEntitlement(d, h, `SETTLE-${h}`, prov(h), everyoneEligible));
    assert.equal(d.status, "paid");
    assert.equal(paidTotal(d), 9_000_000n);
  });

  test("traceability: every tier lists its source references", () => {
    const w = must(computeWaterfall(solarLedger(), P1));
    assert.deepEqual(w.receiptRefs, ["BANK-ELEC-2027", "BANK-OTHER-2027"]);
    assert.deepEqual(w.tiers[0].refs, ["OPEX-OM-2027", "OPEX-INS-2027"]);
  });
});

describe("companion fixtures", () => {
  test("F1 remainder: 9,000,001 over 1,000 equal units → 9,000 each, 1 carried", () => {
    const snap = must(
      createSnapshot({
        projectId: PROJECT,
        periodId: P1,
        recordDate: "2027-06-30",
        holdings: Array.from({ length: 1000 }, (_, i) => ({ holderId: `u${i}`, units: 1n })),
        provenance: prov("register"),
      }),
    );
    const a = allocate(9_000_001n, snap);
    assert.ok([...a.entitlements.values()].every((v) => v === 9_000n));
    assert.equal(a.remainder, 1n);
    assert.equal(a.allocated + a.remainder, 9_000_001n);
  });

  test("F2 odd split: 100 over three equal holders → 33 each, 1 carried", () => {
    const snap = must(
      createSnapshot({
        projectId: PROJECT,
        periodId: P1,
        recordDate: "2027-06-30",
        holdings: ["x", "y", "z"].map((holderId) => ({ holderId, units: 1n })),
        provenance: prov("register"),
      }),
    );
    const a = allocate(100n, snap);
    assert.deepEqual([...a.entitlements.values()], [33n, 33n, 33n]);
    assert.equal(a.remainder, 1n);
  });

  test("F3 unpaid invoice: AUD 20,000 unpaid → distributable AUD 70,000, receivable shown", () => {
    const entries = solarEntries().filter((e) => e.ref !== "BANK-OTHER-2027");
    const w = must(computeWaterfall(must(postAll(fresh(), entries)), P1));
    assert.equal(w.distributable, 7_000_000n);
    assert.equal(w.receivables, 2_000_000n);
    assert.deepEqual(w.receivableRefs, ["INV-OTHER-2027"]);
  });

  test("F4 shortfall: receipts 130k vs 170k needed → distributable 0, shortfall 40k", () => {
    const l = must(
      postAll(fresh(), [
        receipt("BANK-1", 13_000_000n),
        opex("OPEX-1", 10_000_000n),
        obligation("OB-1", 4_000_000n),
        reserveIn("RES-1", 3_000_000n),
      ]),
    );
    const w = must(computeWaterfall(l, P1));
    assert.equal(w.distributable, 0n);
    assert.equal(w.shortfall, 4_000_000n);
    // Waterfall order: expenses, then obligations funded first; reserve tier takes the gap.
    assert.deepEqual(
      w.tiers.map((t) => t.unfunded),
      [0n, 1_000_000n, 3_000_000n],
    );
  });

  test("F5 duplicate receipt reference is rejected and the ledger is unchanged", () => {
    const l = must(post(fresh(), receipt("BANK-1", 100n)));
    const r = post(l, receipt("BANK-1", 100n));
    assert.equal(errCode(r), "duplicate_reference");
    assert.equal(l.entries.length, 1);
  });

  test("F6 ownership change after the record date does not affect a closed distribution", () => {
    let d = approveAll();
    const before = new Map(d.entitlements);
    // h-a sells to h-e after the record date: a new snapshot for the NEXT period.
    const later = snapshot("FY2028", [
      { holderId: "h-e", units: 500n },
      { holderId: "h-b", units: 250n },
      { holderId: "h-c", units: 150n },
      { holderId: "h-d", units: 100n },
    ]);
    assert.equal(later.periodId, "FY2028");
    d = fundAll(d);
    assert.deepEqual(new Map(d.entitlements), before);
    assert.equal(
      errCode(payEntitlement(d, "h-e", "S-e", prov(), everyoneEligible)),
      "not_in_snapshot",
    );
    assert.equal(d.entitlements.get("h-a"), 4_500_000n);
    assert.throws(() => (d.snapshot.holdings as unknown as unknown[]).push({}));
  });

  test("F7 stale report: an approved period is immutable; corrections go to an adjustment period", () => {
    let l = solarLedger();
    assert.equal(errCode(post(l, receipt("BANK-LATE", 500_000n))), "period_not_open");
    l = must(
      openPeriod(l, {
        id: "FY2027-ADJ1",
        startsOn: "2027-07-01",
        endsOn: "2027-07-31",
        adjustsPeriodId: P1,
      }),
    );
    l = must(post(l, receipt("BANK-LATE", 500_000n, null, "FY2027-ADJ1")));
    assert.equal(must(computeWaterfall(l, P1)).distributable, 9_000_000n);
    assert.equal(must(computeWaterfall(l, "FY2027-ADJ1")).distributable, 500_000n);
  });
});

describe("Rail B invariants", () => {
  test("I-B1 approved distribution ≤ distributable cash under the waterfall", () => {
    const r = approveDistribution(solarLedger(), [], {
      periodId: P1,
      amount: 9_000_001n,
      approvedBy: "board",
      approval: prov("minutes"),
      snapshot: snapshot(),
    });
    assert.equal(errCode(r), "exceeds_distributable");
  });

  test("I-B2 Σ entitlements ≤ approved, remainder carried", () => {
    const d = approveAll(solarLedger(), 8_999_999n);
    assert.ok(entitlementTotal(d) <= d.approvedAmount);
    assert.equal(entitlementTotal(d) + d.remainder, d.approvedAmount);
  });

  test("I-B3 Σ settled payments ≤ funded", () => {
    let d = fundAll(approveAll(), 4_500_000n); // enough for h-a only
    d = must(payEntitlement(d, "h-a", "S-a", prov(), everyoneEligible));
    assert.equal(
      errCode(payEntitlement(d, "h-b", "S-b", prov(), everyoneEligible)),
      "exceeds_funded",
    );
    assert.ok(paidTotal(d) <= fundedTotal(d));
    assert.equal(
      errCode(confirmFunding(d, { fundingRef: "F2", amount: 4_500_001n, provenance: prov() })),
      "exceeds_approved",
    );
  });

  test("I-B4 the same receipt cannot fund two periods", () => {
    const l = must(post(fresh([P1, "FY2028"]), receipt("BANK-1", 1_000n)));
    assert.equal(
      errCode(post(l, receipt("BANK-1", 1_000n, null, "FY2028"))),
      "duplicate_reference",
    );
  });

  test("I-B5 entitlement depends on the authorised ownership snapshot", () => {
    const d = fundAll(approveAll());
    assert.equal(
      errCode(payEntitlement(d, "stranger", "S-x", prov(), everyoneEligible)),
      "not_in_snapshot",
    );
    const wrong = snapshot("FY2099");
    const r = approveDistribution(solarLedger(), [], {
      periodId: P1,
      amount: 1n,
      approvedBy: "board",
      approval: prov(),
      snapshot: wrong,
    });
    assert.equal(errCode(r), "invalid_snapshot");
    assert.equal(
      errCode(
        createSnapshot({
          projectId: PROJECT,
          periodId: P1,
          recordDate: "x",
          holdings: [
            { holderId: "a", units: 1n },
            { holderId: "a", units: 1n },
          ],
          provenance: prov(),
        }),
      ),
      "invalid_snapshot",
    );
  });

  test("I-B6 a holder cannot collect the same entitlement twice", () => {
    let d = fundAll(approveAll());
    d = must(payEntitlement(d, "h-a", "S-a", prov(), everyoneEligible));
    assert.equal(
      errCode(payEntitlement(d, "h-a", "S-a2", prov(), everyoneEligible)),
      "already_paid",
    );
  });

  test("I-B7 restricted reserves are never distributable", () => {
    let l = solarLedger();
    l = must(openPeriod(l, { id: "FY2028", startsOn: "2027-07-01", endsOn: "2028-06-30" }));
    l = must(
      postAll(l, [
        receipt("BANK-28", 1_000_000n, null, "FY2028"),
        reserveOut("REL-28", 3_000_000n, "trustee", "FY2028"),
      ]),
    );
    const w = must(computeWaterfall(l, "FY2028"));
    assert.equal(w.distributable, 1_000_000n);
    assert.equal(w.reserveReleased, 3_000_000n);
    assert.equal(w.reserveReleaseUnapplied, 3_000_000n);
    // A release may cover an expense shortfall instead.
    l = must(post(l, opex("OPEX-28", 2_000_000n, "FY2028")));
    const w2 = must(computeWaterfall(l, "FY2028"));
    assert.equal(w2.distributable, 0n);
    assert.equal(w2.tiers[0].fundedFromReserve, 1_000_000n);
    assert.equal(w2.shortfall, 0n);
    assert.equal(
      errCode(post(l, reserveOut("REL-29", 1n, "trustee", "FY2028"))),
      "reserve_insufficient",
    );
    assert.equal(errCode(post(l, reserveOut("REL-30", 1n, " ", "FY2028"))), "unauthorised_release");
    assert.equal(reserveBalance(l), 0n);
  });

  test("I-B8 duplicate expense and obligation events are rejected", () => {
    const l = must(postAll(fresh(), [opex("E-1", 10n), obligation("O-1", 10n)]));
    assert.equal(errCode(post(l, opex("E-1", 10n))), "duplicate_reference");
    assert.equal(errCode(post(l, obligation("O-1", 10n))), "duplicate_reference");
    // An accrual's payment is reconciled, not double counted.
    const paid = must(post(l, opexPaid("PAY-E-1", 10n, "E-1")));
    assert.equal(must(computeWaterfall(paid, P1)).tiers[0].required, 10n);
    assert.equal(errCode(post(paid, opexPaid("PAY-E-1b", 1n, "E-1"))), "over_settlement");
    assert.equal(
      idempotencyKey(PROJECT, { periodId: P1, kind: "expense_accrued", ref: "E-1" }),
      `${PROJECT}:${P1}:expense_accrued:E-1`,
    );
  });

  test("I-B9 project liabilities and cash never cross into Rail A", () => {
    assert.equal(errCode(createLedger("tessera:reserve", AUD)), "cross_rail_reference");
    assert.equal(errCode(createLedger(PROJECT, "TSRA")), "cross_rail_reference");
    assert.equal(errCode(createLedger(PROJECT, "sTSRA")), "cross_rail_reference");
    assert.equal(
      errCode(post(fresh(), obligation("tessera:mint-cap", 10n))),
      "cross_rail_reference",
    );
  });

  test("I-B10 unpaid invoices and valuations are not distributable cash", () => {
    const l = must(
      postAll(fresh(), [invoice("INV-1", 1_000_000n), valuation("VAL-1", 50_000_000n)]),
    );
    const w = must(computeWaterfall(l, P1));
    assert.equal(w.distributable, 0n);
    assert.equal(w.receivables, 1_000_000n);
    assert.equal(w.valuationRecorded, 50_000_000n);
  });

  test("I-B11 approved periods are immutable", () => {
    const l = solarLedger();
    assert.equal(errCode(post(l, opex("LATE", 1n))), "period_not_open");
    assert.equal(errCode(closePeriod(l, P1)), "wrong_status");
    assert.equal(errCode(approvePeriod(l, P1, "board")), "wrong_status");
  });

  test("I-B12 every record carries provenance; settlements cannot over-settle", () => {
    const bad = { ...receipt("B", 1n), provenance: { ...prov(), documentId: null, sha256: null } };
    assert.equal(errCode(post(fresh(), bad)), "missing_provenance");
    const l = must(post(fresh(), invoice("INV-1", 100n)));
    assert.equal(errCode(post(l, receipt("B-1", 101n, "INV-1"))), "over_settlement");
    assert.equal(errCode(post(l, receipt("B-2", 1n, "INV-NOPE"))), "unknown_reference");
    assert.equal(errCode(post(fresh(), receipt("B-3", 0n))), "non_positive_amount");
    assert.equal(errCode(post(fresh(), receipt("B-4", -5n))), "non_positive_amount");
  });

  test("I-B13 one distribution per period; only from an approved period", () => {
    const d = approveAll();
    const again = approveDistribution(solarLedger(), [d], {
      periodId: P1,
      amount: 1n,
      approvedBy: "board",
      approval: prov(),
      snapshot: snapshot(),
    });
    assert.equal(errCode(again), "distribution_exists");
    const unapproved = approveDistribution(solarLedger(false), [], {
      periodId: P1,
      amount: 1n,
      approvedBy: "board",
      approval: prov(),
      snapshot: snapshot(),
    });
    assert.equal(errCode(unapproved), "period_not_approved");
  });

  test("I-B14 forecasts are not payable and cannot pose as approvals", () => {
    const fc = must(forecastDistribution(solarLedger(false), P1));
    assert.equal(fc.status, "forecast");
    assert.equal("entitlements" in fc, false);
    assert.equal(errCode(forecastDistribution(solarLedger(), P1)), "wrong_status");
    const d = approveAll();
    assert.equal(errCode(payEntitlement(d, "h-a", "S", prov(), everyoneEligible)), "wrong_status");
    assert.equal(
      errCode(payEntitlement(fundAll(d), "h-a", "S", prov(), () => false)),
      "ineligible_holder",
    );
  });
});

describe("concurrency and money encoding", () => {
  test("two payouts computed from the same state: only one commits", () => {
    const cell = versioned(fundAll(approveAll()));
    const v = cell.version;
    const a = must(payEntitlement(cell.value, "h-a", "S-1", prov(), everyoneEligible));
    const b = must(payEntitlement(cell.value, "h-a", "S-2", prov(), everyoneEligible));
    const first = must(commitIfCurrent(cell, v, a));
    assert.equal(errCode(commitIfCurrent(first, v, b)), "version_conflict");
    // Retrying against the new state is refused on the merits.
    assert.equal(
      errCode(payEntitlement(first.value, "h-a", "S-2", prov(), everyoneEligible)),
      "already_paid",
    );
  });

  test("minor-unit strings round-trip and refuse decimals", () => {
    assert.equal(toMinorString(money(9_000_000n, AUD)), "9000000");
    assert.equal(fromMinorString("9000000", AUD).amount, 9_000_000n);
    assert.throws(() => fromMinorString("90.00", AUD));
    assert.throws(() => fromMinorString("1e6", AUD));
  });
});
