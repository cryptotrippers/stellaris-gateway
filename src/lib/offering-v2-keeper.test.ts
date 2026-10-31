/**
 * Keeper planner rules (SPEC-v2 §2, §5, §11.4), on fabricated snapshots.
 * The emulator runs with the real scripts are in tests/contracts/fv2-keeper.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_BOOK, KEEPER_BATCH, type V2State } from "./offering-v2-chain";
import type { LivePledge } from "./offering-v2-tx";
import {
  AFTER_WINDOW_MS,
  KEEPER_REFUND_BATCH,
  SETTLE_MARGIN_MS,
  describeJob,
  planKeeper,
  type KeeperJob,
} from "./offering-v2-keeper";

const HOUR = 3_600_000;
const DEADLINE = 1_800_000_000_000;
const WINDOW = 2 * HOUR;
const END = DEADLINE + WINDOW;
const KEEPER = "ab".repeat(28);

function state(over: Partial<V2State> = {}, book: Partial<V2State["book"]> = {}): V2State {
  return {
    status: "raising",
    terms: {
      totalFractions: 1_000n,
      softCap: 100n,
      price: 10_000_000n,
      deadline: BigInt(DEADLINE),
      settleWindow: BigInt(WINDOW),
      retained: 0n,
      docsHash: "d0".repeat(32),
      spvPayout: { type: "key", hash: KEEPER },
      treasury: KEEPER,
      issuer: KEEPER,
      keeper: KEEPER,
      fractionPolicy: "f0".repeat(28),
      eligibilityPolicy: null,
      unitPolicy: "93".repeat(28),
      unitName: "54535241",
    },
    book: { ...EMPTY_BOOK, ...book },
    feeBps: 100,
    period: 0n,
    manifestRoot: "",
    committee: ["c1".repeat(28), "c2".repeat(28), "c3".repeat(28)],
    threshold: 2,
    ...over,
  };
}

let seq = 0;
/** A pledge; `created` orders arrival. Hashes are unrelated to arrival on purpose. */
function pledge(qty: bigint, created: number, marked = true, owner = "0a"): LivePledge {
  seq++;
  const txHash = ((seq * 7919) % 65536).toString(16).padStart(4, "0").repeat(16);
  return {
    utxo: { txHash, outputIndex: 0, address: "addr_test1", assets: {} } as never,
    pledge: {
      offering: "00".repeat(28),
      owner: { payment: { type: "key", hash: owner.repeat(28) }, stake: null },
      qty,
      created: BigInt(created),
    },
    marked,
  };
}

const kinds = (jobs: KeeperJob[]) => jobs.map((j) => j.kind);
const early = DEADLINE - 5 * HOUR;
const afterWindow = END + AFTER_WINDOW_MS + 1;

test("keeper: settles marked pledges first come first served, 15 per batch", () => {
  const ps = Array.from({ length: 20 }, (_, i) => pledge(1n, early - 1_000 * (20 - i)));
  const shuffled = [...ps].reverse();
  const plan = planKeeper(state(), shuffled, early, { isKeeper: true });
  assert.deepEqual(kinds(plan.jobs), ["settle", "settle"]);
  const [a, b] = plan.jobs as Extract<KeeperJob, { kind: "settle" }>[];
  assert.equal(a!.pledges.length, KEEPER_BATCH);
  assert.equal(b!.pledges.length, 5);
  assert.deepEqual(
    [...a!.pledges, ...b!.pledges].map((p) => p.pledge.created),
    ps.map((p) => p.pledge.created),
    "arrival order",
  );
  assert.equal(a!.fractions, 15n);
});

test("keeper: batch overrides are clamped to the measured maxima", () => {
  const ps = Array.from({ length: 40 }, (_, i) => pledge(1n, early - 100_000 + i));
  const plan = planKeeper(state(), ps, early, { isKeeper: true, settleBatch: 99 });
  assert.ok(plan.jobs.every((j) => j.kind === "settle" && j.pledges.length <= KEEPER_BATCH));
  const small = planKeeper(state(), ps, early, { isKeeper: true, settleBatch: 4 });
  assert.equal(small.jobs.length, 10);
  assert.throws(() => planKeeper(state(), ps, early, { isKeeper: true, settleBatch: 0 }));
});

test("keeper: never settles past the hard cap; a pledge too big is skipped, later ones still fit", () => {
  const s = state({}, { settled: 900n, outstanding: 900n });
  const ps = [pledge(60n, early - 30), pledge(50n, early - 20), pledge(40n, early - 10)];
  const plan = planKeeper(s, ps, early, { isKeeper: true });
  assert.equal(plan.jobs.length, 1);
  const j = plan.jobs[0] as Extract<KeeperJob, { kind: "settle" }>;
  assert.deepEqual(
    j.pledges.map((p) => p.pledge.qty),
    [60n, 40n],
  );
  assert.equal(j.fractions, 100n);
  assert.ok(plan.notes.some((n) => /do not fit/.test(n.text)));
});

test("keeper: a wallet without the keeper key settles nothing and says so", () => {
  const plan = planKeeper(state(), [pledge(5n, early - 1)], early, { isKeeper: false });
  assert.equal(plan.jobs.length, 0);
  assert.ok(plan.notes.some((n) => n.level === "warn" && /not the offering's keeper/.test(n.text)));
});

test("keeper: stops settling SETTLE_MARGIN_MS before the window ends", () => {
  const ps = [pledge(5n, DEADLINE - 1)];
  const inside = END - SETTLE_MARGIN_MS - 1;
  assert.deepEqual(kinds(planKeeper(state(), ps, inside, { isKeeper: true }).jobs), ["settle"]);
  const tooLate = END - SETTLE_MARGIN_MS;
  const plan = planKeeper(state(), ps, tooLate, { isKeeper: true });
  assert.equal(plan.jobs.length, 0);
  assert.ok(plan.notes.some((n) => /Too close/.test(n.text)));
  // Just past the end but before validity can start past it: still waiting.
  assert.equal(planKeeper(state(), ps, END + 1, { isKeeper: true }).jobs.length, 0);
});

test("keeper: below the soft cap after the window, fails the raise and nothing else", () => {
  const s = state({}, { settled: 40n, outstanding: 40n });
  const plan = planKeeper(s, [pledge(5n, DEADLINE - 1)], afterWindow, { isKeeper: false });
  assert.deepEqual(kinds(plan.jobs), ["failRaise"], "anyone may fail; refunds follow next plan");
  assert.equal(planKeeper(s, [], afterWindow - 2, { isKeeper: true }).jobs.length, 0);
});

test("keeper: soft cap met but never closed: refunds the leftovers and asks the committee to close", () => {
  const s = state({}, { settled: 100n, outstanding: 100n });
  const ps = Array.from({ length: 17 }, (_, i) => pledge(1n, DEADLINE - 100 + i));
  const plan = planKeeper(s, ps, afterWindow, { isKeeper: true });
  assert.deepEqual(kinds(plan.jobs), ["refund", "refund"]);
  assert.equal((plan.jobs[0] as Extract<KeeperJob, { kind: "refund" }>).pledges.length, 15);
  assert.ok(plan.notes.some((n) => n.level === "action" && /CloseRaise/.test(n.text)));
});

test("keeper: after the deadline with the soft cap met, tells the committee it can close", () => {
  const s = state({}, { settled: 90n, outstanding: 90n });
  const plan = planKeeper(s, [pledge(10n, DEADLINE - 1)], DEADLINE + 1, { isKeeper: true });
  assert.deepEqual(kinds(plan.jobs), ["settle"]);
  assert.ok(plan.notes.some((n) => n.level === "action" && /can CloseRaise/.test(n.text)));
});

for (const status of ["operating", "refunding", "windingDown", "closed"] as const) {
  test(`keeper: ${status} — every marked pledge left is refunded, nothing settled`, () => {
    const s = state({ status }, { settled: 100n, outstanding: 100n });
    const ps = [pledge(3n, DEADLINE - 2), pledge(4n, DEADLINE - 1)];
    const plan = planKeeper(s, ps, early, { isKeeper: true });
    assert.deepEqual(kinds(plan.jobs), ["refund"]);
    const j = plan.jobs[0] as Extract<KeeperJob, { kind: "refund" }>;
    assert.equal(j.reason, "unsettleable");
    assert.equal(j.pledges.length, 2);
  });
}

test("keeper: refunding — reminds holders to refund their fractions", () => {
  const s = state({ status: "refunding" }, { settled: 40n, outstanding: 40n });
  const plan = planKeeper(s, [], afterWindow, { isKeeper: true });
  assert.equal(plan.jobs.length, 0);
  assert.ok(plan.notes.some((n) => /RefundFraction/.test(n.text)));
});

test("keeper: unmarked UTxOs are never settled; returned only when asked", () => {
  const ps = [pledge(500n, early - 2, false), pledge(5n, early - 1)];
  const off = planKeeper(state(), ps, early, { isKeeper: true });
  assert.deepEqual(kinds(off.jobs), ["settle"]);
  assert.equal((off.jobs[0] as Extract<KeeperJob, { kind: "settle" }>).fractions, 5n);
  assert.ok(off.notes.some((n) => /unmarked/.test(n.text)));
  const on = planKeeper(state(), ps, early, { isKeeper: true, returnStrays: true });
  assert.deepEqual(kinds(on.jobs), ["settle", "refund"]);
  assert.equal((on.jobs[1] as Extract<KeeperJob, { kind: "refund" }>).reason, "stray");
});

test("keeper: eligibility — no source, no settle; ineligible owners are skipped", () => {
  const s = state();
  s.terms = { ...s.terms, eligibilityPolicy: "e1".repeat(28) };
  const ps = [pledge(5n, early - 2, true, "0a"), pledge(6n, early - 1, true, "0b")];
  const none = planKeeper(s, ps, early, { isKeeper: true });
  assert.equal(none.jobs.length, 0);
  assert.ok(none.notes.some((n) => /eligibility/.test(n.text)));
  const some = planKeeper(s, ps, early, {
    isKeeper: true,
    eligibility: (k) => (k.startsWith("0b") ? ({ txHash: "e", outputIndex: 0 } as never) : null),
  });
  assert.deepEqual(
    (some.jobs[0] as Extract<KeeperJob, { kind: "settle" }>).pledges.map((p) => p.pledge.qty),
    [6n],
  );
});

test("keeper: an operating offering with nothing pending has nothing to do", () => {
  const plan = planKeeper(state({ status: "operating" }), [], early, { isKeeper: true });
  assert.equal(plan.jobs.length, 0);
  assert.match(plan.notes[0]!.text, /Nothing to do/);
  assert.equal(plan.windowEnd, BigInt(END));
});

test("keeper: refunds are batched at KEEPER_REFUND_BATCH", () => {
  const ps = Array.from({ length: KEEPER_REFUND_BATCH * 2 + 1 }, (_, i) => pledge(1n, i));
  const plan = planKeeper(state({ status: "refunding" }), ps, early, { isKeeper: true });
  assert.deepEqual(
    plan.jobs.map((j) => (j as Extract<KeeperJob, { kind: "refund" }>).pledges.length),
    [KEEPER_REFUND_BATCH, KEEPER_REFUND_BATCH, 1],
  );
  assert.match(describeJob(plan.jobs[0]!), /return 15 pledge/);
});
