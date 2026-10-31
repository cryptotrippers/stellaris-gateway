/**
 * Re-attesting the TSRA reserve (scripts/tessera/lib/attest.ts) on Lucid's
 * Emulator with the real compiled Tessera scripts and the whole preprod-v1
 * deployment rebuilt by the operator builders: a stale attestation blocks Mint,
 * a 3-of-5 re-attestation unblocks it, and the refusals hold on chain.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { buildMint } from "../../scripts/tessera/lib/build-actions";
import { ATTEST_FRESH_MS, buildReattest, freshness } from "../../scripts/tessera/lib/attest";
import { setupDeployment } from "../../scripts/tessera/lib/emulator-setup";
import { tsraToUnits } from "../../scripts/tessera/lib/genesis";

type D = Awaited<ReturnType<typeof setupDeployment>>;
let d: D;
before(async () => {
  d = await setupDeployment();
});

const ctx = (signers: string[]) =>
  (async () => ({
    reserve: d.rplan.reserve,
    reserveAddress: d.rplan.reserveAddress,
    configRef: await d.cfg(),
    signers,
  }))();

test("attest: a fresh attestation reads as fresh, with room to mint", async () => {
  const f = freshness(await d.supply(), d.emulator.now());
  assert.equal(f.fresh, true);
  assert.equal(f.attestedReserve, tsraToUnits("100000"));
  assert.equal(f.minted, tsraToUnits("10000"));
  assert.equal(f.mintable, tsraToUnits("90000"));
  assert.equal(f.freshUntil, f.attestedAt + ATTEST_FRESH_MS);
});

test("attest: after 7 days the attestation is stale and Mint is refused", async () => {
  const f0 = freshness(await d.supply(), d.emulator.now());
  d.emulator.awaitSlot(Math.ceil((f0.freshUntil - d.emulator.now()) / 1000) + 60);
  const f = freshness(await d.supply(), d.emulator.now());
  assert.equal(f.fresh, false);
  assert.equal(f.mintable, 0n);
  d.reset();
  await assert.rejects(
    buildMint(
      d.lucid,
      await ctx(d.signers),
      await d.supply(),
      1_000_000n,
      d.opKey,
      d.operator.address,
      d.emulator.now(),
    ),
    /stale/,
  );
});

test("attest: 2 of 5 signers cannot re-attest (refused by the reserve script)", async () => {
  d.reset();
  await assert.rejects(
    buildReattest(d.lucid, await ctx(d.signers.slice(0, 2)), await d.supply(), d.emulator.now()),
    /failed script execution/,
  );
});

test("attest: attesting below the minted supply needs an explicit flag", async () => {
  d.reset();
  await assert.rejects(
    buildReattest(d.lucid, await ctx(d.signers), await d.supply(), d.emulator.now(), {
      reserve: tsraToUnits("5000"),
    }),
    /below the .* already minted/,
  );
});

test("attest: 3 of 5 re-attest the same reserve; only the date and epochs move; Mint works again", async () => {
  d.reset();
  const s0 = await d.supply();
  const f0 = freshness(s0, d.emulator.now());
  const { step, reserve } = await buildReattest(
    d.lucid,
    await ctx(d.signers),
    s0,
    d.emulator.now(),
  );
  assert.equal(reserve, f0.attestedReserve, "defaults to the current reserve");
  await d.submit([step], ["attest"]);

  const f1 = freshness(await d.supply(), d.emulator.now());
  assert.equal(f1.fresh, true);
  assert.equal(f1.attestedReserve, f0.attestedReserve);
  assert.equal(f1.minted, f0.minted);
  assert.equal(f1.mintCap, f0.mintCap);
  assert.equal(f1.attestationEpoch, f0.attestationEpoch + 1n);
  assert.ok(f1.attestedAt > f0.attestedAt);
  assert.equal(f1.mintable, tsraToUnits("90000"));

  const m = await buildMint(
    d.lucid,
    await ctx(d.signers),
    await d.supply(),
    tsraToUnits("500"),
    d.opKey,
    d.operator.address,
    d.emulator.now(),
  );
  await d.submit([m], ["mint"]);
  assert.equal(freshness(await d.supply(), d.emulator.now()).minted, tsraToUnits("10500"));
});

test("attest: a new reserve figure is recorded as given", async () => {
  d.reset();
  const { step } = await buildReattest(
    d.lucid,
    await ctx(d.signers),
    await d.supply(),
    d.emulator.now(),
    {
      reserve: tsraToUnits("150000"),
    },
  );
  await d.submit([step], ["attest"]);
  const f = freshness(await d.supply(), d.emulator.now());
  assert.equal(f.attestedReserve, tsraToUnits("150000"));
  assert.equal(f.mintable, tsraToUnits("139500"));
});
