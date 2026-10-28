/**
 * E07 — attacks on fraction_vault v2, built by hand around the builders'
 * own checks, against the REAL compiled scripts on Lucid's Emulator.
 *
 * Each attack is one function with a `tamper` flag. With the flag off the
 * transaction is the honest one and must go through (the control); with it
 * on, Lucid's evaluation of the real UPLC must refuse it. So a refusal can
 * only come from the change, never from a broken fixture. These mirror the
 * whole-transaction Aiken tests (fv2_scenarios.ak) on serialised transactions.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as L from "@lucid-evolution/lucid";
import type { TxBuilder, UTxO } from "@lucid-evolution/lucid";
import {
  encodeOfferingAction,
  encodeOutRef,
  encodePledge,
  encodePledgeAction,
  encodePledgeMint,
  encodeState,
  nextState,
  settledState,
  type OfferingAction,
  type V2State,
} from "../../src/lib/offering-v2-chain";
import {
  STATE_RIDER,
  bech32Of,
  buildAction,
  buildSettle,
  findPledges,
  findState,
  plutusAddressOf,
  slotAligned,
  type LivePledge,
} from "../../src/lib/offering-v2-tx";
import {
  JUNK,
  TSRA,
  T,
  as,
  keyHash,
  pledgeAll,
  run,
  setup,
  type World,
} from "./fv2-emulator-fixture";

const v3 = (script: string) => ({ type: "PlutusV3" as const, script });
const VOID = L.Data.to(new L.Constr(0, []));

/** Complete and submit as `wallet` (no intent guard: these bypass the builders). */
async function submitRaw(w: World, b: TxBuilder, signers: Parameters<typeof run>[1][]) {
  const tx = await b.complete();
  let s = tx.sign.withWallet();
  for (const c of signers) s = s.sign.withPrivateKey(c.privateKey);
  const h = await (await s.complete()).submit();
  w.emulator.awaitBlock(1);
  assert.ok(await w.lucid.awaitTx(h));
}

/** The real scripts must refuse: Lucid evaluates the UPLC in `complete()`. */
async function refused(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => {
    const m = String(e instanceof Error ? e.message : e);
    assert.match(m, /script|evaluat|validation|failed|uplc|redeemer/i, m.slice(0, 300));
    return true;
  });
}

function stateValue(w: World, s: V2State, rider: bigint, extra: Record<string, bigint> = {}) {
  const units = s.book.escrowed - s.book.released + s.book.pool;
  const v: Record<string, bigint> = { lovelace: rider, [w.scripts.offering.threadUnit]: 1n };
  if (units) v[TSRA] = units;
  return { ...v, ...extra };
}

/** A hand-built State transition: State in, State out first, then `outs`. */
function stateTx(
  w: World,
  live: { utxo: UTxO },
  action: OfferingAction,
  next: V2State,
  opts: {
    outs?: [string, Record<string, bigint>][];
    stateExtra?: Record<string, bigint>;
    mint?: Record<string, bigint>;
    signers?: string[];
  } = {},
): TxBuilder {
  let b = w.lucid
    .newTx()
    .collectFrom([live.utxo], encodeOfferingAction(L, action))
    .attach.SpendingValidator(v3(w.scripts.offering.cbor))
    .pay.ToContract(
      live.utxo.address,
      { kind: "inline", value: encodeState(L, next) },
      stateValue(w, next, live.utxo.assets.lovelace ?? STATE_RIDER, opts.stateExtra),
    );
  for (const [to, v] of opts.outs ?? []) b = b.pay.ToAddress(to, v);
  if (opts.mint) {
    b = b.mintAssets(opts.mint, VOID).attach.MintingPolicy(v3(w.scripts.fraction.cbor));
  }
  for (const k of opts.signers ?? []) b = b.addSignerKey(k);
  const now = w.emulator.now();
  return b.validFrom(slotAligned(w.ctx, now)).validTo(now + 600_000);
}

let w: World;
before(async () => {
  w = await setup();
  await pledgeAll(w, [5n, 20n, 400n]);
});

// --------------------------------------------------------------------------

/** Settle by hand; with `tamper`, alice's fractions go to mallory. */
async function settleByHand(pledges: LivePledge[], tamper: boolean) {
  const live = await findState(w.ctx);
  const ordered = [...pledges].sort((a, b) =>
    a.utxo.txHash === b.utxo.txHash
      ? a.utxo.outputIndex - b.utxo.outputIndex
      : a.utxo.txHash < b.utxo.txHash
        ? -1
        : 1,
  );
  const next = settledState(
    live.state,
    ordered.map((p) => p.pledge.qty),
  );
  const q = ordered.reduce((a, p) => a + p.pledge.qty, 0n);
  as(w, w.keeper);
  let b = w.lucid
    .newTx()
    .collectFrom([live.utxo], encodeOfferingAction(L, { kind: "settle" }))
    .collectFrom(
      ordered.map((p) => p.utxo),
      encodePledgeAction(L, { kind: "settlePledge" }),
    )
    .attach.SpendingValidator(v3(w.scripts.offering.cbor))
    .attach.SpendingValidator(v3(w.scripts.pledge.cbor))
    .mintAssets({ [w.scripts.fraction.unit]: q }, VOID)
    .attach.MintingPolicy(v3(w.scripts.fraction.cbor))
    .mintAssets(
      { [w.scripts.pledge.markerUnit]: -BigInt(ordered.length) },
      encodePledgeMint(L, "burn"),
    )
    .attach.MintingPolicy(v3(w.scripts.pledge.cbor))
    .pay.ToContract(
      live.utxo.address,
      { kind: "inline", value: encodeState(L, next) },
      stateValue(w, next, live.utxo.assets.lovelace!),
    );
  ordered.forEach((p, i) => {
    const owner = bech32Of(w.ctx, p.pledge.owner);
    const to = tamper && i === 0 ? w.mallory.address : owner;
    b = b.pay.ToAddress(to, { lovelace: 2_000_000n, [w.scripts.fraction.unit]: p.pledge.qty });
  });
  const now = w.emulator.now();
  b = b
    .addSignerKey(keyHash(w.keeper.address))
    .validFrom(slotAligned(w.ctx, now))
    .validTo(now + 600_000);
  return submitRaw(w, b, []);
}

test("attack: Settle paying a pledge's fractions to someone else is refused", async () => {
  const two = (await findPledges(w.ctx)).filter((p) => p.pledge.qty !== 400n);
  await refused(settleByHand(two, true));
  await settleByHand(two, false); // control: the honest batch settles
  assert.equal((await findState(w.ctx)).state.book.settled, 25n);
});

// --------------------------------------------------------------------------

/** Pledge by hand; with `tamper`, deposit one unit short. */
async function pledgeByHand(qty: bigint, tamper: boolean) {
  const inv = w.investors[0]!;
  const live = await findState(w.ctx);
  as(w, inv);
  const now = slotAligned(w.ctx, w.emulator.now());
  const cost = qty * live.state.terms.price - (tamper ? 1n : 0n);
  const b = w.lucid
    .newTx()
    .readFrom([live.utxo])
    .mintAssets({ [w.scripts.pledge.markerUnit]: 1n }, encodePledgeMint(L, "mint"))
    .attach.MintingPolicy(v3(w.scripts.pledge.cbor))
    .pay.ToContract(
      w.scripts.pledge.address,
      {
        kind: "inline",
        value: encodePledge(L, {
          offering: w.scripts.offering.hash,
          owner: plutusAddressOf(w.ctx.mod, inv.address),
          qty,
          created: BigInt(now),
        }),
      },
      { lovelace: 2_000_000n, [TSRA]: cost, [w.scripts.pledge.markerUnit]: 1n },
    )
    .validFrom(now)
    .validTo(now + 600_000);
  return submitRaw(w, b, []);
}

test("attack: a pledge depositing one unit short is refused", async () => {
  await refused(pledgeByHand(3n, true));
  await pledgeByHand(3n, false);
});

// --------------------------------------------------------------------------

test("attack: once operating, a release paid to anyone but the SPV is refused", async () => {
  // Settle the 400 and the 3, then close.
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
  const board = w.boardKeys.slice(0, 2);
  await run(
    w,
    w.committee[0]!,
    await buildAction(
      as(w, w.committee[0]!),
      { kind: "closeRaise" },
      { signers: board, nowMs: w.emulator.now() },
    ),
    [w.committee[1]!],
  );
  const release = async (to: string) => {
    const live = await findState(w.ctx);
    const a: OfferingAction = { kind: "release", amount: T(100), evidenceHash: "e5".repeat(32) };
    as(w, w.committee[0]!);
    const b = stateTx(w, live, a, nextState(live.state, a), {
      outs: [[to, { lovelace: 2_000_000n, [TSRA]: T(100) }]],
      signers: board,
    });
    return submitRaw(w, b, [w.committee[1]!]);
  };
  await refused(release(w.mallory.address));
  await release(w.spv.address); // control
  assert.equal((await findState(w.ctx)).state.book.released, T(100));
});

test("attack: junk tokens on the State (token flood) are refused", async () => {
  const commit = async (flood: boolean) => {
    const live = await findState(w.ctx);
    const a: OfferingAction = {
      kind: "commitPeriod",
      period: live.state.period + 1n,
      manifestRoot: "ab".repeat(32),
    };
    as(w, w.mallory);
    const b = stateTx(w, live, a, nextState(live.state, a), {
      stateExtra: flood ? { [JUNK]: 1n } : {},
      signers: w.boardKeys.slice(0, 2),
    });
    return submitRaw(w, b, w.committee.slice(0, 2));
  };
  await refused(commit(true));
  await commit(false); // control: the same commit without junk
});

test("attack: minting fractions outside Settle is refused", async () => {
  const live = await findState(w.ctx);
  const a: OfferingAction = {
    kind: "commitPeriod",
    period: live.state.period + 1n,
    manifestRoot: "cd".repeat(32),
  };
  as(w, w.mallory);
  const b = stateTx(w, live, a, nextState(live.state, a), {
    mint: { [w.scripts.fraction.unit]: 10n },
    outs: [[w.mallory.address, { lovelace: 2_000_000n, [w.scripts.fraction.unit]: 10n }]],
    signers: w.boardKeys.slice(0, 2),
  });
  await refused(submitRaw(w, b, w.committee.slice(0, 2)));
});

test("attack: the State cannot pay out units it does not book", async () => {
  const live = await findState(w.ctx);
  const a: OfferingAction = {
    kind: "commitPeriod",
    period: live.state.period + 1n,
    manifestRoot: "ef".repeat(32),
  };
  const next = nextState(live.state, a);
  as(w, w.mallory);
  // Same datum, one TSRA fewer in the State, that TSRA paid to mallory.
  const b = stateTx(w, live, a, next, {
    stateExtra: { [TSRA]: next.book.escrowed - next.book.released + next.book.pool - T(1) },
    outs: [[w.mallory.address, { lovelace: 2_000_000n, [TSRA]: T(1) }]],
    signers: w.boardKeys.slice(0, 2),
  });
  await refused(submitRaw(w, b, w.committee.slice(0, 2)));
});

// --------------------------------------------------------------------------

test("attack: a refund of someone else's pledge paid to the attacker is refused", async () => {
  const r = await setup({ windowMs: 60_000 });
  await pledgeAll(r, [5n]);
  const [p] = await findPledges(r.ctx);
  // Past the window, still Raising: anyone may refund, but only to the owner.
  const t = (await findState(r.ctx)).state.terms;
  r.emulator.awaitSlot(
    Math.ceil((Number(t.deadline + t.settleWindow) - r.emulator.now()) / 1000) + 5,
  );
  const refund = async (to: string) => {
    const live = await findState(r.ctx);
    as(r, r.mallory);
    const now = r.emulator.now();
    const value: Record<string, bigint> = {};
    for (const [u, q] of Object.entries(p!.utxo.assets))
      if (u !== r.scripts.pledge.markerUnit) value[u] = q;
    const b = r.lucid
      .newTx()
      .readFrom([live.utxo])
      .collectFrom([p!.utxo], encodePledgeAction(L, { kind: "refundPledge", outIx: 0 }))
      .attach.SpendingValidator(v3(r.scripts.pledge.cbor))
      .mintAssets({ [r.scripts.pledge.markerUnit]: -1n }, encodePledgeMint(L, "burn"))
      .attach.MintingPolicy(v3(r.scripts.pledge.cbor))
      .pay.ToAddressWithData(to, { kind: "inline", value: encodeOutRef(L, p!.utxo) }, value)
      .validFrom(slotAligned(r.ctx, now))
      .validTo(now + 600_000);
    return submitRaw(r, b, []);
  };
  await refused(refund(r.mallory.address));
  await refund(r.investors[0]!.address); // control: back to the owner
});
