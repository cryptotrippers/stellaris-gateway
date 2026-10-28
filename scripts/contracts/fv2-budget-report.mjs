#!/usr/bin/env node
// E06 — Settle batch budget for fraction_vault v2 (SPEC-v2.md §8).
//
// `contracts/fraction-vault/validators/fv2_scenarios.ak` has, for each batch
// size N, a test `settle_cost_N` that runs every script a Settle of N pledges
// triggers (offering_v2 spend, N pledge spends, the pledge marker burn, the
// fraction mint) and a test `settle_fixture_N` that only builds the same
// transaction. The scripts' cost is the difference.
//
// Cost depends on where the ledger puts the State among the inputs (it sorts
// them by transaction id): every pledge searches the inputs for the State.
// `settle_worst_cost_N` / `settle_worst_fixture_N` put the State LAST, the most
// expensive order. The keeper's batch size is the largest N whose WORST case
// leaves at least HEADROOM (20%) under the protocol's per-transaction limits.
// The gate fails if the batch the off-chain keeper uses (KEEPER_BATCH) no
// longer fits in the worst case.
//
// These are Aiken-evaluator figures with the transaction built inside the
// test; the E07 emulator run re-measures them on real serialised transactions.
//
// Usage (from the repo root):
//   (cd contracts/fraction-vault && aiken check) > check.json
//   node scripts/contracts/fv2-budget-report.mjs check.json
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Conway protocol limits per transaction (maxTxExecutionUnits). */
export const TX_LIMITS = { mem: 14_000_000, cpu: 10_000_000_000 };
export const HEADROOM = 0.2;
/** Pledges per Settle the keeper builds (E07); must match offering-v2-chain.ts. */
export const KEEPER_BATCH = 15;

function units(t) {
  const u = t?.execution_units ?? t?.executionUnits;
  return u && typeof u.mem === "number" && typeof u.cpu === "number" ? u : null;
}

/**
 * { N: { mem, cpu } } for every N with both a cost and a fixture test.
 * `order` "best" reads settle_cost_N, "worst" reads settle_worst_cost_N.
 */
export function settleBudgets(report, order = "best") {
  const tag = order === "worst" ? "settle_worst_" : "settle_";
  const byTitle = new Map();
  for (const m of report?.modules ?? []) for (const t of m.tests ?? []) byTitle.set(t.title, t);
  const out = {};
  for (const [title, t] of byTitle) {
    const m = new RegExp(`^${tag}cost_(\\d+)$`).exec(title);
    if (!m) continue;
    const cost = units(t);
    const base = units(byTitle.get(`${tag}fixture_${m[1]}`));
    if (!cost || !base || t.status !== "pass") continue;
    out[Number(m[1])] = { mem: cost.mem - base.mem, cpu: cost.cpu - base.cpu };
  }
  return out;
}

/** Rows with the share of each limit used, and whether 20% headroom is left. */
export function assess(budgets, limits = TX_LIMITS, headroom = HEADROOM) {
  const rows = Object.entries(budgets)
    .map(([n, b]) => {
      const memShare = b.mem / limits.mem;
      const cpuShare = b.cpu / limits.cpu;
      return {
        n: Number(n),
        ...b,
        memShare,
        cpuShare,
        ok: Math.max(memShare, cpuShare) <= 1 - headroom,
      };
    })
    .sort((a, b) => a.n - b.n);
  const fitting = rows.filter((r) => r.ok).map((r) => r.n);
  return { rows, maxBatch: fitting.length ? Math.max(...fitting) : 0 };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: fv2-budget-report.mjs <aiken-check.json>");
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(file, "utf8"));
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const results = {};
  for (const order of ["best", "worst"]) {
    const { rows, maxBatch } = assess(settleBudgets(report, order));
    results[order] = { rows, maxBatch };
    for (const r of rows) {
      console.log(
        `[fv2-budget] ${order.padEnd(5)} Settle N=${String(r.n).padStart(2)}  mem ${r.mem.toLocaleString("en-US").padStart(11)} (${pct(r.memShare)})  cpu ${r.cpu.toLocaleString("en-US").padStart(14)} (${pct(r.cpuShare)})  ${r.ok ? "ok" : "over"}`,
      );
    }
  }
  const worst = results.worst;
  if (worst.rows.length === 0) {
    console.error("[fv2-budget] no settle_worst_cost_N / settle_worst_fixture_N pairs found");
    process.exit(1);
  }
  console.log(
    `[fv2-budget] largest batch with ${HEADROOM * 100}% headroom in the worst input order: ${worst.maxBatch}; keeper uses ${KEEPER_BATCH}`,
  );
  const keeperRow = worst.rows.find((r) => r.n === KEEPER_BATCH);
  if (!keeperRow || !keeperRow.ok) {
    console.error(
      `[fv2-budget] FAIL: a Settle of ${KEEPER_BATCH} pledges no longer leaves ${HEADROOM * 100}% headroom in the worst input order`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
