/**
 * Self-test for Stage 5c. No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-5c.ts
 *
 * Emulator, real compiled scripts: full deployment + Stage 5a + Stage 5b, then
 * time travel to the Request's payable_after → Settle → Sweep, and to the
 * Ticket's claim_after → Claim, reading every State back. Refusals: a Settle
 * before payable_after, a Settle paying 1 unit short, a Sweep burning 1 unit
 * less than the Sinks hold, a Claim before claim_after, a Claim paying someone
 * other than the owner.
 */
import assert from "node:assert/strict";
import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";
import { applyFirstLoss, rewardAddress } from "./lib/blueprint";
import { TSRA } from "./lib/build-actions";
import {
  buildInstant,
  buildRef,
  buildReportYield,
  buildRequest,
  buildRequestUnstake,
} from "./lib/build-5b";
import {
  buildClaim,
  buildSettle,
  buildSweep,
  payable,
  sinksAt,
  ticketFields,
  type ClaimCtx,
  type SettleCtx,
  type SweepCtx,
} from "./lib/build-5c";
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
  console.log("setup: deployment + 5a + 5b on the emulator");
  const d = await setupDeployment();
  const { lucid, emulator, operator, committee, opKey, signers, at, rplan, v, q, qctx } = d;
  const { ops, vault, queue, qs } = d;
  const fl = applyFirstLoss(v.firstLoss!.seed, rplan.reserve.hash);
  const refSteps = [
    await buildRef(lucid, "refVault", vault),
    await buildRef(lucid, "refOps", ops),
    await buildRef(lucid, "refFirstLoss", fl),
    await buildRef(lucid, "refReserve", rplan.reserve),
  ];
  const refOf = (i: number) => refSteps[i]!.derived.find((u) => u.scriptRef)!;
  const vc = {
    vault,
    ops,
    opsReward: rewardAddress("Custom", ops),
    reserveHash: rplan.reserve.hash,
    refs: { vault: refOf(0), ops: refOf(1), firstLoss: refOf(2) },
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
  const qc5b = {
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
    qc5b,
    tsraToUnits("500"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const ins = await buildInstant(
    lucid,
    qc5b,
    await at(q.queue!.address, q.queue!.shardUnits[0]),
    tsraToUnits("250"),
    opKey,
    operator.address,
    emulator.now(),
  );
  await d.submit([...refSteps, ry, un, rq, ins], ["reportYield"]);
  await check("setup complete (Request 500, Sink 250, Ticket 400)", () => true);

  // ----------------------------------------------------------- helpers
  const tsraUnit = rplan.reserve.hash + TSRA;
  const tusd = q.tusd!.unit as string;
  const reqUnit = queue.hash + "72657175657374";
  const markerUnit = vault.hash + "706f736974696f6e";
  const bal = async (unit: string) =>
    (await lucid.wallet().getUtxos()).reduce((a, u) => a + (u.assets[unit] ?? 0n), 0n);
  const atQ = () => lucid.utxosAt(q.queue!.address);
  const requests = async () => (await atQ()).filter((u) => (u.assets[reqUnit] ?? 0n) === 1n);
  const sc = async (): Promise<SettleCtx> => ({
    ...qc5b,
    queueConfig: await at(q.queue!.address, q.queue!.configUnit),
    queueShort: await at(q.queue!.address, q.queue!.shortUnit),
    reserveConfig: await d.cfg(),
  });
  const swc = async (): Promise<SweepCtx> => ({
    queue,
    flowReward: rewardAddress("Custom", qs.flow),
    reserveHash: rplan.reserve.hash,
    reserveAddress: rplan.reserveAddress,
    refs: { flow: qctx.refs.flow!, reserve: refOf(3) },
    reserveConfig: await d.cfg(),
  });
  const cc = async (): Promise<ClaimCtx> => ({
    vault,
    opsReward: rewardAddress("Custom", ops),
    reserveHash: rplan.reserve.hash,
    refs: { vault: refOf(0), ops: refOf(1) },
    reserveConfig: await d.cfg(),
  });
  const shard0 = () => at(q.queue!.address, q.queue!.shardUnits[0]);
  const state = () => at(v.vault!.address, v.vault!.stateUnit);
  const ticket = async () =>
    (await lucid.utxosAt(v.vault!.address)).find((u) => (u.assets[markerUnit] ?? 0n) === 1n)!;
  const fields = (u: UTxO) => [
    ...(Data.from(u.datum!) as Constr<Constr<bigint>>).fields[0]!.fields,
  ];
  /** Run `fn` with every pay.ToAddress of `unit` shaved by one unit. */
  async function shaving<T>(unit: string, fn: () => Promise<T>): Promise<T> {
    const l = lucid as any;
    const orig = l.newTx.bind(lucid);
    l.newTx = () => {
      const b = orig();
      const to = b.pay.ToAddress;
      b.pay.ToAddress = (addr: string, assets: Record<string, bigint>, ...rest: any[]) =>
        to(addr, assets[unit] ? { ...assets, [unit]: assets[unit] - 1n } : assets, ...rest);
      return b;
    };
    try {
      return await fn();
    } finally {
      l.newTx = orig;
    }
  }
  const advanceTo = (ms: bigint) => {
    const slots = Math.ceil((Number(ms) - emulator.now()) / 1000) + 300;
    if (slots > 0) emulator.awaitSlot(slots);
  };

  // ---------------------------------------------------------------- settle
  console.log("settle");
  const [r0] = await requests();
  const payableAfter = (fields(r0!) as bigint[])[4]!;
  await check("guard: Settle before payable_after is refused off-chain", async () =>
    assert.rejects(buildSettle(lucid, qc5b, await shard0(), [r0!], emulator.now()), /not yet/),
  );
  d.reset();
  await check("Settle before payable_after is rejected by the validator", async () =>
    assert.rejects(
      buildSettle(lucid, await sc(), await shard0(), [r0!], emulator.now(), { skipGuards: true }),
    ),
  );
  d.reset();
  await check("payable() lists nothing yet", async () =>
    assert.equal(payable(await requests(), emulator.now()).length, 0),
  );

  advanceTo(payableAfter);
  await check("payable() lists the Request after payable_after", async () =>
    assert.equal(payable(await requests(), emulator.now()).length, 1),
  );
  // A third-party keeper (committee[4], who holds no tUSD), so the owner's
  // payment cannot be met by change returning to the owner.
  const keeper = committee[4]!;
  const asKeeper = async <T>(fn: () => Promise<T>) => {
    d.reset();
    lucid.selectWallet.fromPrivateKey(keeper.privateKey);
    try {
      return await fn();
    } finally {
      d.reset();
    }
  };
  await check("control: a third-party keeper's Settle is accepted (no owner signature)", () =>
    asKeeper(async () =>
      buildSettle(lucid, await sc(), await shard0(), await requests(), emulator.now()),
    ),
  );
  await check("Settle paying the owner 1 unit of tUSD short is rejected", () =>
    asKeeper(() =>
      assert.rejects(
        shaving(tusd, async () =>
          buildSettle(lucid, await sc(), await shard0(), await requests(), emulator.now()),
        ),
      ),
    ),
  );
  d.reset();
  const tusd0 = await bal(tusd);
  const st = await buildSettle(lucid, await sc(), await shard0(), await requests(), emulator.now());
  await check(`settle: built and evaluated (${String(st.tx.toCBOR().length / 2)} bytes)`, () =>
    assert.ok(st.tx.toCBOR().length / 2 <= 16_384),
  );
  await d.submit([st], []);
  await check("operator tUSD +500; no Request left", async () => {
    assert.equal((await bal(tusd)) - tusd0, tsraToUnits("500"));
    assert.equal((await requests()).length, 0);
  });
  await check("shard 0: 19,250 tUSD, counters reset to a new day with 500 paid", async () => {
    const s = await shard0();
    assert.equal(s.assets[tusd], 19_250_000_000n);
    const f = fields(s) as bigint[];
    assert.equal(f[0], BigInt(emulator.now()) / 86_400_000n);
    assert.equal(f[1], tsraToUnits("500"));
  });
  await check("two Sinks hold 750 TSRA", async () => {
    const s = sinksAt(await atQ());
    assert.equal(s.length, 2);
    assert.equal(
      s.reduce((a, u) => a + (u.assets[tsraUnit] ?? 0n), 0n),
      tsraToUnits("750"),
    );
  });

  // ----------------------------------------------------------------- sweep
  console.log("sweep");
  const minted0 = (fields(await d.supply()) as bigint[])[0]!;
  d.reset();
  await check("Sweep burning 1 unit less than the Sinks hold is rejected", async () =>
    assert.rejects(
      buildSweep(
        lucid,
        await swc(),
        sinksAt(await atQ()),
        await d.supply(),
        opKey,
        emulator.now(),
        {
          burnDelta: -1n,
        },
      ),
    ),
  );
  d.reset();
  const tsraBefore = await bal(tsraUnit);
  const sw = await buildSweep(
    lucid,
    await swc(),
    sinksAt(await atQ()),
    await d.supply(),
    opKey,
    emulator.now(),
  );
  await check(`sweep: built and evaluated (${String(sw.tx.toCBOR().length / 2)} bytes)`, () =>
    assert.ok(sw.tx.toCBOR().length / 2 <= 16_384),
  );
  await d.submit([sw], []);
  await check("no Sinks left; minted supply 10,000 → 9,250", async () => {
    assert.equal(sinksAt(await atQ()).length, 0);
    assert.equal(minted0, tsraToUnits("10000"));
    assert.equal((fields(await d.supply()) as bigint[])[0], tsraToUnits("9250"));
  });
  await check("operator TSRA unchanged by the sweep", async () =>
    assert.equal(await bal(tsraUnit), tsraBefore),
  );

  // ----------------------------------------------------------------- claim
  console.log("claim");
  const tk = await ticket();
  const t = ticketFields(tk);
  await check("Ticket owner decodes to the operator", () =>
    assert.equal(t.owner, operator.address),
  );
  d.reset();
  await check("Claim before claim_after is rejected by the validator", async () =>
    assert.rejects(
      buildClaim(lucid, await cc(), await state(), tk, emulator.now(), { skipGuards: true }),
    ),
  );
  advanceTo(t.claimAfter);
  await check("control: a third-party Claim is accepted (permissionless)", () =>
    asKeeper(async () =>
      buildClaim(lucid, await cc(), await state(), await ticket(), emulator.now()),
    ),
  );
  await check("Claim paying someone other than the owner is rejected", () =>
    asKeeper(async () =>
      assert.rejects(
        buildClaim(lucid, await cc(), await state(), await ticket(), emulator.now(), {
          payTo: committee[0]!.address,
        }),
      ),
    ),
  );
  d.reset();
  const tsra1 = await bal(tsraUnit);
  const cl = await buildClaim(lucid, await cc(), await state(), await ticket(), emulator.now());
  await check(`claim: built and evaluated (${String(cl.tx.toCBOR().length / 2)} bytes)`, () =>
    assert.ok(cl.tx.toCBOR().length / 2 <= 16_384),
  );
  await d.submit([cl], []);
  await check("operator TSRA +400; no Ticket left; escrow 0", async () => {
    assert.equal((await bal(tsraUnit)) - tsra1, tsraToUnits("400"));
    assert.equal(
      (await lucid.utxosAt(v.vault!.address)).filter((u) => (u.assets[markerUnit] ?? 0n) === 1n)
        .length,
      0,
    );
    assert.equal((fields(await state()) as bigint[])[5], 0n);
  });
  await check(
    "vault State still holds 600 sTSRA of short assets plus the vested yield",
    async () => {
      const s = await state();
      assert.equal((fields(s) as bigint[])[0], tsraToUnits("600"));
      assert.equal(s.assets[tsraUnit], 687_500_000n);
    },
  );

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
