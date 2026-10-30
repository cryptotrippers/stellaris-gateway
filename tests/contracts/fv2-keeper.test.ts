/**
 * The fraction_vault v2 keeper (src/lib/offering-v2-keeper.ts) on Lucid's
 * Emulator with the real compiled scripts and reference scripts, every
 * transaction through the S1 guard: the raise path with a hard-cap overflow,
 * the failed-raise path with batched refunds (and their budget), strays, a
 * wallet without the keeper key, and a rival keeper getting there first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { encodePledge } from "../../src/lib/offering-v2-chain";
import {
  buildAction,
  buildPublishRefs,
  buildSettle,
  findPledges,
  findState,
  type Built,
} from "../../src/lib/offering-v2-tx";
import {
  AFTER_WINDOW_MS,
  KEEPER_REFUND_BATCH,
  buildKeeperJob,
  planKeeper,
  runKeeper,
  type KeeperJob,
  type KeeperOptions,
} from "../../src/lib/offering-v2-keeper";
import {
  TSRA,
  TX_MAX,
  T,
  as,
  keyHash,
  run,
  setup,
  tsraOf,
  txBudget,
  type Account,
  type World,
} from "./fv2-emulator-fixture";

async function withRefs(w: World) {
  const pub = await buildPublishRefs(as(w, w.issuer), w.issuer.address);
  const h = await run(w, w.issuer, pub);
  const outs = await w.lucid.utxosByOutRef([0, 1, 2].map((i) => ({ txHash: h, outputIndex: i })));
  w.ctx.refs = { offering: outs[0], pledge: outs[1], fraction: outs[2] };
}

/** investors[i] pledges qtys[i]. */
async function pledgeEach(w: World, qtys: bigint[]) {
  const { buildPledge } = await import("../../src/lib/offering-v2-tx");
  for (const [i, q] of qtys.entries()) {
    const inv = w.investors[i]!;
    await run(w, inv, await buildPledge(as(w, inv), inv.address, q, w.emulator.now()));
  }
}

/** Run the keeper as `wallet`, recording each job's budget. */
async function keep(w: World, wallet: Account, opts: KeeperOptions, maxJobs = 20) {
  const budgets: { job: KeeperJob; mem: bigint; cpu: bigint; bytes: number }[] = [];
  const r = await runKeeper(
    as(w, wallet),
    keyHash(wallet.address),
    opts,
    {
      now: () => w.emulator.now(),
      submit: async (built: Built, job) => {
        budgets.push({ job, ...txBudget(built.tx.toCBOR()) });
        return run(w, wallet, built);
      },
      caughtUp: async () => true,
    },
    maxJobs,
  );
  return { ...r, budgets };
}

const frac = async (w: World, a: string) =>
  (await w.lucid.utxosAt(a)).reduce((x, u) => x + (u.assets[w.scripts.fraction.unit] ?? 0n), 0n);

test("keeper: settles 19 pledges in batches of 15 + 4, skips the one past the hard cap, refunds it after close", async () => {
  const w = await setup({ investors: 20 });
  await withRefs(w);
  // 18 × 50 = 900, then 150 (does not fit the 100 left), then 100 (fits).
  const qtys = [...Array.from({ length: 18 }, () => 50n), 150n, 100n];
  await pledgeEach(w, qtys);
  const before = await Promise.all(
    w.investors.map(async (i) => tsraOf(await w.lucid.utxosAt(i.address))),
  );

  const r = await keep(w, w.keeper, { isKeeper: true });
  assert.equal(r.stopped, undefined);
  assert.deepEqual(
    r.done.map((d) => (d.job.kind === "settle" ? d.job.pledges.length : 0)),
    [15, 4],
  );
  for (const b of r.budgets) {
    assert.ok(b.mem * 10n <= TX_MAX.mem * 8n, `settle mem ${b.mem}`);
    assert.ok(b.cpu * 10n <= TX_MAX.cpu * 8n, `settle cpu ${b.cpu}`);
    assert.ok(b.bytes <= TX_MAX.bytes, `settle size ${b.bytes}`);
  }
  const s = (await findState(w.ctx)).state;
  assert.equal(s.book.settled, 1_000n, "exactly the hard cap");
  assert.equal(r.plan.jobs.length, 0, "the 150 pledge waits; nothing else to do");
  for (const [i, q] of qtys.entries())
    assert.equal(await frac(w, w.investors[i]!.address), i === 18 ? 0n : q, `investor ${i}`);

  // The committee closes; the keeper then returns the 150 pledge at once.
  await run(
    w,
    w.committee[0]!,
    await buildAction(
      as(w, w.committee[0]!),
      { kind: "closeRaise" },
      { signers: w.boardKeys.slice(0, 2), nowMs: w.emulator.now() },
    ),
    [w.committee[1]!],
  );
  const r2 = await keep(w, w.keeper, { isKeeper: true });
  assert.deepEqual(
    r2.done.map((d) => d.job.kind),
    ["refund"],
  );
  assert.equal((await findPledges(w.ctx)).length, 0);
  const big = w.investors[18]!;
  assert.equal(tsraOf(await w.lucid.utxosAt(big.address)), before[18]! + T(1_500));
});

test("keeper: a raise below the soft cap is failed after the window and all 17 pledges returned (15 + 2), within budget", async () => {
  const w = await setup({ investors: 17 });
  await withRefs(w);
  const before = await Promise.all(
    w.investors.map(async (i) => tsraOf(await w.lucid.utxosAt(i.address))),
  );
  await pledgeEach(
    w,
    Array.from({ length: 17 }, () => 10n),
  ); // 170 < soft cap 400

  // Before the window ends, a keeper that is not the keeper key does nothing.
  const idle = await keep(w, w.mallory, { isKeeper: false });
  assert.equal(idle.done.length, 0);
  assert.ok(idle.plan.notes.some((n) => /not the offering's keeper/.test(n.text)));

  const t = (await findState(w.ctx)).state.terms;
  w.emulator.awaitSlot(
    Math.ceil((Number(t.deadline + t.settleWindow) - w.emulator.now() + AFTER_WINDOW_MS) / 1000) +
      5,
  );
  // Anyone may fail and refund: run it from mallory's wallet, not the keeper's.
  const r = await keep(w, w.mallory, { isKeeper: false });
  assert.equal(r.stopped, undefined);
  assert.deepEqual(
    r.done.map((d) => d.job.kind),
    ["failRaise", "refund", "refund"],
  );
  const refunds = r.budgets.filter((b) => b.job.kind === "refund");
  assert.equal(
    (refunds[0]!.job as Extract<KeeperJob, { kind: "refund" }>).pledges.length,
    KEEPER_REFUND_BATCH,
  );
  const b = refunds[0]!;
  console.log(
    `[fv2 keeper] refund of ${KEEPER_REFUND_BATCH}: mem ${b.mem} (${((Number(b.mem) / Number(TX_MAX.mem)) * 100).toFixed(1)}%) ` +
      `cpu ${b.cpu} (${((Number(b.cpu) / Number(TX_MAX.cpu)) * 100).toFixed(1)}%) size ${b.bytes} B`,
  );
  assert.ok(b.mem * 10n <= TX_MAX.mem * 8n, `refund mem ${b.mem} leaves 20%`);
  assert.ok(b.cpu * 10n <= TX_MAX.cpu * 8n, `refund cpu ${b.cpu} leaves 20%`);
  assert.ok(b.bytes <= TX_MAX.bytes, `refund size ${b.bytes}`);

  assert.equal((await findState(w.ctx)).state.status, "refunding");
  assert.equal((await findPledges(w.ctx)).length, 0);
  for (const [i, inv] of w.investors.entries())
    assert.equal(
      tsraOf(await w.lucid.utxosAt(inv.address)),
      before[i],
      `investor ${i} whole again`,
    );
  // Nothing left for the keeper.
  assert.equal((await keep(w, w.keeper, { isKeeper: true })).done.length, 0);
});

test("keeper: an unmarked UTxO with a forged pledge datum is never settled; returned only on request", async () => {
  const w = await setup({ investors: 1 });
  await withRefs(w);
  await pledgeEach(w, [5n]);
  const m = w.mallory;
  const forged = encodePledge(w.ctx.mod, {
    offering: w.scripts.offering.hash,
    owner: { payment: { type: "key", hash: keyHash(m.address) }, stake: null },
    qty: 500n,
    created: BigInt(w.emulator.now() - 60_000),
  });
  w.lucid.selectWallet.fromPrivateKey(m.privateKey);
  const tx = await w.lucid
    .newTx()
    .pay.ToContract(
      w.scripts.pledge.address,
      { kind: "inline", value: forged },
      {
        lovelace: 3_000_000n,
        [TSRA]: T(10),
      },
    )
    .complete();
  w.emulator.awaitBlock(1);
  await (await tx.sign.withWallet().complete()).submit();
  w.emulator.awaitBlock(1);

  const r = await keep(w, w.keeper, { isKeeper: true });
  assert.deepEqual(
    r.done.map((d) => (d.job.kind === "settle" ? d.job.fractions : -1n)),
    [5n],
  );
  assert.equal((await findState(w.ctx)).state.book.settled, 5n, "the forged 500 is not counted");
  assert.ok(r.plan.notes.some((n) => /unmarked/.test(n.text)));
  assert.equal((await findPledges(w.ctx)).length, 1);

  const mBefore = tsraOf(await w.lucid.utxosAt(m.address));
  const r2 = await keep(w, w.keeper, { isKeeper: true, returnStrays: true });
  assert.deepEqual(
    r2.done.map((d) => (d.job.kind === "refund" ? d.job.reason : d.job.kind)),
    ["stray"],
  );
  assert.equal((await findPledges(w.ctx)).length, 0);
  assert.equal(
    tsraOf(await w.lucid.utxosAt(m.address)) - mBefore,
    T(10),
    "back to its datum's owner",
  );
});

test("keeper: a Settle signed by a key other than the keeper (or committee) is refused on chain", async () => {
  const w = await setup({ investors: 1 });
  await withRefs(w);
  await pledgeEach(w, [5n]);
  const ps = await findPledges(w.ctx);
  await assert.rejects(
    buildSettle(as(w, w.mallory), ps, [keyHash(w.mallory.address)], w.emulator.now()),
  );
  assert.equal((await findState(w.ctx)).state.book.settled, 0n);
});

test("keeper: a rival keeper settles first; the stale job fails to build and the next plan is empty", async () => {
  const w = await setup({ investors: 2 });
  await withRefs(w);
  await pledgeEach(w, [5n, 6n]);
  const snap = planKeeper(
    (await findState(w.ctx)).state,
    await findPledges(w.ctx),
    w.emulator.now(),
    { isKeeper: true },
  );
  const job = snap.jobs[0]!;
  // runKeeper reports a refused submission instead of crashing.
  const raced = await runKeeper(
    as(w, w.keeper),
    keyHash(w.keeper.address),
    { isKeeper: true },
    {
      now: () => w.emulator.now(),
      submit: async () => {
        throw new Error("BadInputsUTxO (simulated rival)");
      },
    },
  );
  assert.equal(raced.done.length, 0);
  assert.match(raced.stopped ?? "", /was not accepted: BadInputsUTxO/);
  // The rival (the committee may settle too) gets there first.
  const ps = await findPledges(w.ctx);
  await run(
    w,
    w.committee[0]!,
    await buildSettle(as(w, w.committee[0]!), ps, w.boardKeys.slice(0, 2), w.emulator.now()),
    [w.committee[1]!],
  );
  // The stale job spends pledges that are gone: building may pass (the
  // builder is handed the UTxOs), but the ledger refuses it.
  await assert.rejects(async () => {
    const stale = await buildKeeperJob(
      as(w, w.keeper),
      job,
      keyHash(w.keeper.address),
      w.emulator.now(),
    );
    await run(w, w.keeper, stale);
  });
  const r = await keep(w, w.keeper, { isKeeper: true });
  assert.equal(r.done.length, 0);
  assert.equal((await findState(w.ctx)).state.book.settled, 11n, "settled once, not twice");
});

test("keeper: the State's thread token is checked, a look-alike State at the address is ignored", async () => {
  const w = await setup({ investors: 1 });
  // Mallory parks a copy of the State's datum at the offering address, without
  // the thread token. findState must keep picking the genuine one.
  const genuine = await findState(w.ctx);
  w.lucid.selectWallet.fromPrivateKey(w.mallory.privateKey);
  const tx = await w.lucid
    .newTx()
    .pay.ToContract(
      genuine.utxo.address,
      { kind: "inline", value: genuine.utxo.datum! },
      { lovelace: 5_000_000n },
    )
    .complete();
  await (await tx.sign.withWallet().complete()).submit();
  w.emulator.awaitBlock(1);
  const again = await findState(w.ctx);
  assert.equal(again.utxo.txHash, genuine.utxo.txHash);
});
