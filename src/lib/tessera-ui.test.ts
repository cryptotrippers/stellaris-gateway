import test from "node:test";
import assert from "node:assert/strict";
import type { TesseraLive } from "./tessera-live.shared";
import {
  amountProblem,
  formatUnits,
  instantRoom,
  parseAmount,
  payableAfterIfNow,
  quoteStake,
  quoteUnstake,
  requestMinutesLeft,
  requestsOf,
  ticketsOf,
} from "./tessera-ui.shared";

const DAY = 86_400_000;
const NOW = 20_000 * DAY + 3 * 3_600_000; // 03:00 UTC on day 20,000

function live(over: Partial<TesseraLive["queue"]> = {}): TesseraLive {
  return {
    fetchedAt: NOW,
    vault: {
      tickets: [
        { utxo: "a#1", owner: "addr_test1me", value: "400000000", claimAfter: NOW - DAY },
        { utxo: "b#1", owner: "addr_test1me", value: "5000000", claimAfter: NOW + DAY },
        { utxo: "c#1", owner: "addr_test1other", value: "1", claimAfter: NOW - DAY },
      ],
    },
    queue: {
      config: {
        settleDelayMs: 2 * DAY,
        minRequest: "100000000",
        instantMax: "10000000000",
        settleTip: "200000",
        dailyLimit: "50000000000",
        monthlyLimit: "500000000000",
        shards: 4,
        graceMs: 14 * DAY,
        suspendedUntil: 0,
      },
      shortActive: false,
      shards: [
        {
          index: 0,
          utxo: "s0",
          tusd: "19000000000",
          day: 20_000,
          paidDay: "12000000000",
          month: 666,
          paidMonth: "12000000000",
        },
        { index: 1, utxo: "s1", tusd: "0", day: 0, paidDay: "0", month: 0, paidMonth: "0" },
      ],
      requests: [
        {
          utxo: "r1",
          owner: "kme",
          payoutTo: "addr_test1me",
          qty: "500000000",
          payableAfter: NOW - 200_000,
        },
        {
          utxo: "r2",
          owner: "kme",
          payoutTo: "addr_test1me",
          qty: "100000000",
          payableAfter: NOW + DAY,
        },
        {
          utxo: "r3",
          owner: "kother",
          payoutTo: "addr_test1o",
          qty: "100000000",
          payableAfter: NOW - DAY,
        },
      ],
      sinks: { count: 0, tsra: "0" },
      ...over,
    },
  } as unknown as TesseraLive;
}

test("parseAmount: plain positive amounts with up to 6 decimals", () => {
  assert.equal(parseAmount("25"), 25_000_000n);
  assert.equal(parseAmount("12.5"), 12_500_000n);
  assert.equal(parseAmount(" 1,000.000001 "), 1_000_000_001n);
  for (const bad of ["", "0", "0.0", "-1", "1e3", "1.2345678", "abc", "1..2", ".5"])
    assert.equal(parseAmount(bad), null, bad);
});

test("formatUnits: thousands, trimmed decimals, dp", () => {
  assert.equal(formatUnits(12_500_000n), "12.5");
  assert.equal(formatUnits("1000000000000"), "1,000,000");
  assert.equal(formatUnits(1_234_567n, 2), "1.23");
  assert.equal(formatUnits(0n), "0");
});

test("quotes: stake and unstake at the snapshot price", () => {
  assert.equal(quoteStake(100_000_000n, "1087500"), 91_954_022n);
  assert.equal(quoteUnstake(91_954_022n, "1087500"), 99_999_998n);
  assert.equal(quoteStake(1n, "0"), 0n);
});

test("instantRoom: per-swap cap, shard day room and balance; suspended = 0", () => {
  // shard 0: daily cap 12,500 TSRA − 12,000 paid today = 500 TSRA left.
  assert.equal(instantRoom(live(), NOW), 500_000_000n);
  // a new UTC day resets it to the per-swap cap (10,000) or the shard's cap 12,500.
  assert.equal(instantRoom(live(), NOW + DAY), 10_000_000_000n);
  const susp = live();
  susp.queue.config.suspendedUntil = NOW + 1;
  assert.equal(instantRoom(susp, NOW), 0n);
});

test("request timing: minutes to UTC midnight and the payable date", () => {
  assert.equal(requestMinutesLeft(NOW), 21 * 60);
  assert.equal(requestMinutesLeft(21_000 * DAY - 10 * 60_000), 10);
  assert.equal(payableAfterIfNow(live(), NOW), 20_001 * DAY + 2 * DAY);
});

test("ticketsOf / requestsOf: only the viewer's, with readiness", () => {
  const t = ticketsOf(live(), "addr_test1me", NOW);
  assert.deepEqual(
    t.map((x) => [x.utxo, x.claimable]),
    [
      ["a#1", true],
      ["b#1", false],
    ],
  );
  assert.equal(ticketsOf(live(), null, NOW).length, 0);
  const r = requestsOf(live(), "kme", NOW);
  assert.deepEqual(
    r.map((x) => [x.utxo, x.payable]),
    [
      ["r1", true],
      ["r2", false],
    ],
  );
  assert.equal(requestsOf(live(), "all", NOW).filter((x) => x.payable).length, 2);
});

test("amountProblem: empty, below minimum, above balance", () => {
  assert.match(amountProblem(null, 1n)!, /Enter an amount/);
  assert.match(amountProblem(50n, 100n, 100n)!, /minimum/);
  assert.match(amountProblem(200n, 100n)!, /more than your wallet/);
  assert.equal(amountProblem(50n, 100n), null);
  assert.equal(amountProblem(50n, null), null);
});
