// Sprint 2 E04 — the ledger read model and its display mapper, on the solar fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { approvePeriod, closePeriod } from "./financial-ledger.shared";
import { chainEntries, EMPTY_HEAD } from "./ledger-hash.shared";
import { periodFinancials, periodMeta, periodSummaries } from "./ledger-read.shared";
import { toMajor, toWaterfallData } from "../components/finance/ledger-mapper";
import { AUD, P1, PROJECT, must, solarEntries, solarLedger } from "./__fixtures__/meridian";

const NOW = "2027-07-02T00:00:00.000Z";
const verified = (approved: boolean) => {
  const ledger = solarLedger(approved);
  const chain = chainEntries(PROJECT, AUD, EMPTY_HEAD, solarEntries());
  const last = chain[chain.length - 1]!;
  return {
    ledger,
    head: { seq: last.seq, hash: last.entryHash },
    periods: [{ id: P1, period_root: approved ? "f".repeat(64) : null }],
  };
};

test("E04: an approved period is served as reviewed, to the cent", () => {
  const r = must(periodFinancials(verified(true), P1, NOW));
  assert.equal(r.value.distributable, "9000000");
  assert.equal(r.value.settledReceipts, "26000000");
  assert.equal(r.value.shortfall, "0");
  assert.equal(r.value.periodStatus, "approved");
  assert.equal(r.value.approvedBy, "board");
  assert.equal(r.value.periodRoot, "f".repeat(64));
  assert.equal(r.value.entryCount, 9);
  assert.equal(r.value.chainHead.seq, "9");
  assert.equal(r.meta.verification, "reviewed");
  assert.equal(r.meta.observedAt, NOW);
  assert.match(r.meta.limitation ?? "", /does not prove the evidence itself/);
  assert.ok(r.meta.provenance.length > 0 && r.meta.provenance.length <= 50);
  // JSON-safe: no bigint anywhere.
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("E04: open and closed periods are self-reported with a warning", () => {
  const open = must(periodFinancials(verified(false), P1, NOW));
  assert.equal(open.meta.verification, "self_reported");
  assert.match(open.meta.limitation ?? "", /still open/);
  const closed = periodMeta("closed", NOW, []);
  assert.match(closed.limitation ?? "", /not yet approved/);
  const l = must(closePeriod(solarLedger(false), P1));
  const v = { ...verified(false), ledger: l };
  assert.equal(must(periodFinancials(v, P1, NOW)).value.periodStatus, "closed");
  assert.equal(must(approvePeriod(l, P1, "x")).periods[0]!.status, "approved");
});

test("E04: unknown periods are refused, summaries list every period", () => {
  const r = periodFinancials(verified(true), "FY2099", NOW);
  assert.ok(!r.ok);
  assert.equal(r.error.code, "unknown_period");
  const list = periodSummaries(verified(true), NOW);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.value.distributable, "9000000");
});

test("E04 mapper: the stored solar ledger draws the same waterfall as the illustration", () => {
  const f = must(periodFinancials(verified(true), P1, NOW)).value;
  const w = toWaterfallData(f, "FY2027");
  assert.equal(w.currency, "AUD");
  assert.equal(w.steps[0]!.amount, 260_000);
  assert.equal(w.steps.at(-1)!.amount, 90_000);
  const deductions = w.steps
    .filter((s) => s.kind === "deduction")
    .reduce((a, s) => a - s.amount, 0);
  assert.equal(deductions, 170_000, "140,000 deductions + 30,000 reserve");
  for (let i = 1; i < w.steps.length - 1; i++) assert.equal(w.steps[i]!.from, w.steps[i - 1]!.to);
});

test("E04 mapper: minor units convert exactly for display", () => {
  assert.equal(toMajor("9000000"), 90_000);
  assert.equal(toMajor("5"), 0.05);
  assert.equal(toMajor("-125"), -1.25);
  assert.throws(() => toMajor("12.5"));
});
