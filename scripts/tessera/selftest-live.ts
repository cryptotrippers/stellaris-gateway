/**
 * Self-test for the app's live-data decoder (src/lib/tessera-live.server.ts).
 *
 *   npx tsx scripts/tessera/selftest-live.ts
 *
 * Builds the full deployment + Stage 5a + 5b on the Emulator with the real
 * scripts, then feeds the emulator's UTxOs through `summarize` (the exact
 * function the app's getTesseraLive uses) and checks every decoded figure.
 */
import assert from "node:assert/strict";
import { CML, Data, type UTxO } from "@lucid-evolution/lucid";
import { applyFirstLoss, rewardAddress } from "./lib/blueprint";
import {
  buildInstant,
  buildRef,
  buildReportYield,
  buildRequest,
  buildRequestUnstake,
} from "./lib/build-5b";
import { tsraToUnits } from "./lib/genesis";
import { setupDeployment } from "./lib/emulator-setup";
import { plutusAddressToBech32, summarize, type RawUtxo } from "../../src/lib/tessera-live.server";

let passed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function main() {
  console.log("setup: deployment + 5a + 5b on the emulator");
  const d = await setupDeployment();
  const {
    lucid,
    emulator,
    operator,
    opKey,
    signers,
    at,
    rplan,
    v,
    q,
    qctx,
    ops,
    vault,
    queue,
    qs,
  } = d;
  const fl = applyFirstLoss(v.firstLoss!.seed, rplan.reserve.hash);
  const refs = [
    await buildRef(lucid, "refVault", vault),
    await buildRef(lucid, "refOps", ops),
    await buildRef(lucid, "refFirstLoss", fl),
  ];
  const ref = (i: number) => refs[i]!.derived.find((u) => u.scriptRef)!;
  const vc = {
    vault,
    ops,
    opsReward: rewardAddress("Custom", ops),
    reserveHash: rplan.reserve.hash,
    refs: { vault: ref(0), ops: ref(1), firstLoss: ref(2) },
    reserveConfig: await d.cfg(),
    reserveSupply: await d.supply(),
    signers,
  };
  const ry = await buildReportYield(
    lucid,
    vc,
    await at(v.vault!.address, v.vault!.stateUnit),
    await at(v.firstLoss!.address, v.firstLoss!.stateUnit),
    tsraToUnits("100"),
    emulator.now(),
  );
  const un = await buildRequestUnstake(
    lucid,
    vc,
    ry.derived.find((u) => (u.assets[v.vault!.stateUnit] ?? 0n) === 1n)!,
    tsraToUnits("400"),
    operator.address,
    emulator.now(),
  );
  const qc = {
    queue,
    flowReward: rewardAddress("Custom", qs.flow),
    reserveHash: rplan.reserve.hash,
    refs: { flow: qctx.refs.flow! },
    queueConfig: await at(q.queue!.address, q.queue!.configUnit),
    queueShort: await at(q.queue!.address, q.queue!.shortUnit),
    reserveConfig: await d.cfg(),
  };
  const rq = await buildRequest(
    lucid,
    qc,
    tsraToUnits("500"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const ins = await buildInstant(
    lucid,
    qc,
    await at(q.queue!.address, q.queue!.shardUnits[0]),
    tsraToUnits("250"),
    opKey,
    operator.address,
    emulator.now(),
  );
  await d.submit([...refs, ry, un, rq, ins], ["reportYield"]);
  emulator.awaitSlot(3600); // one hour of vesting
  await check("setup complete", () => true);

  const raw = (xs: UTxO[]): RawUtxo[] =>
    xs.map((u) => ({
      ref: `${u.txHash}#${String(u.outputIndex)}`,
      address: u.address,
      assets: u.assets as Record<string, bigint>,
      datum: u.datum ?? null,
    }));
  const dep = {
    reserve: {
      configUnit: rplan.units.config,
      supplyUnit: rplan.units.supply,
      tsraUnit: rplan.units.tsra,
    },
    vault: { stateUnit: v.vault!.stateUnit, markerUnit: vault.hash + "706f736974696f6e" },
    firstLoss: { stateUnit: v.firstLoss!.stateUnit },
    queue: {
      configUnit: q.queue!.configUnit,
      shortUnit: q.queue!.shortUnit,
      requestUnit: queue.hash + "72657175657374",
      shardUnits: q.queue!.shardUnits as string[],
    },
    tusd: { unit: q.tusd!.unit as string },
  };
  const snap = summarize(
    {
      reserve: raw(await lucid.utxosAt(rplan.reserveAddress)),
      vault: raw(await lucid.utxosAt(v.vault!.address)),
      firstLoss: raw(await lucid.utxosAt(v.firstLoss!.address)),
      queue: raw(await lucid.utxosAt(q.queue!.address)),
    },
    (c) => Data.from(c),
    (a) => plutusAddressToBech32(a, CML),
    emulator.now(),
    dep,
  );

  console.log("decoded snapshot");
  await check("reserve: minted 10,000, attested 100,000, cap 5,000,000, 3-of-5, KYC off", () => {
    assert.equal(snap.reserve.mintedSupply, "10000000000");
    assert.equal(snap.reserve.attestedReserve, "100000000000");
    assert.equal(snap.reserve.mintCap, "5000000000000");
    assert.deepEqual(snap.reserve.committee, { threshold: 3, size: 5 });
    assert.deepEqual(snap.reserve.kyc, { mint: false, redeem: false, stake: false });
    assert.equal(snap.reserve.paused, false);
    assert.equal(snap.reserve.attestationEpoch, 1);
  });
  await check("reserve Config points at the vault (SetVault)", () =>
    assert.equal(snap.reserve.vaultPolicy, vault.hash),
  );
  await check("vault: 600 sTSRA, 600 TSRA booked, 87.5 vesting, escrow 400, bounds", () => {
    assert.equal(snap.vault.shortShares, "600000000");
    assert.equal(snap.vault.shortAssets, "600000000");
    assert.equal(snap.vault.vestShort, "87500000");
    assert.equal(snap.vault.ticketEscrow, "400000000");
    assert.deepEqual(snap.vault.bounds, {
      longWeightBps: 12_500,
      shortCooldownMs: 604_800_000,
      longLockMs: 2_592_000_000,
      protocolBps: 1_250,
    });
    assert.equal(snap.vault.vestUntil - snap.vault.vestFrom, 604_800_000);
  });
  await check("vault price after ~1 h of vesting is just above 1.0", () => {
    const p = BigInt(snap.vault.priceE6);
    assert.ok(p > 1_000_000n && p < 1_001_000n, `priceE6 ${String(p)}`);
  });
  await check("treasury decodes to the operator address", () =>
    assert.equal(snap.vault.treasuryAddress, operator.address),
  );
  await check("one Ticket: 400 TSRA, owner = operator, claimable in ~7 days", () => {
    assert.equal(snap.vault.tickets.length, 1);
    assert.equal(snap.vault.tickets[0]!.value, "400000000");
    assert.equal(snap.vault.tickets[0]!.owner, operator.address);
    assert.ok(snap.vault.tickets[0]!.claimAfter > emulator.now() + 6 * 86_400_000);
  });
  await check("first-loss balance 6.25 TSRA", () =>
    assert.equal(snap.firstLoss.balance, "6250000"),
  );
  await check("queue config: 2 d delay, 50k/day, 500k/month, 4 shards, 14 d grace", () => {
    const c = snap.queue.config;
    assert.equal(c.settleDelayMs, 172_800_000);
    assert.equal(c.dailyLimit, "50000000000");
    assert.equal(c.monthlyLimit, "500000000000");
    assert.equal(c.shards, 4);
    assert.equal(c.graceMs, 1_209_600_000);
    assert.equal(snap.queue.shortActive, false);
  });
  await check("shards: #0 holds 19,750 tUSD and paid 250 today; #1–3 empty", () => {
    assert.equal(snap.queue.shards[0]!.tusd, "19750000000");
    assert.equal(snap.queue.shards[0]!.paidDay, "250000000");
    for (const i of [1, 2, 3]) assert.equal(snap.queue.shards[i]!.tusd, "0");
  });
  await check("one Request of 500 TSRA paying the operator; one Sink of 250", () => {
    assert.equal(snap.queue.requests.length, 1);
    assert.equal(snap.queue.requests[0]!.qty, "500000000");
    assert.equal(snap.queue.requests[0]!.payoutTo, operator.address);
    assert.equal(snap.queue.requests[0]!.owner, opKey);
    assert.deepEqual(snap.queue.sinks, { count: 1, tsra: "250000000" });
  });
  await check("snapshot is JSON-serialisable (server → client)", () =>
    JSON.parse(JSON.stringify(snap)),
  );

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
