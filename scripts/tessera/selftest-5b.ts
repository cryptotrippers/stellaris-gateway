/**
 * Self-test for Stage 5b. No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-5b.ts
 *
 * Emulator, real compiled scripts: full deployment + Stage 5a, then
 * refs → ReportYield 100 → RequestUnstake 400 sTSRA → queue Request 500 →
 * Instant 250, reading every State back; then refusals: ReportYield with 2 of 5,
 * a Ticket claimable a day early, an Instant that pays the holder 1 short,
 * a Request whose payable_after is a day early.
 */
import assert from "node:assert/strict";
import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";
import { applyFirstLoss, rewardAddress } from "./lib/blueprint";
import { TSRA, STSRA } from "./lib/build-actions";
import {
  buildInstant,
  buildRef,
  buildReportYield,
  buildRequest,
  buildRequestUnstake,
  splitYield,
  type QueueCtx,
  type VaultCtx,
} from "./lib/build-5b";
import { tsraToUnits } from "./lib/genesis";
import { setupDeployment } from "./lib/emulator-setup";

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
  console.log("pure checks");
  await check("split_yield: 100 TSRA, 12.5% cut, short only", () => {
    const r = splitYield(100_000_000n, 1_250n, 1_000_000_000n, 0n, 12_500n);
    assert.deepEqual(r, { half: 6_250_000n, rest: 6_250_000n, yShort: 87_500_000n, yLong: 0n });
  });

  console.log("setup: full deployment + stage 5a on the emulator");
  const d = await setupDeployment();
  const {
    lucid,
    emulator,
    operator,
    opKey,
    signers,
    ops5,
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
  await check("setup complete", () => true);

  console.log("stage 5b (real validators)");
  const fl = applyFirstLoss(v.firstLoss!.seed, rplan.reserve.hash);
  const refSteps = [
    await buildRef(lucid, "refVault", vault),
    await buildRef(lucid, "refOps", ops),
    await buildRef(lucid, "refFirstLoss", fl),
    await buildRef(lucid, "refReserve", rplan.reserve),
  ];
  const refOf = (i: number) => refSteps[i]!.derived.find((u) => u.scriptRef)!;
  const vc: VaultCtx = {
    vault,
    ops,
    opsReward: rewardAddress("Custom", ops),
    reserveHash: rplan.reserve.hash,
    refs: { vault: refOf(0), ops: refOf(1), firstLoss: refOf(2) },
    reserveConfig: await d.cfg(),
    reserveSupply: await d.supply(),
    signers,
  };
  const state0 = await at(v.vault!.address, v.vault!.stateUnit);
  const fl0 = await at(v.firstLoss!.address, v.firstLoss!.stateUnit);
  const ry = await buildReportYield(lucid, vc, state0, fl0, tsraToUnits("100"), emulator.now());
  const state1 = ry.derived.find((u) => (u.assets[v.vault!.stateUnit] ?? 0n) === 1n)!;
  const un = await buildRequestUnstake(
    lucid,
    vc,
    state1,
    tsraToUnits("400"),
    operator.address,
    emulator.now(),
  );
  const qc: QueueCtx = {
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
  const shard0 = await at(q.queue!.address, q.queue!.shardUnits[0]);
  const ins = await buildInstant(
    lucid,
    qc,
    shard0,
    tsraToUnits("250"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const all = [...refSteps, ry, un, rq, ins];
  for (const s of all)
    await check(`${s.name}: built and evaluated (${String(s.tx.toCBOR().length / 2)} bytes)`, () =>
      assert.ok(s.tx.toCBOR().length / 2 <= 16_384),
    );
  await d.submit(all, ["reportYield"]);
  await check("all confirmed", () => true);

  const tsraUnit = rplan.reserve.hash + TSRA;
  const bal = async (unit: string) =>
    (await lucid.wallet().getUtxos()).reduce((a, u) => a + (u.assets[unit] ?? 0n), 0n);
  const fields = (u: UTxO) => [
    ...(Data.from(u.datum!) as Constr<Constr<bigint>>).fields[0]!.fields,
  ];
  await check("first-loss holds 6.25 TSRA (half the 12.5% cut)", async () => {
    const f = await at(v.firstLoss!.address, v.firstLoss!.stateUnit);
    assert.equal(f.assets[tsraUnit], 6_250_000n);
  });
  await check(
    "vault: 600 sTSRA left, 87.5 TSRA vesting, escrow 400, State holds 687.5 TSRA",
    async () => {
      const s = await at(v.vault!.address, v.vault!.stateUnit);
      const f = fields(s);
      assert.equal(f[0], tsraToUnits("600"));
      assert.equal(f[1], tsraToUnits("600"));
      assert.equal(f[8], 87_500_000n);
      assert.equal(f[5], tsraToUnits("400"));
      assert.equal(s.assets[tsraUnit], 687_500_000n);
    },
  );
  await check("Ticket: 400 TSRA escrowed, claim_after = hi + 7 days", async () => {
    const t = (await lucid.utxosAt(v.vault!.address)).find(
      (u) => (u.assets[vault.hash + "706f736974696f6e"] ?? 0n) === 1n,
    )!;
    assert.equal(t.assets[tsraUnit], tsraToUnits("400"));
    const tf = (Data.from(t.datum!) as Constr<Constr<unknown>>).fields[0]!.fields;
    assert.ok((tf[3] as bigint) > BigInt(emulator.now()) + 6n * 86_400_000n);
  });
  await check("operator: 1,000 → 600 sTSRA", async () =>
    assert.equal(await bal(vault.hash + STSRA), tsraToUnits("600")),
  );
  await check("queue: one Request (500 TSRA) and one Sink (250 TSRA)", async () => {
    const atQ = await lucid.utxosAt(q.queue!.address);
    const req = atQ.filter((u) => (u.assets[queue.hash + "72657175657374"] ?? 0n) === 1n);
    assert.equal(req.length, 1);
    assert.equal(req[0]!.assets[tsraUnit], tsraToUnits("500"));
    const sinks = atQ.filter(
      (u) => Object.keys(u.assets).length === 2 && u.assets[tsraUnit] === tsraToUnits("250"),
    );
    assert.equal(sinks.length, 1);
  });
  await check("shard 0: 19,750 tUSD; operator tUSD +250", async () => {
    const sh = await at(q.queue!.address, q.queue!.shardUnits[0]);
    assert.equal(sh.assets[q.tusd!.unit], 19_750_000_000n);
    assert.equal(await bal(q.tusd!.unit), 980_250_000_000n);
  });
  await check("operator TSRA: 9,000 − 100 yield + 6.25 treasury − 500 − 250 = 8,156.25", async () =>
    assert.equal(await bal(tsraUnit), 8_156_250_000n),
  );

  console.log("on-chain refusals (validator must reject)");
  d.reset();
  const vc2: VaultCtx = {
    ...vc,
    reserveConfig: await d.cfg(),
    reserveSupply: await d.supply(),
    refs: {
      vault: (await lucid.utxosAt(refOf(0).address)).find(
        (u) => u.scriptRef && u.txHash === refOf(0).txHash,
      )!,
      ops: refOf(1),
      firstLoss: refOf(2),
    },
  };
  const st = await at(v.vault!.address, v.vault!.stateUnit);
  const fls = await at(v.firstLoss!.address, v.firstLoss!.stateUnit);
  await check("control: another ReportYield with 3 of 5 is accepted", () =>
    buildReportYield(lucid, vc2, st, fls, tsraToUnits("10"), emulator.now()),
  );
  d.reset();
  await check("ReportYield signed by only 2 of 5 is rejected", () =>
    assert.rejects(
      buildReportYield(
        lucid,
        { ...vc2, signers: ops5.slice(0, 2) },
        st,
        fls,
        tsraToUnits("10"),
        emulator.now(),
      ),
    ),
  );
  d.reset();
  await check("a Ticket claimable a day early is rejected", async () => {
    const orig = Data.to;
    (Data as any).to = (x: any, ...r: any[]) => {
      if (x instanceof Constr && x.index === 2 && (x.fields[0] as any)?.fields?.length === 4)
        (x.fields[0] as any).fields[3] -= 86_400_000n;
      return orig(x, ...(r as []));
    };
    try {
      await assert.rejects(
        buildRequestUnstake(lucid, vc2, st, tsraToUnits("100"), operator.address, emulator.now()),
      );
    } finally {
      (Data as any).to = orig;
    }
  });
  d.reset();
  await check("control: an untampered RequestUnstake of 100 is accepted", () =>
    buildRequestUnstake(lucid, vc2, st, tsraToUnits("100"), operator.address, emulator.now()),
  );
  d.reset();
  const qc2 = { ...qc, reserveConfig: await d.cfg() };
  await check("Request with payable_after a day early is rejected", async () => {
    const orig = Data.to;
    (Data as any).to = (x: any, ...r: any[]) => {
      if (x instanceof Constr && x.index === 1 && (x.fields[0] as any)?.fields?.length === 6)
        (x.fields[0] as any).fields[4] -= 86_400_000n;
      return orig(x, ...(r as []));
    };
    try {
      await assert.rejects(
        buildRequest(lucid, qc2, tsraToUnits("500"), opKey, operator.address, emulator.now()),
      );
    } finally {
      (Data as any).to = orig;
    }
  });
  d.reset();
  const sh1 = await at(q.queue!.address, q.queue!.shardUnits[0]);
  await check("control: another Instant of 100 is accepted", () =>
    buildInstant(lucid, qc2, sh1, tsraToUnits("100"), opKey, operator.address, emulator.now()),
  );
  d.reset();
  await check(
    "Instant whose Sink gets 1 unit less TSRA than the shard pays is rejected",
    async () => {
      const lucidAny = lucid as any;
      const origNewTx = lucidAny.newTx.bind(lucid);
      // Wrap the builder: shave 1 unit off the Sink's TSRA (the output holding only ADA + TSRA).
      lucidAny.newTx = () => {
        const b = origNewTx();
        const origTo = b.pay.ToContract;
        b.pay.ToContract = (
          addr: string,
          datum: any,
          assets: Record<string, bigint>,
          ...rest: any[]
        ) => {
          if (Object.keys(assets).length === 2 && assets[tsraUnit] === tsraToUnits("100"))
            assets = { ...assets, [tsraUnit]: tsraToUnits("100") - 1n };
          return origTo(addr, datum, assets, ...rest);
        };
        return b;
      };
      try {
        await assert.rejects(
          buildInstant(
            lucid,
            qc2,
            sh1,
            tsraToUnits("100"),
            opKey,
            operator.address,
            emulator.now(),
          ),
        );
      } finally {
        lucidAny.newTx = origNewTx;
      }
    },
  );

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
