/**
 * E07 — fraction_vault v2 on Lucid's Emulator with the REAL compiled scripts.
 *
 * Every transaction is built by `src/lib/offering-v2-tx.ts`, checked by the S1
 * intent guard (`assertIntent`) exactly as the app would before asking a wallet
 * to sign, then signed and submitted. The ledger here runs the scripts' UPLC,
 * so execution units are real.
 *
 * Covers SPEC-v2 §7 and §8 on serialised transactions: the success path
 * (open → pledge → settle → close → release → commit → claim → wind down →
 * redeem), the failure path (fail → refund pledge / refund fraction), the
 * owner's cancel, and the Settle budget at N = 1, 5, 10, 20.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as L from "@lucid-evolution/lucid";
import {
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { deriveV2, type V2Scripts } from "../../src/lib/fraction-vault-v2";
import { EMPTY_BOOK, KEEPER_BATCH, accounted, type V2State } from "../../src/lib/offering-v2-chain";
import {
  buildAction,
  buildCancelPledge,
  buildOpen,
  buildPledge,
  buildRefundPledges,
  buildSettle,
  findPledges,
  findState,
  type Built,
  type LucidModTx,
  type V2Context,
} from "../../src/lib/offering-v2-tx";
import { assertIntent, walletViewOf } from "../../src/lib/tx-sign-guarded";

const TSRA_POLICY = "938b32e0".padEnd(56, "7");
const TSRA_NAME = "54535241"; // "TSRA"
const TSRA = `${TSRA_POLICY}${TSRA_NAME}`;
const T = (n: number) => BigInt(n) * 1_000_000n; // whole TSRA, 6 decimals
const ADA = 1_000_000n;

const keyHash = (a: string) => getAddressDetails(a).paymentCredential!.hash;
type Account = ReturnType<typeof generateEmulatorAccountFromPrivateKey>;

const acct = (lovelace: bigint, tsra = 0n): Account =>
  generateEmulatorAccountFromPrivateKey(tsra ? { lovelace, [TSRA]: tsra } : { lovelace });

export interface World {
  emulator: Emulator;
  lucid: LucidEvolution;
  issuer: Account;
  committee: Account[];
  keeper: Account;
  treasury: Account;
  spv: Account;
  investors: Account[];
  scripts: V2Scripts;
  ctx: V2Context;
  boardKeys: string[];
}

/** Sign as `wallet` plus `cosigners`, after the intent guard has passed. */
export async function run(w: World, wallet: Account, built: Built, cosigners: Account[] = []) {
  w.lucid.selectWallet.fromPrivateKey(wallet.privateKey);
  await assertIntent(built.tx.toCBOR(), built.intent, await walletViewOf(w.lucid));
  let s = built.tx.sign.withWallet();
  for (const c of cosigners) s = s.sign.withPrivateKey(c.privateKey);
  const hash = await (await s.complete()).submit();
  w.emulator.awaitBlock(1);
  assert.ok(await w.lucid.awaitTx(hash), "confirmed");
  return hash;
}

/** As `wallet`: select it before building so coin selection uses its UTxOs. */
export function as(w: World, a: Account) {
  w.lucid.selectWallet.fromPrivateKey(a.privateKey);
  return w.ctx;
}

export async function setup(opts: { investors?: number; windowMs?: number } = {}): Promise<World> {
  const issuer = acct(5_000n * ADA, T(1_000_000));
  const committee = [acct(100n * ADA), acct(100n * ADA), acct(100n * ADA)];
  const keeper = acct(500n * ADA);
  const treasury = acct(10n * ADA);
  const spv = acct(10n * ADA);
  const investors = Array.from({ length: opts.investors ?? 3 }, () => acct(200n * ADA, T(100_000)));
  const emulator = new Emulator([issuer, ...committee, keeper, treasury, spv, ...investors]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(issuer.privateKey);
  const seedUtxo = (await lucid.wallet().getUtxos())[0]!;
  const scripts = deriveV2(
    L as never,
    "ph-solar-01",
    { policyId: TSRA_POLICY, assetNameHex: TSRA_NAME },
    { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex },
    "Custom",
  );
  const ctx: V2Context = { lucid, mod: L as unknown as LucidModTx, scripts };
  const boardKeys = committee.map((c) => keyHash(c.address));
  const w: World = {
    emulator,
    lucid,
    issuer,
    committee,
    keeper,
    treasury,
    spv,
    investors,
    scripts,
    ctx,
    boardKeys,
  };

  const now = emulator.now();
  const state: V2State = {
    status: "raising",
    terms: {
      totalFractions: 1_000n,
      softCap: 400n,
      price: T(10),
      deadline: BigInt(now + 3_600_000),
      settleWindow: BigInt(opts.windowMs ?? 600_000),
      retained: 0n,
      docsHash: "d0".repeat(32),
      spvPayout: { type: "key", hash: keyHash(spv.address) },
      treasury: keyHash(treasury.address),
      issuer: keyHash(issuer.address),
      keeper: keyHash(keeper.address),
      fractionPolicy: scripts.fraction.policyId,
      eligibilityPolicy: null,
      unitPolicy: TSRA_POLICY,
      unitName: TSRA_NAME,
    },
    book: EMPTY_BOOK,
    feeBps: 100,
    period: 0n,
    manifestRoot: "",
    committee: boardKeys,
    threshold: 2,
  };
  const open = await buildOpen(
    ctx,
    seedUtxo,
    state,
    [keyHash(issuer.address), ...boardKeys.slice(0, 2)],
    now,
  );
  await run(w, issuer, open, committee.slice(0, 2));
  return w;
}

/** Each investor i pledges qtys[i] fractions (one pledge each). */
export async function pledgeAll(w: World, qtys: bigint[]) {
  for (const [i, q] of qtys.entries()) {
    const inv = w.investors[i % w.investors.length]!;
    await run(w, inv, await buildPledge(as(w, inv), inv.address, q, w.emulator.now()));
  }
}

const tsraOf = (u: UTxO[]) => u.reduce((a, x) => a + (x.assets[TSRA] ?? 0n), 0n);

let w: World;
before(async () => {
  w = await setup();
});

test("E07: open puts the empty Raising State at the offering address", async () => {
  const { state, utxo } = await findState(w.ctx);
  assert.equal(state.status, "raising");
  assert.equal(state.book.settled, 0n);
  assert.equal(utxo.assets[w.scripts.offering.threadUnit], 1n);
  assert.equal(utxo.assets[TSRA] ?? 0n, 0n);
});

test("E07: three investors pledge, and each pledge carries a marker", async () => {
  await pledgeAll(w, [5n, 20n, 1n]);
  const ps = await findPledges(w.ctx);
  assert.equal(ps.length, 3);
  assert.ok(ps.every((p) => p.marked));
  assert.equal(tsraOf(ps.map((p) => p.utxo)), T(260));
});

test("E07: the keeper settles the batch; owners get their fractions", async () => {
  const ps = await findPledges(w.ctx);
  const built = await buildSettle(
    as(w, w.keeper),
    ps,
    [keyHash(w.keeper.address)],
    w.emulator.now(),
  );
  await run(w, w.keeper, built);
  const { state, utxo } = await findState(w.ctx);
  assert.equal(state.book.settled, 26n);
  assert.equal(state.book.escrowed, T(260));
  assert.equal(state.book.fees, T(260) / 100n);
  assert.equal(utxo.assets[TSRA], accounted(state.book));
  assert.equal((await findPledges(w.ctx)).length, 0);
  const inv0 = await w.lucid.utxosAt(w.investors[0]!.address);
  assert.equal(
    inv0.reduce((a, u) => a + (u.assets[w.scripts.fraction.unit] ?? 0n), 0n),
    5n,
  );
});

const board = (x: World) => x.boardKeys.slice(0, 2);
const ROOT = "ab".repeat(32);
const EVIDENCE = "e5".repeat(32);

test("E07: a second batch reaches the soft cap and the committee closes the raise", async () => {
  await pledgeAll(w, [200n, 200n]);
  await run(
    w,
    w.keeper,
    await buildSettle(
      as(w, w.keeper),
      await findPledges(w.ctx),
      [keyHash(w.keeper.address)],
      w.emulator.now(),
    ),
  );
  const close = await buildAction(
    as(w, w.committee[0]!),
    { kind: "closeRaise" },
    {
      signers: board(w),
      nowMs: w.emulator.now(),
    },
  );
  await run(w, w.committee[0]!, close, [w.committee[1]!]);
  const { state } = await findState(w.ctx);
  assert.equal(state.status, "operating");
  assert.equal(state.book.settled, 426n);
  assert.equal(state.book.netProceeds, state.book.escrowed - state.book.fees);
});

test("E07: the builder refuses a committee action without enough signatures", async () => {
  await assert.rejects(
    buildAction(
      as(w, w.committee[0]!),
      { kind: "commitPeriod", period: 1n, manifestRoot: ROOT },
      {
        signers: [w.boardKeys[0]!],
        nowMs: w.emulator.now(),
      },
    ),
    /needs 2 committee signatures/,
  );
});

test("E07: release pays the SPV only, within the cap", async () => {
  await assert.rejects(
    buildAction(
      as(w, w.committee[0]!),
      { kind: "release", amount: T(1_000), evidenceHash: EVIDENCE },
      {
        signers: board(w),
        payTo: w.investors[0]!.address,
        nowMs: w.emulator.now(),
      },
    ),
    /not the SPV payout/,
  );
  const before = tsraOf(await w.lucid.utxosAt(w.spv.address));
  const rel = await buildAction(
    as(w, w.committee[0]!),
    { kind: "release", amount: T(1_000), evidenceHash: EVIDENCE },
    {
      signers: board(w),
      payTo: w.spv.address,
      nowMs: w.emulator.now(),
    },
  );
  await run(w, w.committee[0]!, rel, [w.committee[1]!]);
  assert.equal(tsraOf(await w.lucid.utxosAt(w.spv.address)) - before, T(1_000));
  const { state, utxo } = await findState(w.ctx);
  assert.equal(state.book.released, T(1_000));
  assert.equal(utxo.assets[TSRA], accounted(state.book));
});

test("E07: commit period 1, then the treasury claims the fees", async () => {
  const c = await buildAction(
    as(w, w.committee[0]!),
    { kind: "commitPeriod", period: 1n, manifestRoot: ROOT },
    {
      signers: board(w),
      nowMs: w.emulator.now(),
    },
  );
  await run(w, w.committee[0]!, c, [w.committee[1]!]);
  const fees = (await findState(w.ctx)).state.book.fees;
  const claim = await buildAction(
    as(w, w.committee[0]!),
    { kind: "claimFee", amount: fees },
    {
      signers: board(w),
      payTo: w.treasury.address,
      nowMs: w.emulator.now(),
    },
  );
  await run(w, w.committee[0]!, claim, [w.committee[1]!]);
  const { state } = await findState(w.ctx);
  assert.equal(state.period, 1n);
  assert.equal(state.manifestRoot, ROOT);
  assert.equal(state.book.fees, 0n);
  assert.equal(tsraOf(await w.lucid.utxosAt(w.treasury.address)), fees);
});

test("E07: wind down with sale proceeds, then holders redeem pro rata", async () => {
  const wd = await buildAction(
    as(w, w.issuer),
    { kind: "beginWindDown", finalPool: T(5_000) },
    {
      signers: board(w),
      nowMs: w.emulator.now(),
    },
  );
  await run(w, w.issuer, wd, w.committee.slice(0, 2));
  const before = (await findState(w.ctx)).state;
  assert.equal(before.status, "windingDown");
  const inv = w.investors[1]!; // holds 20 + 200 fractions
  const got0 = tsraOf(await w.lucid.utxosAt(inv.address));
  const red = await buildAction(
    as(w, inv),
    { kind: "redeem", qty: 220n },
    {
      payTo: inv.address,
      nowMs: w.emulator.now(),
    },
  );
  await run(w, inv, red);
  const expected = (before.book.pool * 220n) / before.book.outstanding;
  assert.equal(tsraOf(await w.lucid.utxosAt(inv.address)) - got0, expected);
  const { state, utxo } = await findState(w.ctx);
  assert.equal(state.book.outstanding, 206n);
  assert.equal(utxo.assets[TSRA], accounted(state.book));
  assert.equal(utxo.assets.lovelace, 5_000_000n, "the State keeps its rider");
});

// --------------------------------------------------------------------------
// Failure path and the investor's own cancel
// --------------------------------------------------------------------------

test("E07: failure path — cancel, fail, refund a pledge and a fraction", async () => {
  const f = await setup({ windowMs: 60_000 });
  await pledgeAll(f, [5n, 7n, 9n]);
  const ps = await findPledges(f.ctx);
  const alice = f.investors[0]!;
  const mine = ps.find((p) => p.pledge.qty === 5n)!;
  const aliceBefore = tsraOf(await f.lucid.utxosAt(alice.address));
  await run(f, alice, await buildCancelPledge(as(f, alice), mine, f.emulator.now()));
  assert.equal(tsraOf(await f.lucid.utxosAt(alice.address)) - aliceBefore, T(50));

  const seven = (await findPledges(f.ctx)).filter((p) => p.pledge.qty === 7n);
  await run(
    f,
    f.keeper,
    await buildSettle(as(f, f.keeper), seven, [keyHash(f.keeper.address)], f.emulator.now()),
  );

  // Past the deadline and the settle window: anyone can fail the raise.
  const t = (await findState(f.ctx)).state.terms;
  f.emulator.awaitSlot(
    Math.ceil((Number(t.deadline + t.settleWindow) - f.emulator.now()) / 1000) + 5,
  );
  await run(
    f,
    f.keeper,
    await buildAction(as(f, f.keeper), { kind: "failRaise" }, { nowMs: f.emulator.now() }),
  );
  assert.equal((await findState(f.ctx)).state.status, "refunding");

  // A stranger returns carol's unsettled pledge to her.
  const carol = f.investors[2]!;
  const carolBefore = tsraOf(await f.lucid.utxosAt(carol.address));
  const left = await findPledges(f.ctx);
  assert.equal(left.length, 1);
  await run(f, f.keeper, await buildRefundPledges(as(f, f.keeper), left, f.emulator.now()));
  assert.equal(tsraOf(await f.lucid.utxosAt(carol.address)) - carolBefore, T(90));

  // bob refunds his 7 settled fractions at the price; the offering closes.
  const bob = f.investors[1]!;
  const bobBefore = tsraOf(await f.lucid.utxosAt(bob.address));
  await run(
    f,
    bob,
    await buildAction(
      as(f, bob),
      { kind: "refundFraction", qty: 7n },
      { payTo: bob.address, nowMs: f.emulator.now() },
    ),
  );
  assert.equal(tsraOf(await f.lucid.utxosAt(bob.address)) - bobBefore, T(70));
  const end = (await findState(f.ctx)).state;
  assert.equal(end.status, "closed");
  assert.equal(end.book.outstanding, 0n);
  assert.equal(accounted(end.book), 0n);
});

// --------------------------------------------------------------------------
// Settle budget on serialised transactions (SPEC-v2 §8, §11.4)
// --------------------------------------------------------------------------

/** Sum of the execution units the builder set on every redeemer. */
export function txBudget(cbor: string): { mem: bigint; cpu: bigint; bytes: number } {
  const tx = L.CML.Transaction.from_cbor_hex(cbor);
  const rs = tx.witness_set().redeemers();
  let mem = 0n;
  let cpu = 0n;
  if (rs) {
    const legacy = rs.as_arr_legacy_redeemer();
    if (legacy) {
      for (let i = 0; i < legacy.len(); i++) {
        const u = legacy.get(i).ex_units();
        mem += u.mem();
        cpu += u.steps();
      }
    }
    const map = rs.as_map_redeemer_key_to_redeemer_val();
    if (map) {
      const keys = map.keys();
      for (let i = 0; i < keys.len(); i++) {
        const u = map.get(keys.get(i))!.ex_units();
        mem += u.mem();
        cpu += u.steps();
      }
    }
  }
  return { mem, cpu, bytes: cbor.length / 2 };
}

const MAX_MEM = 14_000_000n;
const MAX_CPU = 10_000_000_000n;
const MAX_TX_BYTES = 16_384;

test("E07: Settle budget at N = 1, 5, 10, 20 on real transactions", async () => {
  const b = await setup({ investors: 4 });
  // Reference scripts, as the keeper will use them.
  const { buildPublishRefs } = await import("../../src/lib/offering-v2-tx");
  const pub = await buildPublishRefs(as(b, b.issuer), b.issuer.address);
  const pubHash = await run(b, b.issuer, pub);
  const outs = await b.lucid.utxosByOutRef(
    [0, 1, 2].map((i) => ({ txHash: pubHash, outputIndex: i })),
  );
  b.ctx.refs = { offering: outs[0], pledge: outs[1], fraction: outs[2] };

  const rows: string[] = [];
  for (const n of [1, 5, 10, KEEPER_BATCH]) {
    await pledgeAll(
      b,
      Array.from({ length: n }, (_, i) => BigInt(1 + (i % 3))),
    );
    const ps = await findPledges(b.ctx);
    assert.equal(ps.length, n);
    const built = await buildSettle(
      as(b, b.keeper),
      ps,
      [keyHash(b.keeper.address)],
      b.emulator.now(),
    );
    const u = txBudget(built.tx.toCBOR());
    rows.push(
      `N=${String(n).padStart(2)} mem ${u.mem} (${((Number(u.mem) / Number(MAX_MEM)) * 100).toFixed(1)}%) ` +
        `cpu ${u.cpu} (${((Number(u.cpu) / Number(MAX_CPU)) * 100).toFixed(1)}%) size ${u.bytes} B`,
    );
    assert.ok(u.mem * 10n <= MAX_MEM * 8n, `N=${n}: memory leaves 20% headroom (${u.mem})`);
    assert.ok(u.cpu * 10n <= MAX_CPU * 8n, `N=${n}: cpu leaves 20% headroom (${u.cpu})`);
    assert.ok(u.bytes <= MAX_TX_BYTES, `N=${n}: fits the transaction size limit (${u.bytes} B)`);
    await run(b, b.keeper, built);
  }
  console.log(`[fv2 emulator budget]\n  ${rows.join("\n  ")}`);
});
