/**
 * Self-test of the Preprod smoke test (scripts/fv2/lib/smoke.ts): open the
 * offering with the bootstrap code, then run every smoke stage in order on
 * Lucid's Emulator with the real scripts, each through the S1 guard, and check
 * the State and every party's balance at the end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "@lucid-evolution/lucid";
import {
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
} from "@lucid-evolution/lucid";
import {
  PREPROD_TSRA,
  buildOpenStage,
  buildRefsStage,
  deriveTestOffering,
  guard,
  pickSeed,
  testOpeningState,
} from "../../scripts/fv2/lib/bootstrap";
import {
  COMMITTEE_STAGES,
  SMOKE_RELEASE,
  SMOKE_STAGES,
  buildSmokeStage,
  chainCaughtUp,
  expectedEnd,
} from "../../scripts/fv2/lib/smoke";
import {
  findPledges,
  findState,
  type LucidModTx,
  type V2Context,
} from "../../src/lib/offering-v2-tx";

const TSRA = `${PREPROD_TSRA.policyId}${PREPROD_TSRA.assetNameHex}`;
const kh = (a: string) => getAddressDetails(a).paymentCredential!.hash;
const tsraOf = (u: L.UTxO[]) => u.reduce((a, x) => a + (x.assets[TSRA] ?? 0n), 0n);

test("fv2 smoke: pledges, settle, close, release, commit, claim — end state as expected", async () => {
  // The operator starts with ADA only (a clean seed), and receives TSRA from a
  // separate account, as on Preprod where its wallet holds several UTxOs.
  const operator = generateEmulatorAccountFromPrivateKey({ lovelace: 1_000_000_000n });
  const bank = generateEmulatorAccountFromPrivateKey({
    lovelace: 50_000_000n,
    [TSRA]: 5_000_000_000n,
  });
  const committee = [1, 2, 3].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n }),
  );
  const emulator = new Emulator([operator, bank, ...committee]);
  const lucid = await Lucid(emulator, "Custom");
  emulator.awaitSlot(300);

  const submit = async (tx: L.TxSignBuilder, cosign: { privateKey: string }[] = []) => {
    let s = tx.sign.withWallet();
    for (const c of cosign) s = s.sign.withPrivateKey(c.privateKey);
    const h = await (await s.complete()).submit();
    emulator.awaitBlock(1);
    assert.ok(await lucid.awaitTx(h));
  };

  lucid.selectWallet.fromPrivateKey(bank.privateKey);
  await submit(
    await lucid
      .newTx()
      .pay.ToAddress(operator.address, { lovelace: 5_000_000n, [TSRA]: 2_000_000_000n })
      .complete(),
  );
  lucid.selectWallet.fromPrivateKey(operator.privateKey);

  // Bootstrap: open, then refs (the Preprod order).
  const seed = pickSeed(await lucid.wallet().getUtxos());
  const scripts = deriveTestOffering(seed, "Custom");
  const board = committee.map((c) => kh(c.address));
  const state = testOpeningState(
    scripts,
    { operatorAddress: operator.address, committee: board, threshold: 2 },
    emulator.now(),
  );
  const open = await buildOpenStage(
    lucid,
    scripts,
    seed,
    state,
    [kh(operator.address), ...board.slice(0, 2)],
    emulator.now(),
  );
  await guard(lucid, open);
  await submit(open.tx, committee.slice(0, 2));
  const refs = await buildRefsStage(lucid, scripts);
  await guard(lucid, refs);
  await submit(refs.tx);
  const h = refs.tx.toHash();
  const [r0, r1, r2] = await lucid.utxosByOutRef(
    [0, 1, 2].map((i) => ({ txHash: h, outputIndex: i })),
  );
  const ctx: V2Context = {
    lucid,
    mod: L as unknown as LucidModTx,
    scripts,
    refs: { offering: r0, pledge: r1, fraction: r2 },
  };

  const roles = {
    operatorAddress: operator.address,
    operatorKey: kh(operator.address),
    owners: [operator.address, committee[0]!.address, committee[1]!.address] as [
      string,
      string,
      string,
    ],
    signers: board.slice(0, 2),
  };
  const tsraBefore = tsraOf(await lucid.utxosAt(operator.address));

  for (const name of SMOKE_STAGES) {
    lucid.selectWallet.fromPrivateKey(operator.privateKey);
    const stage = await buildSmokeStage(ctx, name, roles, emulator.now());
    await guard(lucid, { name: "open", tx: stage.tx, intent: stage.intent, record: {} });
    await submit(stage.tx, COMMITTEE_STAGES.has(name) ? committee.slice(0, 2) : []);
    assert.ok(await chainCaughtUp(ctx, name, stage.tx.toHash(), 1, 0), `${name} output visible`);
    if (name === "pledge-3") assert.equal((await findPledges(ctx)).length, 3);
  }

  const end = expectedEnd();
  const { state: s, utxo } = await findState(ctx);
  assert.equal(s.status, end.status);
  assert.equal(s.book.settled, end.settled);
  assert.equal(s.book.outstanding, end.outstanding);
  assert.equal(s.book.released, end.released);
  assert.equal(s.book.fees, end.fees);
  assert.equal(s.book.escrowed, end.escrowed);
  assert.equal(s.book.netProceeds, end.netProceeds);
  assert.equal(s.period, end.period);
  assert.equal(s.manifestRoot, end.manifestRoot);
  assert.equal(utxo.assets[TSRA], s.book.escrowed - s.book.released + s.book.pool);
  assert.equal(utxo.assets.lovelace, 5_000_000n, "the State keeps its rider");

  // Each owner holds its fractions.
  const frac = async (a: string) =>
    (await lucid.utxosAt(a)).reduce((x, u) => x + (u.assets[scripts.fraction.unit] ?? 0n), 0n);
  assert.equal(await frac(operator.address), 40n);
  assert.equal(await frac(committee[0]!.address), 35n);
  assert.equal(await frac(committee[1]!.address), 30n);

  // The operator paid 1,050 TSRA in and got back the release and the fee.
  const tsraAfter = tsraOf(await lucid.utxosAt(operator.address));
  assert.equal(tsraBefore - tsraAfter, 1_050_000_000n - SMOKE_RELEASE - 10_500_000n);
});
