// E06 — self-tests for the fraction_vault v2 Settle budget gate.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HEADROOM,
  KEEPER_BATCH,
  TX_LIMITS,
  assess,
  settleBudgets,
  // @ts-expect-error — plain .mjs script, no type declarations
} from "../../scripts/contracts/fv2-budget-report.mjs";

const t = (title: string, mem: number, cpu: number, status = "pass") => ({
  title,
  status,
  execution_units: { mem, cpu },
});

const report = (tests: unknown[]) => ({ modules: [{ name: "fv2_scenarios", tests }] });

test("E06: the gate uses the protocol limits, 20% headroom and a batch of 15", () => {
  assert.deepEqual(TX_LIMITS, { mem: 14_000_000, cpu: 10_000_000_000 });
  assert.equal(HEADROOM, 0.2);
  assert.equal(KEEPER_BATCH, 15);
});

test("E07: worst-order budgets are read from settle_worst_* and kept apart", () => {
  const r = report([
    t("settle_cost_15", 9_000_000, 1_000),
    t("settle_fixture_15", 1_000_000, 0),
    t("settle_worst_cost_15", 12_000_000, 1_000),
    t("settle_worst_fixture_15", 1_000_000, 0),
  ]);
  assert.deepEqual(settleBudgets(r), { 15: { mem: 8_000_000, cpu: 1_000 } });
  assert.deepEqual(settleBudgets(r, "worst"), { 15: { mem: 11_000_000, cpu: 1_000 } });
});

test("E06: script cost is the run minus the fixture", () => {
  const b = settleBudgets(
    report([
      t("settle_cost_5", 5_000_000, 2_000_000_000),
      t("settle_fixture_5", 1_000_000, 500_000_000),
    ]),
  );
  assert.deepEqual(b, { 5: { mem: 4_000_000, cpu: 1_500_000_000 } });
});

test("E06: a batch without its fixture, or a failing run, is ignored", () => {
  const b = settleBudgets(
    report([
      t("settle_cost_5", 5_000_000, 1),
      t("settle_cost_10", 9_000_000, 1, "fail"),
      t("settle_fixture_10", 1, 1),
    ]),
  );
  assert.deepEqual(b, {});
});

test("E06: the largest batch with 20% headroom on both mem and cpu sets the size", () => {
  const { rows, maxBatch } = assess({
    10: { mem: 5_000_000, cpu: 1_000_000_000 },
    20: { mem: 11_200_000, cpu: 2_000_000_000 }, // exactly 80% mem
    25: { mem: 11_000_000, cpu: 8_000_000_001 }, // cpu over 80%
  });
  assert.equal(maxBatch, 20);
  assert.deepEqual(
    rows.map((r: { n: number; ok: boolean }) => [r.n, r.ok]),
    [
      [10, true],
      [20, true],
      [25, false],
    ],
  );
});
