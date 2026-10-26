#!/usr/bin/env node
// Sprint 1 E16 — execution-budget regression gate.
//
// Reads the JSON that `aiken check` prints when its output is not a terminal
// and compares every unit test's memory and CPU budget with the committed
// baseline (contracts/<project>/budget-baseline.json). Any test that costs
// more than BUDGET_TOLERANCE (10%) above its baseline fails the gate, so an
// innocent-looking change can't quietly eat the execution headroom the
// validators need on-chain. New tests and tests that got cheaper pass; the
// baseline is refreshed deliberately with --write.
//
// Usage (from the repo root):
//   (cd contracts/tessera && aiken check) > check.json
//   node scripts/contracts/check-budgets.mjs contracts/tessera check.json
//   node scripts/contracts/check-budgets.mjs contracts/tessera check.json --write
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUDGET_TOLERANCE = 0.1;

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Extract { "<module>.<test>": { mem, cpu } } from `aiken check` JSON.
 * Property tests (no fixed budget) are skipped.
 */
export function extractBudgets(report) {
  const out = {};
  for (const mod of report?.modules ?? []) {
    for (const t of mod.tests ?? []) {
      const u = t.execution_units ?? t.executionUnits ?? t.budget ?? t;
      const mem = num(u?.mem);
      const cpu = num(u?.cpu);
      if (mem === null || cpu === null) continue;
      out[`${mod.name}.${t.title}`] = { mem, cpu };
    }
  }
  return out;
}

/** Compare current budgets with the baseline. */
export function compareBudgets(baseline, current, tolerance = BUDGET_TOLERANCE) {
  const regressions = [];
  for (const [name, now] of Object.entries(current)) {
    const was = baseline[name];
    if (!was) continue;
    for (const k of ["mem", "cpu"]) {
      if (now[k] > was[k] * (1 + tolerance)) {
        regressions.push({
          name,
          unit: k,
          was: was[k],
          now: now[k],
          pct: ((now[k] / was[k] - 1) * 100).toFixed(1),
        });
      }
    }
  }
  const added = Object.keys(current).filter((n) => !baseline[n]);
  const removed = Object.keys(baseline).filter((n) => !current[n]);
  return { ok: regressions.length === 0, regressions, added, removed };
}

function main(argv) {
  const write = argv.includes("--write");
  const [project, reportPath] = argv.filter((a) => a !== "--write");
  if (!project || !reportPath) {
    console.error("usage: check-budgets.mjs <contracts/project> <aiken-check.json> [--write]");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    console.error(
      `${reportPath} is not aiken check JSON — run 'aiken check' with output redirected to a file.`,
    );
    return 2;
  }
  const current = extractBudgets(report);
  const count = Object.keys(current).length;
  const baselinePath = join(project, "budget-baseline.json");
  if (count === 0) {
    // Fail only when a baseline exists (the gate is meant to be active) or a
    // baseline is being written; otherwise don't block CI on a format change.
    const msg = "No unit-test budgets found in the aiken check output (format not recognised).";
    if (write || existsSync(baselinePath)) {
      console.error(`::error::${msg}`);
      return 2;
    }
    console.log(`::warning::${msg} Budget gate inactive for ${project}.`);
    return 0;
  }
  if (write) {
    const sorted = Object.fromEntries(
      Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
    console.log(`Wrote ${count} test budgets to ${baselinePath}.`);
    return 0;
  }
  if (!existsSync(baselinePath)) {
    console.log(
      `::notice::${baselinePath} not committed yet — budget gate inactive for ${project} (${count} tests measured). Create it with --write.`,
    );
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const res = compareBudgets(baseline, current);
  for (const r of res.regressions) {
    console.log(
      `::error::${project} ${r.name}: ${r.unit} ${r.was} -> ${r.now} (+${r.pct}%, limit +${BUDGET_TOLERANCE * 100}%)`,
    );
  }
  console.log(
    `${project}: ${count} tests, ${res.regressions.length} budget regression(s), ${res.added.length} new, ${res.removed.length} removed.`,
  );
  return res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
