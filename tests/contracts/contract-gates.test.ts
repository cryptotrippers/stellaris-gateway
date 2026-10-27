// Sprint 1 E16 — self-tests for the script-size and budget gates, so the
// gates themselves can't silently stop working.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import {
  SIZE_LIMIT,
  checkSizes,
  validatorSizes,
  // @ts-expect-error — plain .mjs script, no type declarations
} from "../../scripts/contracts/check-script-sizes.mjs";
import {
  compareBudgets,
  extractBudgets,
  // @ts-expect-error — plain .mjs script, no type declarations
} from "../../scripts/contracts/check-budgets.mjs";

const fakeBlueprint = (bytes: number) => ({
  validators: [
    { title: "big.big.spend", compiledCode: "ab".repeat(bytes) },
    { title: "big.big.else", compiledCode: "ab".repeat(bytes) },
  ],
});

test("E16: the limit is 13,000 bytes", () => {
  assert.equal(SIZE_LIMIT, 13_000);
});

test("E16: a fake oversized blueprint fails the size gate", () => {
  const res = checkSizes([{ project: "fake", blueprint: fakeBlueprint(SIZE_LIMIT + 1) }]);
  assert.equal(res.ok, false);
  assert.equal(res.rows.length, 1, "multi-purpose validator counted once");
  assert.equal(res.rows[0].headroom, -1);
});

test("E16: a validator exactly at the limit passes", () => {
  assert.equal(checkSizes([{ project: "fake", blueprint: fakeBlueprint(SIZE_LIMIT) }]).ok, true);
});

test("E16: every committed blueprint is within the limit today", () => {
  const projects = readdirSync("contracts")
    .filter((d) => existsSync(`contracts/${d}/plutus.json`))
    .map((d) => ({
      project: d,
      blueprint: JSON.parse(readFileSync(`contracts/${d}/plutus.json`, "utf8")),
    }));
  assert.ok(projects.length >= 5);
  const res = checkSizes(projects);
  assert.equal(res.ok, true, JSON.stringify(res.rows.filter((r: { ok: boolean }) => !r.ok)));
  const sizes = validatorSizes(
    JSON.parse(readFileSync("contracts/tessera/plutus.json", "utf8")),
  ) as Array<{ name: string; bytes: number }>;
  assert.ok(sizes.some((s) => s.name === "queue_admin.queue_admin"));
});

const report = (mem: number, cpu: number) => ({
  modules: [
    {
      name: "vault",
      tests: [
        { title: "deposit_ok", status: "pass", execution_units: { mem, cpu } },
        { title: "prop_never_drains", status: "pass", iterations: 100 },
      ],
    },
  ],
});

test("E16: budgets are read from aiken check JSON; property tests are skipped", () => {
  assert.deepEqual(extractBudgets(report(1000, 5000)), {
    "vault.deposit_ok": { mem: 1000, cpu: 5000 },
  });
});

test("E16: a budget regression over 10% fails; within 10% passes", () => {
  const base = extractBudgets(report(1000, 5000));
  assert.equal(compareBudgets(base, extractBudgets(report(1100, 5500))).ok, true);
  const bad = compareBudgets(base, extractBudgets(report(1101, 5000)));
  assert.equal(bad.ok, false);
  assert.equal(bad.regressions[0].unit, "mem");
  assert.equal(compareBudgets(base, extractBudgets(report(1000, 5501))).ok, false);
});

test("E16: new tests and cheaper tests pass", () => {
  const base = extractBudgets(report(1000, 5000));
  const cur = { ...extractBudgets(report(900, 4000)), "vault.new_case": { mem: 9e9, cpu: 9e9 } };
  const res = compareBudgets(base, cur);
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, ["vault.new_case"]);
});
