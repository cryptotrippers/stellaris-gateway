/**
 * Self-test of the Preprod test-offering bootstrap (scripts/fv2/lib/bootstrap.ts)
 * on Lucid's Emulator with the real compiled scripts: publish the reference
 * offering, publish the reference scripts to the lock address, read it back, and use the
 * references in a pledge and a settle. Every transaction passes the S1 guard.
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
  TEST_DOCS_TEXT,
  TEST_OFFERING,
  buildOpenStage,
  buildRefsStage,
  deriveTestOffering,
  docsHash,
  guard,
  pickSeed,
  refLockAddress,
  testOpeningState,
} from "../../scripts/fv2/lib/bootstrap";
import { readState } from "../../src/lib/offering-v2-chain";
import {
  buildPledge,
  buildSettle,
  findPledges,
  findState,
  type LucidModTx,
  type V2Context,
} from "../../src/lib/offering-v2-tx";

const TSRA = `${PREPROD_TSRA.policyId}${PREPROD_TSRA.assetNameHex}`;
const kh = (a: string) => getAddressDetails(a).paymentCredential!.hash;

test("fv2 bootstrap: open, refs to the lock, read back, then pledge and settle with refs", async () => {
  const operator = generateEmulatorAccountFromPrivateKey({ lovelace: 500_000_000n });
  const committee = [1, 2, 3].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 20_000_000n }),
  );
  const investor = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
    [TSRA]: 1_000_000_000n,
  });
  const emulator = new Emulator([operator, ...committee, investor]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(operator.privateKey);

  async function submit(stage: { tx: L.TxSignBuilder }, cosigners: { privateKey: string }[] = []) {
    let s = stage.tx.sign.withWallet();
    for (const c of cosigners) s = s.sign.withPrivateKey(c.privateKey);
    const h = await (await s.complete()).submit();
    emulator.awaitBlock(1);
    assert.ok(await lucid.awaitTx(h));
    return h;
  }

  // Seed first (a pure-ADA UTxO), then derive.
  const seed = pickSeed(await lucid.wallet().getUtxos());
  const scripts = deriveTestOffering(seed, "Custom");
  assert.equal(scripts.unit.policyId, PREPROD_TSRA.policyId);

  // 1. Open first: it consumes the seed (the operator may hold only one UTxO).
  const committeeKeys = committee.map((c) => kh(c.address));
  const now = emulator.now();
  const state = testOpeningState(
    scripts,
    { operatorAddress: operator.address, committee: committeeKeys, threshold: 2 },
    now,
  );
  assert.equal(state.terms.docsHash, docsHash(TEST_DOCS_TEXT));
  const open = await buildOpenStage(
    lucid,
    scripts,
    seed,
    state,
    [kh(operator.address), ...committeeKeys.slice(0, 2)],
    now,
  );
  await guard(lucid, open);
  await submit(open, committee.slice(0, 2));

  // 2. Then the reference scripts, parked where nothing can spend them.
  const refs = await buildRefsStage(lucid, scripts);
  await guard(lucid, refs);
  const refsHash = await submit(refs);
  const lock = refLockAddress("Custom");
  const parked = await lucid.utxosAt(lock);
  assert.equal(parked.length, 3);
  assert.ok(parked.every((u) => u.scriptRef));
  assert.equal(refs.record.offering, `${refsHash}#0`);

  // 3. Read back: the genuine State, exactly the opening datum.
  const [ref0, ref1, ref2] = await lucid.utxosByOutRef(
    [0, 1, 2].map((i) => ({ txHash: refsHash, outputIndex: i })),
  );
  const ctx: V2Context = {
    lucid,
    mod: L as unknown as LucidModTx,
    scripts,
    refs: { offering: ref0, pledge: ref1, fraction: ref2 },
  };
  const live = await findState(ctx);
  assert.deepEqual(readState(live.utxo.datum), state);
  assert.equal(live.utxo.assets.lovelace, 5_000_000n);
  assert.equal(open.record.offeringHash, scripts.offering.hash);
  assert.equal(
    (open.record.terms as { softCap: string }).softCap,
    TEST_OFFERING.softCap.toString(),
  );

  // 4. The references work: a pledge and a keeper settle that read them.
  lucid.selectWallet.fromPrivateKey(investor.privateKey);
  const p = await buildPledge(ctx, investor.address, 3n, emulator.now());
  await guard(lucid, { name: "open", tx: p.tx, intent: p.intent, record: {} });
  await submit(p);
  lucid.selectWallet.fromPrivateKey(operator.privateKey);
  const s = await buildSettle(ctx, await findPledges(ctx), [kh(operator.address)], emulator.now());
  await guard(lucid, { name: "open", tx: s.tx, intent: s.intent, record: {} });
  const body = L.CML.Transaction.from_cbor_hex(s.tx.toCBOR()).body();
  assert.equal(body.reference_inputs()?.len(), 3, "settle reads the three reference scripts");
  await submit(s);
  assert.equal((await findState(ctx)).state.book.settled, 3n);
});

test("fv2 bootstrap: the seed is a pure-ADA UTxO, never one carrying tokens", () => {
  const u = (i: number, assets: Record<string, bigint>) =>
    ({ txHash: "aa".repeat(32), outputIndex: i, address: "x", assets }) as L.UTxO;
  assert.equal(
    pickSeed([u(0, { lovelace: 5n, [TSRA]: 1n }), u(1, { lovelace: 3n })]).outputIndex,
    1,
  );
  assert.throws(() => pickSeed([u(0, { lovelace: 5n, [TSRA]: 1n })]), /no ADA-only UTxO/);
});
