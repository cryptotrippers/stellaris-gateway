/**
 * Tessera browser builders (src/lib/tessera-tx.ts) on Lucid's Emulator with
 * the real compiled Tessera scripts: the whole preprod-v1 deployment rebuilt by
 * the operator builders, reference scripts published as on Preprod, and every
 * user flow built by the BROWSER code, checked by the S1 intent guard, signed
 * and submitted: stake, unstake → claim, instant, request → settle (by another
 * wallet), plus the refusals (cooldown, limits, UTC-day guard, network guard,
 * Cancel on v1 (C-1), contention, a wrong reference script), and the pins
 * against deployments/preprod-v1.json.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as L from "@lucid-evolution/lucid";
import { applyFirstLoss, rewardAddress } from "../../scripts/tessera/lib/blueprint";
import { buildRef } from "../../scripts/tessera/lib/build-5b";
import { setupDeployment } from "../../scripts/tessera/lib/emulator-setup";
import { tsraToUnits } from "../../scripts/tessera/lib/genesis";
import { appliedQueueScript } from "../../scripts/tessera/gen-browser-pins";
import {
  TESSERA_PREPROD_V1_DEPLOYMENT,
  type TesseraDeployment,
} from "../../src/lib/tessera-deployment";
import { TESSERA_QUEUE_SCRIPT_PREPROD_V1 } from "../../src/lib/tessera-queue-script.generated";
import {
  TesseraRefused,
  assertPreprodWallet,
  buildCancel,
  buildClaim,
  buildInstant,
  buildRequest,
  buildRequestUnstake,
  buildSettle,
  buildStakeShort,
  classifyTesseraError,
  loadRefs,
  requests,
  tickets,
  vaultState,
  type TesseraBuilt,
  type TesseraCtx,
} from "../../src/lib/tessera-tx";
import { assertIntent, walletViewOf } from "../../src/lib/tx-sign-guarded";
import { trustDerivedScript } from "../../src/lib/tx-trust.shared";

type D = Awaited<ReturnType<typeof setupDeployment>>;
let d: D;
let dep: TesseraDeployment;
let ctx: TesseraCtx;

const bal = async (unit: string) =>
  (await d.lucid.wallet().getUtxos()).reduce((a, u) => a + (u.assets[unit] ?? 0n), 0n);

/** As the S1 guard would: check, sign as the selected wallet, submit, confirm. */
async function run(b: TesseraBuilt): Promise<string> {
  assert.ok(b.tx.toCBOR().length / 2 <= 16_384, "fits the transaction size limit");
  await assertIntent(b.tx.toCBOR(), b.intent, await walletViewOf(d.lucid));
  const h = await (await b.tx.sign.withWallet().complete()).submit();
  d.emulator.awaitBlock(1);
  assert.ok(await d.lucid.awaitTx(h), "confirmed");
  return h;
}
const asOperator = () => {
  d.lucid.overrideUTxOs([]);
  d.lucid.selectWallet.fromPrivateKey(d.operator.privateKey);
};

before(async () => {
  d = await setupDeployment();
  // Reference scripts, as published on Preprod in Stage 5b.
  const fl = applyFirstLoss(d.v.firstLoss!.seed, d.rplan.reserve.hash);
  const steps = [
    await buildRef(d.lucid, "refVault", d.vault),
    await buildRef(d.lucid, "refOps", d.ops),
    await buildRef(d.lucid, "refFirstLoss", fl),
  ];
  await d.submit(steps, []);
  const refOf = (i: number) => steps[i]!.derived.find((u) => u.scriptRef)!;
  const q = d.q.queue!;
  dep = {
    label: "emulator",
    network: "Custom",
    reserve: {
      hash: d.rplan.reserve.hash,
      address: d.rplan.reserveAddress,
      tsraUnit: d.rplan.reserve.hash + L.fromText("TSRA"),
      configUnit: d.rplan.units.config,
    },
    vault: {
      hash: d.vault.hash,
      address: d.v.vault!.address,
      stateUnit: d.v.vault!.stateUnit,
      stsraUnit: d.vault.hash + L.fromText("sTSRA"),
      markerUnit: d.vault.hash + L.fromText("position"),
    },
    ops: { hash: d.ops.hash, rewardAddress: rewardAddress("Custom", d.ops) },
    queue: {
      hash: d.queue.hash,
      address: q.address,
      configUnit: q.configUnit,
      shortUnit: q.shortUnit,
      requestUnit: d.queue.hash + L.fromText("request"),
      shardUnits: q.shardUnits,
      script: d.queue.script.script,
    },
    flow: { hash: d.qs.flow.hash, rewardAddress: rewardAddress("Custom", d.qs.flow) },
    refs: {
      vault: { txHash: refOf(0).txHash, outputIndex: refOf(0).outputIndex },
      ops: { txHash: refOf(1).txHash, outputIndex: refOf(1).outputIndex },
      flow: { txHash: d.qctx.refs.flow!.txHash, outputIndex: d.qctx.refs.flow!.outputIndex },
    },
    payoutUnit: d.q.tusd!.unit,
    features: { cancel: false },
  };
  for (const [h, n] of [
    [dep.reserve.hash, "reserve"],
    [dep.vault.hash, "vault"],
    [dep.ops.hash, "ops"],
    [dep.queue.hash, "queue"],
    [dep.flow.hash, "flow"],
  ] as const)
    trustDerivedScript(h, `emulator ${n}`);
  ctx = { lucid: d.lucid, L, dep };
  asOperator();
});

// ------------------------------------------------------------------ pins

test("pins: the bundled queue script is the one re-derived from the blueprint and the recorded seed", () => {
  const rec = JSON.parse(readFileSync("deployments/preprod-v1.json", "utf8"));
  assert.equal(appliedQueueScript(rec), TESSERA_QUEUE_SCRIPT_PREPROD_V1);
  assert.equal(
    L.validatorToScriptHash({ type: "PlutusV3", script: TESSERA_QUEUE_SCRIPT_PREPROD_V1 }),
    rec.queue.scriptHash,
  );
});

test("pins: TESSERA_PREPROD_V1_DEPLOYMENT matches deployments/preprod-v1.json", () => {
  const r = JSON.parse(readFileSync("deployments/preprod-v1.json", "utf8"));
  const p = TESSERA_PREPROD_V1_DEPLOYMENT;
  const ref = (s: string) => ({ txHash: s.split("#")[0], outputIndex: Number(s.split("#")[1]) });
  assert.equal(p.reserve.hash, r.reserve.scriptHash);
  assert.equal(p.reserve.address, r.reserve.address);
  assert.equal(p.reserve.tsraUnit, r.reserve.tsraUnit);
  assert.equal(p.reserve.configUnit, r.reserve.configUnit);
  assert.equal(p.vault.hash, r.vault.scriptHash);
  assert.equal(p.vault.address, r.vault.address);
  assert.equal(p.vault.stateUnit, r.vault.stateUnit);
  assert.equal(p.vault.stsraUnit, r.vault.stsraUnit);
  assert.equal(p.ops.hash, r.opsStake.scriptHash);
  assert.equal(p.ops.rewardAddress, r.opsStake.rewardAddress);
  assert.equal(p.queue.hash, r.queue.scriptHash);
  assert.equal(p.queue.address, r.queue.address);
  assert.equal(p.queue.configUnit, r.queue.configUnit);
  assert.equal(p.queue.shortUnit, r.queue.shortUnit);
  assert.deepEqual([...p.queue.shardUnits], r.queue.shardUnits);
  assert.equal(p.flow.hash, r.queueStake.flow.scriptHash);
  assert.equal(p.flow.rewardAddress, r.queueStake.flow.rewardAddress);
  assert.deepEqual(p.refs.vault, ref(r.stage5b.refVault.refUtxo));
  assert.deepEqual(p.refs.ops, ref(r.stage5b.refOps.refUtxo));
  assert.deepEqual(p.refs.flow, ref(r.refFlow.refUtxo));
  assert.equal(r.refFlow.scriptHash, p.flow.hash);
  assert.equal(p.payoutUnit, r.tusd.unit);
  assert.equal(p.features.cancel, false, "preprod-v1 has C-1");
});

// ------------------------------------------------------------------ guards

test("guards: a mainnet address or network id is refused", () => {
  assert.throws(() => assertPreprodWallet("addr1qxy"), TesseraRefused);
  assert.throws(() => assertPreprodWallet("addr_test1vxyz", 1), /not on Preprod/);
  assertPreprodWallet("addr_test1vxyz", 0);
});

test("guards: a reference script that is not the expected script is refused", async () => {
  const bad: TesseraCtx = { ...ctx, dep: { ...dep, refs: { ...dep.refs, vault: dep.refs.ops } } };
  await assert.rejects(loadRefs(bad), /not the expected script/);
  const tampered: TesseraCtx = {
    ...ctx,
    dep: { ...dep, queue: { ...dep.queue, script: TESSERA_QUEUE_SCRIPT_PREPROD_V1 } },
  };
  asOperator();
  await assert.rejects(
    buildRequest(tampered, tsraToUnits("100"), d.emulator.now()),
    /does not match/,
  );
});

// ------------------------------------------------------------------ vault

test("stake: 100 TSRA → sTSRA at the vault price; the State books it", async () => {
  asOperator();
  const s0 = await vaultState(ctx);
  const b = await buildStakeShort(ctx, tsraToUnits("100"), d.emulator.now());
  const before = await bal(dep.vault.stsraUnit);
  await run(b);
  assert.equal(await bal(dep.vault.stsraUnit), before + BigInt(b.summary.stsraMinted!));
  const s1 = await vaultState(ctx);
  assert.equal(
    s1.assets[dep.reserve.tsraUnit]! - s0.assets[dep.reserve.tsraUnit]!,
    tsraToUnits("100"),
  );
});

test("unstake → claim: a Ticket of TSRA, refused before the cooldown, paid after", async () => {
  asOperator();
  const me = await d.lucid.wallet().address();
  const b = await buildRequestUnstake(ctx, tsraToUnits("50"), d.emulator.now());
  await run(b);
  const mine = await tickets(ctx, me);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.value, BigInt(b.summary.ticketTsra!));
  await assert.rejects(buildClaim(ctx, mine[0]!, d.emulator.now()), /can be claimed after/);

  d.emulator.awaitSlot(Math.ceil((Number(mine[0]!.claimAfter) - d.emulator.now()) / 1000) + 180);
  asOperator();
  const before = await bal(dep.reserve.tsraUnit);
  await run(await buildClaim(ctx, mine[0]!, d.emulator.now()));
  assert.equal(await bal(dep.reserve.tsraUnit), before + mine[0]!.value);
  assert.equal((await tickets(ctx, me)).length, 0);
});

// ------------------------------------------------------------------ queue

test("instant: 10 TSRA → 10 tUSD now; above instant_max refused", async () => {
  asOperator();
  const before = await bal(dep.payoutUnit);
  await run(await buildInstant(ctx, tsraToUnits("10"), d.emulator.now()));
  assert.equal(await bal(dep.payoutUnit), before + tsraToUnits("10"));
  await assert.rejects(buildInstant(ctx, tsraToUnits("10000000"), d.emulator.now()), /limited to/);
});

test("request → settle: refused before payable; settled by another wallet; the owner is paid", async () => {
  asOperator();
  const me = await d.lucid.wallet().address();
  const meKey = L.getAddressDetails(me).paymentCredential!.hash;
  // Keep clear of the UTC-day edge for this one.
  const toMidnight = 86_400_000 - (d.emulator.now() % 86_400_000);
  if (toMidnight < 40 * 60_000) d.emulator.awaitSlot(Math.ceil(toMidnight / 1000) + 120);
  asOperator();
  await run(await buildRequest(ctx, tsraToUnits("100"), d.emulator.now()));
  const mine = await requests(ctx, meKey);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.qty, tsraToUnits("100"));
  await assert.rejects(buildSettle(ctx, mine, d.emulator.now()), /payable only after/);

  d.emulator.awaitSlot(Math.ceil((Number(mine[0]!.payableAfter) - d.emulator.now()) / 1000) + 180);
  asOperator();
  const tusd0 = await bal(dep.payoutUnit);
  // A keeper (here a committee member's wallet) settles it.
  d.lucid.overrideUTxOs([]);
  d.lucid.selectWallet.fromPrivateKey(d.committee[0]!.privateKey);
  await run(await buildSettle(ctx, mine, d.emulator.now()));
  asOperator();
  assert.equal(await bal(dep.payoutUnit), tusd0 + tsraToUnits("100"));
  assert.equal((await requests(ctx, meKey)).length, 0);
});

test("request: refused with under 15 minutes left in the UTC day", async () => {
  const toMidnight = 86_400_000 - (d.emulator.now() % 86_400_000);
  d.emulator.awaitSlot(Math.max(0, Math.ceil((toMidnight - 10 * 60_000) / 1000)));
  asOperator();
  await assert.rejects(
    buildRequest(ctx, tsraToUnits("100"), d.emulator.now()),
    /15 minutes are left in this UTC day/,
  );
  d.emulator.awaitSlot(30 * 60); // past midnight UTC
});

test("cancel: off on preprod-v1; forcing it shows C-1 (the marker burn is refused on chain)", async () => {
  asOperator();
  const me = await d.lucid.wallet().address();
  const meKey = L.getAddressDetails(me).paymentCredential!.hash;
  await run(await buildRequest(ctx, tsraToUnits("100"), d.emulator.now()));
  const [r] = await requests(ctx, meKey);
  await assert.rejects(buildCancel(ctx, r!, d.emulator.now()), /not possible on emulator/);
  // The spend passes; the marker burn runs redeem_queue.mint, which needs a
  // queue script no action provides (Mint[0]).
  await assert.rejects(buildCancel(ctx, r!, d.emulator.now(), { force: true }), (e: Error) => {
    return /Mint\[0\]|mint/i.test(e.message) && !/Spend/.test(e.message.split("\n")[0]!);
  });
  assert.equal((await requests(ctx, meKey)).length, 1, "the Request is still there");
});

// ------------------------------------------------------------------ contention

test("contention: a stake built on a State someone else spent first fails and is classified", async () => {
  asOperator();
  const a = await buildStakeShort(ctx, tsraToUnits("20"), d.emulator.now());
  asOperator();
  const b = await buildStakeShort(ctx, tsraToUnits("20"), d.emulator.now());
  await run(a);
  let err: unknown = null;
  try {
    await run(b);
  } catch (e) {
    err = e;
  }
  assert.ok(err, "the second submit fails");
  const c = classifyTesseraError(err);
  assert.equal(c.kind, "contention", `classified: ${String((err as Error).message).slice(0, 200)}`);
  assert.equal(classifyTesseraError(new TesseraRefused("x")).kind, "refused");
  assert.equal(classifyTesseraError(new Error("User declined to sign")).kind, "declined");
});
