import { test } from "node:test";
import assert from "node:assert/strict";
import { addDaysMs, formatLocalAndUtc } from "./format-time";

test("shows Sydney local time and UTC for the same moment", () => {
  const s = formatLocalAndUtc(Date.UTC(2026, 10, 3, 3, 30), "Australia/Sydney");
  assert.ok(s.includes("14:30 your time"), s);
  assert.ok(s.endsWith("03:30 UTC"), s);
});

test("a 7-day cooldown ends exactly 7 days later", () => {
  assert.equal(addDaysMs(0, 7), 604_800_000);
});

test("bad input is labelled, not shown as Invalid Date", () => {
  assert.equal(formatLocalAndUtc("nope"), "time not available");
});
