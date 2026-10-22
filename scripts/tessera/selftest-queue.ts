/**
 * Self-test for the redemption-queue bootstrap. No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-queue.ts
 *
 * On Lucid's Emulator with the REAL compiled scripts from contracts/tessera:
 *   reserve genesis → tUSD mint → 3 reference scripts → 3 stake registrations
 *   → queue Genesis (3-of-5), then reads every queue UTxO back, and checks the
 *   validators refuse: Genesis with 2 of 5, a daily limit under the floor,
 *   a missing shard, and spending a parked reference script.
 */
import assert from "node:assert/strict";
import {
  Constr,
  Data,
  Emulator,
  Lucid,
  generateEmulatorAccount,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  slotToUnixTime,
  unixTimeToSlot,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  applyQueueScripts,
  applyRedeemQueue,
  enterpriseAddress,
  rewardAddress,
} from "./lib/blueprint";
import { buildGenesis } from "./lib/build-genesis";
import { pickSeed } from "./lib/build-vault";
import {
  QUEUE_BUILDERS,
  QUEUE_STAGES,
  TUSD_NAME,
  TUSD_SUPPLY,
  type QueueContext,
} from "./lib/build-queue";
import { tsraToUnits } from "./lib/genesis";
import {
  CONFIG_NAME,
  SHORT_NAME,
  adminGenesisRedeemer,
  defaultQueueParams,
  limitFloor,
  queueConfigDatumCbor,
  queueProblems,
  shardGenesisDatumCbor,
  shardName,
  shortGenesisDatumCbor,
} from "./lib/queue-genesis";

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
const keyHash = (addr: string) => getAddressDetails(addr).paymentCredential!.hash;

async function main() {
  const operator = generateEmulatorAccountFromPrivateKey({ lovelace: 1_000_000_000n });
  const committee = [1, 2, 3, 4, 5].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 10_000_000n }),
  );
  const emulator = new Emulator([
    operator,
    ...committee,
    generateEmulatorAccount({ lovelace: 1n }),
  ]);
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(operator.privateKey);
  emulator.awaitSlot(600);

  console.log("pure checks");
  const p0 = defaultQueueParams("ab".repeat(28), TUSD_NAME);
  await check("SPEC defaults + 50k/500k limits pass config_valid", () =>
    assert.deepEqual(queueProblems(p0, 0n), []),
  );
  await check("limit floor is 10,000 at low supply and 1% above 1M", () => {
    assert.equal(limitFloor(0n), 10_000_000_000n);
    assert.equal(limitFloor(10_000_000_000_000n), 100_000_000_000n);
  });
  await check("daily limit under the floor is refused", () =>
    assert.ok(queueProblems({ ...p0, dailyLimit: 9_999_999_999n }, 0n).length),
  );
  await check("ADA as payout (empty policy) is refused", () =>
    assert.ok(queueProblems({ ...p0, payoutPolicy: "" }, 0n).length),
  );
  await check("9 shards are refused", () =>
    assert.ok(queueProblems({ ...p0, shards: 9 }, 0n).length),
  );

  console.log("reserve genesis (setup)");
  const ops5 = committee.map((c) => keyHash(c.address));
  const rplan = await buildGenesis(
    lucid,
    await pickSeed(lucid),
    {
      operators: ops5,
      threshold: 3,
      mintCap: tsraToUnits("5000000"),
      attestedReserve: 0n,
      paused: false,
      kycMint: false,
      kycRedeem: false,
      kycStake: false,
    },
    emulator.now(),
  );
  const rh = await (await rplan.tx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  await check("reserve genesis confirmed", async () => assert.ok(await lucid.awaitTx(rh)));
  const reserveUtxo = async (unit: string): Promise<UTxO> =>
    (await lucid.utxosAt(rplan.reserveAddress)).find((u) => (u.assets[unit] ?? 0n) === 1n)!;

  console.log("queue bootstrap: 6 chained transactions (real validators)");
  const ctx: QueueContext = {
    reserve: rplan.reserve,
    operatorKeyHash: keyHash(operator.address),
    reserveConfig: await reserveUtxo(rplan.units.config),
    reserveSupply: await reserveUtxo(rplan.units.supply),
    signers: ops5.slice(0, 3),
    refs: {},
  };
  const built = [];
  for (const s of QUEUE_STAGES) {
    const b = await QUEUE_BUILDERS[s](lucid, ctx, emulator.now());
    built.push(b);
    await check(`${s}: built and evaluated (${String(b.tx.toCBOR().length / 2)} bytes)`, () =>
      assert.ok(b.tx.toCBOR().length / 2 <= 16_384),
    );
  }
  lucid.overrideUTxOs([]);
  lucid.selectWallet.fromPrivateKey(operator.privateKey);
  for (const b of built) {
    let s = b.tx.sign.withWallet();
    if (b.name === "queue")
      for (const c of committee.slice(0, 3)) s = s.sign.withPrivateKey(c.privateKey);
    const h = await (await s.complete()).submit();
    emulator.awaitBlock(1);
    await check(`${b.name}: confirmed`, async () => assert.ok(await lucid.awaitTx(h)));
  }
  const r = Object.fromEntries(built.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, unknown>
  >;

  await check("operator holds 1,000,000 tUSD", async () => {
    const bal = (await lucid.wallet().getUtxos()).reduce(
      (a, u) => a + (u.assets[r.tusd!.unit as string] ?? 0n),
      0n,
    );
    assert.equal(bal, TUSD_SUPPLY);
  });
  await check("three reference scripts parked at the lock address", async () => {
    const at = await lucid.utxosAt(r.refFlow!.lockAddress as string);
    assert.equal(at.filter((u) => u.scriptRef).length, 3);
  });
  await check("queue_flow, queue_admin, queue_short stake credentials registered", () => {
    const chain = emulator.chain as Record<string, { registeredStake?: boolean }>;
    for (const k of ["flow", "admin", "short"])
      assert.equal(
        chain[(r.queueStake![k] as { rewardAddress: string }).rewardAddress]?.registeredStake,
        true,
      );
  });
  const qAddr = r.queue!.address as string;
  await check("queue address holds Config + Short + 4 shards, nothing else", async () => {
    const at = await lucid.utxosAt(qAddr);
    assert.equal(at.length, 6);
    for (const u of at) assert.equal(Object.keys(u.assets).length, 2);
  });
  await check("queue datums are exactly the genesis datums", async () => {
    const at = await lucid.utxosAt(qAddr);
    const by = (unit: string) => at.find((u) => (u.assets[unit] ?? 0n) === 1n)!;
    assert.equal(
      by(r.queue!.configUnit as string).datum,
      queueConfigDatumCbor(defaultQueueParams(r.tusd!.policyId as string, TUSD_NAME)),
    );
    assert.equal(by(r.queue!.shortUnit as string).datum, shortGenesisDatumCbor());
    for (const s of r.queue!.shardUnits as string[])
      assert.equal(by(s).datum, shardGenesisDatumCbor());
  });

  console.log("on-chain refusals (validator must reject)");
  const q = applyQueueScripts(rplan.reserve.hash);
  async function genesisWith(opts: {
    signers: string[];
    daily?: bigint;
    shards?: number;
    outShards?: number;
  }) {
    const seed = await pickSeed(lucid);
    const queue = applyRedeemQueue(
      { txHash: seed.txHash, outputIndex: seed.outputIndex },
      rplan.reserve.hash,
      {
        flow: q.flow.hash,
        admin: q.admin.hash,
        short: q.short.hash,
      },
    );
    const params = {
      ...defaultQueueParams(r.tusd!.policyId as string, TUSD_NAME),
      ...(opts.daily ? { dailyLimit: opts.daily } : {}),
      ...(opts.shards ? { shards: opts.shards } : {}),
    };
    const nOut = opts.outShards ?? params.shards;
    const addr = enterpriseAddress("Custom", queue);
    const u = (n: string) => queue.hash + n;
    const lo = slotToUnixTime("Custom", unixTimeToSlot("Custom", emulator.now() - 120_000));
    const mint: Record<string, bigint> = { [u(CONFIG_NAME)]: 1n, [u(SHORT_NAME)]: 1n };
    for (let i = 0; i < nOut; i++) mint[u(shardName(i))] = 1n;
    let b = lucid
      .newTx()
      .collectFrom([seed])
      .readFrom([
        ctx.refs.admin!,
        await reserveUtxo(rplan.units.config),
        await reserveUtxo(rplan.units.supply),
      ])
      .mintAssets(mint, Data.void())
      .attach.MintingPolicy(queue.script)
      .withdraw(rewardAddress("Custom", q.admin), 0n, adminGenesisRedeemer(queue.hash))
      .pay.ToContract(
        addr,
        { kind: "inline", value: queueConfigDatumCbor(params) },
        { lovelace: 3_000_000n, [u(CONFIG_NAME)]: 1n },
      )
      .pay.ToContract(
        addr,
        { kind: "inline", value: shortGenesisDatumCbor() },
        { lovelace: 3_000_000n, [u(SHORT_NAME)]: 1n },
      );
    for (let i = 0; i < nOut; i++)
      b = b.pay.ToContract(
        addr,
        { kind: "inline", value: shardGenesisDatumCbor() },
        { lovelace: 3_000_000n, [u(shardName(i))]: 1n },
      );
    for (const s of opts.signers) b = b.addSignerKey(s);
    return b
      .validFrom(lo)
      .validTo(lo + 3_600_000)
      .complete();
  }
  await check("control: a second, untampered queue Genesis is accepted", () =>
    genesisWith({ signers: ops5.slice(1, 4) }),
  );
  await check("Genesis signed by only 2 of 5 is rejected", () =>
    assert.rejects(genesisWith({ signers: ops5.slice(0, 2) })),
  );
  await check("Genesis with a daily limit under the floor is rejected", () =>
    assert.rejects(genesisWith({ signers: ops5.slice(0, 3), daily: 9_000_000_000n })),
  );
  await check("Genesis with 3 shard outputs for shards = 4 is rejected", () =>
    assert.rejects(genesisWith({ signers: ops5.slice(0, 3), outShards: 3 })),
  );
  await check("a parked reference script cannot be spent", async () => {
    const ref = (await lucid.utxosAt(r.refFlow!.lockAddress as string))[0]!;
    await assert.rejects(lucid.newTx().collectFrom([ref]).complete());
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
