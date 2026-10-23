import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attestationState,
  DAY_MS,
  firstLossCapPercent,
  LIVE_REFETCH_MS,
  ratioPercent,
  shardDailyUsage,
  vestingPercent,
} from "./tessera-live-display";

test("live snapshots refresh every 60 seconds", () => assert.equal(LIVE_REFETCH_MS, 60_000));
test("first loss balance is compared to three percent of minted supply", () => {
  assert.equal(firstLossCapPercent("15000000", "1000000000"), 50);
  assert.equal(firstLossCapPercent("30000000", "1000000000"), 100);
  assert.equal(firstLossCapPercent("1", "0"), null);
});
test("large token ratios retain bigint precision", () => {
  assert.equal(ratioPercent(9007199254740993000000n, 18014398509481986000000n), 50);
});
test("attestation warns below 24 hours and expires exactly at the deadline", () => {
  assert.equal(attestationState(DAY_MS, 0), "fresh");
  assert.equal(attestationState(DAY_MS - 1, 0), "warning");
  assert.equal(attestationState(0, 0), "expired");
});
test("paid today resets at UTC midnight and daily cap is per shard", () => {
  assert.deepEqual(shardDailyUsage(10, "5000000", "40000000", 4, 10 * DAY_MS), {
    paid: 5000000n,
    cap: 10000000n,
  });
  assert.deepEqual(shardDailyUsage(10, "5000000", "40000000", 4, 11 * DAY_MS), {
    paid: 0n,
    cap: 10000000n,
  });
});
test("vesting progresses between timestamps and clamps at its endpoints", () => {
  assert.equal(vestingPercent(100, 200, 50), 0);
  assert.equal(vestingPercent(100, 200, 150), 50);
  assert.equal(vestingPercent(100, 200, 250), 100);
});
