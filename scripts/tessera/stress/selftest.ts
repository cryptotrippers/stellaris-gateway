/**
 * Unit tests for the 2.8 stress model. No network, no keys.
 *
 *   npx tsx scripts/tessera/stress/selftest.ts
 *
 * Part 1 replays the vectors of the Aiken tests in
 * contracts/tessera/lib/tessera/queue_state.ak against rules.ts (bucket and
 * payable_after math, limit floor, shard counters, tallies, suspension windows).
 * Part 2 checks the simulator invariants: determinism, conservation, caps,
 * and the block/batch bound on settlement throughput.
 */
import assert from "node:assert/strict";
import { defaults, simulate } from "./model";
import * as R from "./rules";

let n = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    n++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
const { DAY_MS, TSRA } = R;

console.log("rules vs the Aiken vectors (queue_state.ak)");
t("the_floor_is_ten_thousand_tsra_for_a_small_supply", () => {
  assert.equal(R.limitFloor(0), 10_000_000_000);
  assert.equal(R.limitFloor(500_000_000_000), 10_000_000_000);
});
t("the_floor_is_one_percent_of_a_large_supply", () => {
  assert.equal(R.limitFloor(2_000_000_000_000), 20_000_000_000);
  assert.equal(R.limitFloor(1_000_000_000_000), 10_000_000_000);
  assert.equal(R.limitFloor(1_000_000_000_100), 10_000_000_001);
});
t("the_floor_uses_whole_division", () =>
  assert.equal(R.limitFloor(1_000_000_000_099), 10_000_000_000),
);
t("limits_must_reach_the_floor_and_the_monthly_the_daily", () => {
  const f = 10_000_000_000;
  assert.ok(R.limitsOk(f, f, f));
  assert.ok(!R.limitsOk(f - 1, f, f));
  assert.ok(!R.limitsOk(f, f - 1, f));
  assert.ok(!R.limitsOk(0, 0, f));
});
t("day_and_month_windows", () => {
  assert.deepEqual(
    [
      R.dayOf(0),
      R.dayOf(DAY_MS - 1),
      R.dayOf(DAY_MS),
      R.monthOf(29),
      R.monthOf(30),
      R.monthOf(59),
      R.monthOf(60),
    ],
    [0, 0, 1, 0, 1, 1, 2],
  );
});
t("payable_after_is_the_end_of_the_bucket_plus_the_delay", () => {
  assert.equal(R.payableAfterOf(20, 2 * DAY_MS), 23 * DAY_MS);
  assert.equal(R.payableAfterOf(0, 0), DAY_MS);
});
const sh = (day: number, pd: number, month: number, pm: number): R.ShardState => ({
  day,
  paidDay: pd,
  month,
  paidMonth: pm,
});
t("a_shard_accepts_up_to_its_caps_and_not_a_unit_more", () => {
  assert.deepEqual(R.shardAfter(sh(20, 9, 0, 9), 20, 1, 10, 10), sh(20, 10, 0, 10));
  assert.equal(R.shardAfter(sh(20, 9, 0, 9), 20, 2, 10, 10), null);
  assert.deepEqual(R.shardAfter(sh(20, 0, 0, 99), 20, 1, 10, 100), sh(20, 1, 0, 100));
  assert.equal(R.shardAfter(sh(20, 0, 0, 99), 20, 2, 10, 100), null);
});
t("a_new_day_resets_the_daily_counter_only", () =>
  assert.deepEqual(R.shardAfter(sh(20, 10, 0, 50), 21, 5, 10, 100), sh(21, 5, 0, 55)),
);
t("a_new_month_resets_the_monthly_counter", () =>
  assert.deepEqual(R.shardAfter(sh(29, 0, 0, 100), 30, 5, 10, 100), sh(30, 5, 1, 5)),
);
t("a_shard_never_moves_to_an_earlier_window", () => {
  assert.equal(R.shardAfter(sh(20, 0, 0, 0), 19, 1, 10, 100), null);
  assert.equal(R.shardAfter(sh(30, 0, 1, 0), 29, 1, 10, 100), null);
});
t("tally_add_keeps_the_days_sorted_and_merges_equal_days", () => {
  const b = R.tallyAdd(R.tallyAdd([], 5, 1), 3, 2);
  const d = R.tallyAdd(R.tallyAdd(b, 9, 3), 5, 10);
  assert.deepEqual(b, [
    { day: 3, open: 2 },
    { day: 5, open: 1 },
  ]);
  assert.deepEqual(d, [
    { day: 3, open: 2 },
    { day: 5, open: 11 },
    { day: 9, open: 3 },
  ]);
  assert.ok(R.talliesSorted(d));
});
t("tally_sub_lowers_one_day_and_drops_it_at_zero", () => {
  const ts = [
    { day: 3, open: 2 },
    { day: 5, open: 11 },
    { day: 9, open: 3 },
  ];
  assert.deepEqual(R.tallySub(ts, 5, 1), [
    { day: 3, open: 2 },
    { day: 5, open: 10 },
    { day: 9, open: 3 },
  ]);
  assert.deepEqual(R.tallySub(ts, 3, 2), [
    { day: 5, open: 11 },
    { day: 9, open: 3 },
  ]);
  assert.deepEqual(R.tallySub(ts, 9, 3), [
    { day: 3, open: 2 },
    { day: 5, open: 11 },
  ]);
});
t("tally_sub_refuses_an_absent_day_or_more_than_it_holds", () => {
  const ts = [
    { day: 3, open: 2 },
    { day: 5, open: 11 },
  ];
  assert.equal(R.tallySub(ts, 4, 1), null);
  assert.equal(R.tallySub(ts, 3, 3), null);
  assert.equal(R.tallySub(ts, 6, 1), null);
  assert.equal(R.tallySub([], 1, 1), null);
});
t("tallies_must_be_strictly_increasing_and_positive", () => {
  assert.ok(R.talliesSorted([]));
  assert.ok(
    R.talliesSorted([
      { day: 1, open: 1 },
      { day: 2, open: 1 },
    ]),
  );
  assert.ok(
    !R.talliesSorted([
      { day: 2, open: 1 },
      { day: 1, open: 1 },
    ]),
  );
  assert.ok(
    !R.talliesSorted([
      { day: 1, open: 1 },
      { day: 1, open: 1 },
    ]),
  );
  assert.ok(!R.talliesSorted([{ day: 1, open: 0 }]));
  assert.ok(
    !R.talliesSorted([
      { day: 1, open: 0 },
      { day: 2, open: 1 },
    ]),
  );
});
t("the_head_day_is_the_oldest", () => {
  assert.equal(R.headDay([]), null);
  assert.equal(
    R.headDay([
      { day: 4, open: 1 },
      { day: 6, open: 1 },
    ]),
    4,
  );
});
t("a_suspension_is_bounded_in_length_and_spacing", () => {
  const lo = 10 * DAY_MS;
  assert.ok(R.canSuspend(lo, lo + 1, lo + R.MAX_SUSPEND_MS, 0));
  assert.ok(!R.canSuspend(lo, lo + 1, lo + R.MAX_SUSPEND_MS + 1, 0));
  assert.ok(!R.canSuspend(lo, lo + 1, lo + 1, 0));
  assert.ok(R.canSuspend(lo, lo + 1, lo + 2, lo - R.SUSPEND_REOPEN_GAP_MS));
  assert.ok(!R.canSuspend(lo, lo + 1, lo + 2, lo - R.SUSPEND_REOPEN_GAP_MS + 1));
  assert.ok(R.canSuspend(lo, lo + DAY_MS, lo + DAY_MS + 1, 0));
  assert.ok(!R.canSuspend(lo, lo + DAY_MS + 1, lo + DAY_MS + 2, 0));
});
t("a_suspension_is_in_force_until_its_end", () => {
  assert.ok(R.suspended(10, 9) && !R.suspended(10, 10) && !R.suspended(0, 0));
});
t("freeze: at most 7 days, 7-day gap (rules.ak can_open_freeze)", () => {
  const lo = 100 * DAY_MS;
  assert.ok(R.canOpenFreeze(lo, lo + 1, lo + R.MAX_LOSS_PENDING_MS, 0));
  assert.ok(!R.canOpenFreeze(lo, lo + 1, lo + R.MAX_LOSS_PENDING_MS + 1, 0));
  assert.ok(!R.canOpenFreeze(lo, lo + 1, lo + 2, lo - R.LOSS_REOPEN_GAP_MS + 1));
});
t("per-shard cap is the global limit over the shard count (queue_flow.ak)", () =>
  assert.equal(R.shardCap(50_000 * TSRA, 4), 12_500 * TSRA),
);

console.log("simulator invariants");
const prof = [0.1, 0.1, 0.1, 0.1, 0.1];
const base = { ...defaults(), profile: prof, tvl: 1_000_000 };
t("deterministic: the same params give the same result", () => {
  assert.deepEqual(simulate(base), simulate({ ...base }));
});
t("conservation: paid + unpaid equals demand", () => {
  for (const raise of [null, 12, 24, 48]) {
    const r = simulate({ ...base, raiseAfterH: raise });
    assert.ok(
      Math.abs(r.paid + r.unpaid - r.demand) < 1e-3,
      `raise ${raise}: ${r.paid} + ${r.unpaid} != ${r.demand}`,
    );
  }
});
t("demand equals the profile (up to sub-minimum dust)", () => {
  const r = simulate(base);
  assert.ok(Math.abs(r.demand - 0.5 * 1_000_000) < 100);
});
t("with no raise, payments in the first 30-day block never exceed the monthly limit", () => {
  const r = simulate({ ...base, raiseAfterH: null, profile: [0.3], tailDays: 20 });
  assert.ok(r.paid <= 500_000 + 1e-6, `paid ${r.paid}`);
});
t("no queued request is paid before payable_after (median queued wait >= settle delay)", () => {
  const r = simulate({ ...base, raiseAfterH: 24 });
  assert.ok(r.waitP50Days >= 2, `median queued wait ${r.waitP50Days} d < settle delay`);
});
t("settlement throughput stays inside the block and batch bound", () => {
  const r = simulate({ ...base, sizeMode: "tiny", raiseAfterH: 24 });
  const perHour = Math.floor(180 * 1 * 0.5) * 4; // txs a keeper can land per hour across 4 shards
  assert.ok(r.maxSettleTxPerHour <= perHour, `${r.maxSettleTxPerHour} > ${perHour}`);
});
t("a longer loss freeze cannot shorten the worst wait", () => {
  const a = simulate({ ...base, raiseAfterH: 24, loss: { pct: 0.02, atDay: 2, freezeDays: 1 } });
  const b = simulate({ ...base, raiseAfterH: 24, loss: { pct: 0.02, atDay: 2, freezeDays: 7 } });
  assert.ok(b.maxWaitDays >= a.maxWaitDays);
});
t("short mode, when entered, lasts at least the registration window", () => {
  const r = simulate({ ...base, raiseAfterH: null, profile: [0.3], tailDays: 40 });
  if (r.shortEntries > 0) assert.ok(r.shortDays >= 1);
});
console.log(`\n${n} tests passed.`);
