// E07 — transaction tracker: every transition, rollbacks, expiry, polling.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPIRY_GRACE_MS,
  FINAL_DEPTH,
  advance,
  blockfrostReader,
  describe,
  isTerminal,
  track,
  trackTx,
  type ChainReader,
} from "./tx-tracker.shared";

const H = "ab".repeat(32);
const T0 = 1_800_000_000_000;
const VALID_TO = T0 + 600_000;
const snap = (tip: number, txHeight: number | null, now = T0) => ({ tip, txHeight, now });

test("E07 tracker: pending until a block holds it, then counts depth", () => {
  let t = track(H, VALID_TO);
  t = advance(t, snap(100, null));
  assert.equal(t.status, "pending");
  t = advance(t, snap(101, 101));
  assert.deepEqual([t.status, t.depth, t.height], ["onchain", 1, 101]);
  t = advance(t, snap(105, 101));
  assert.deepEqual([t.status, t.depth], ["onchain", 5]);
});

test("E07 tracker: final at FINAL_DEPTH blocks, and final is terminal", () => {
  let t = advance(track(H, VALID_TO), snap(100 + FINAL_DEPTH - 2, 100));
  assert.equal(t.status, "onchain");
  t = advance(t, snap(100 + FINAL_DEPTH - 1, 100));
  assert.equal(t.status, "final");
  assert.ok(isTerminal(t));
  // Nothing moves a final record, not even a later "not found".
  assert.equal(advance(t, snap(200, null, T0 + 10 ** 9)), t);
});

test("E07 tracker: a rollback is reported, counted, and recoverable", () => {
  let t = advance(track(H, VALID_TO), snap(101, 101));
  t = advance(t, snap(101, null));
  assert.deepEqual([t.status, t.rollbacks, t.depth, t.height], ["rolled_back", 1, 0, null]);
  assert.match(describe(t), /rolled back/);
  // Re-included in a different block.
  t = advance(t, snap(103, 102));
  assert.deepEqual([t.status, t.height, t.depth], ["onchain", 102, 2]);
  // Rolled back again: counted again.
  t = advance(t, snap(103, null));
  assert.equal(t.rollbacks, 2);
});

test("E07 tracker: a rolled-back tx expires once its window closes", () => {
  let t = advance(advance(track(H, VALID_TO), snap(101, 101)), snap(101, null));
  t = advance(t, snap(110, null, VALID_TO + EXPIRY_GRACE_MS));
  assert.equal(t.status, "rolled_back", "not before the grace period ends");
  t = advance(t, snap(110, null, VALID_TO + EXPIRY_GRACE_MS + 1));
  assert.equal(t.status, "expired");
  assert.ok(isTerminal(t));
});

test("E07 tracker: a never-seen tx expires only after validTo plus the grace", () => {
  let t = advance(track(H, VALID_TO), snap(100, null, VALID_TO));
  assert.equal(t.status, "pending");
  t = advance(t, snap(100, null, VALID_TO + EXPIRY_GRACE_MS + 1));
  assert.equal(t.status, "expired");
  assert.match(describe(t), /never included/);
});

test("E07 tracker: a late inclusion still wins over expiry", () => {
  // Seen in a block even though the clock is past the window: on chain is fact.
  const t = advance(track(H, VALID_TO), snap(120, 119, VALID_TO + EXPIRY_GRACE_MS + 10));
  assert.equal(t.status, "onchain");
});

test("E07 tracker: bad input is refused", () => {
  assert.throws(() => track("zz", VALID_TO), /64 hex/);
  assert.throws(() => track(H, Number.NaN), /validity end/);
  assert.equal(track(H.toUpperCase(), VALID_TO).hash, H);
});

test("E07 tracker: polling reports each change and stops when final", async () => {
  // A scripted chain: not found, found at 50, a rollback, found at 52, deepens.
  const script: Array<[number, number | null]> = [
    [49, null],
    [50, 50],
    [50, null],
    [52, 52],
    [52 + FINAL_DEPTH - 1, 52],
  ];
  let i = 0;
  const reader: ChainReader = {
    tip: async () => script[Math.min(i, script.length - 1)]![0],
    txHeight: async () => script[Math.min(i++, script.length - 1)]![1],
  };
  const seen: string[] = [];
  const end = await trackTx(reader, track(H, VALID_TO), {
    now: () => T0,
    sleep: async () => {},
    onChange: (t) => seen.push(`${t.status}:${t.depth}`),
  });
  assert.equal(end.status, "final");
  assert.equal(end.rollbacks, 1);
  assert.deepEqual(seen, ["onchain:1", "rolled_back:0", "onchain:1", `final:${FINAL_DEPTH}`]);
});

test("E07 tracker: a failed read is retried, never taken as 'not on chain'", async () => {
  let calls = 0;
  const reader: ChainReader = {
    tip: async () => 10,
    txHeight: async () => {
      calls++;
      if (calls === 1) throw new Error("network");
      return calls === 2 ? 10 : 10 - FINAL_DEPTH;
    },
  };
  const end = await trackTx(reader, track(H, VALID_TO), { now: () => T0, sleep: async () => {} });
  assert.equal(end.status, "final");
  assert.equal(end.rollbacks, 0);
});

test("E07 tracker: polling gives up at the timeout and returns the last record", async () => {
  let clock = T0;
  const reader: ChainReader = { tip: async () => 5, txHeight: async () => 5 };
  const end = await trackTx(reader, track(H, VALID_TO + 10 ** 9), {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    intervalMs: 60_000,
    timeoutMs: 180_000,
  });
  assert.equal(end.status, "onchain");
});

test("E07 tracker: the Blockfrost reader reads through the proxy only", async () => {
  const paths: string[] = [];
  const reader = blockfrostReader(async (p) => {
    paths.push(p);
    if (p.endsWith("/blocks/latest")) return { status: 200, json: { height: 1234 } };
    if (p.endsWith(`/txs/${H}`)) return { status: 200, json: { block_height: 1230 } };
    return { status: 404, json: null };
  });
  assert.equal(await reader.tip(), 1234);
  assert.equal(await reader.txHeight(H), 1230);
  assert.equal(await reader.txHeight("cd".repeat(32)), null, "404 = no block holds it");
  assert.deepEqual(paths, [
    "/api/bf/blocks/latest",
    `/api/bf/txs/${H}`,
    `/api/bf/txs/${"cd".repeat(32)}`,
  ]);
  await assert.rejects(reader.txHeight("../x"), /bad hash/);
  const broken = blockfrostReader(async () => ({ status: 200, json: { height: "1" } }));
  await assert.rejects(broken.tip(), /unexpected height/);
  const down = blockfrostReader(async () => ({ status: 500, json: null }));
  await assert.rejects(down.txHeight(H), /failed \(500\)/);
});
