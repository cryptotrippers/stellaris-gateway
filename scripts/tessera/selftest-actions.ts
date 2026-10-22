/**
 * Self-test for Stage 5a (attest → mint → stake → fund). No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-actions.ts
 *
 * On Lucid's Emulator with the REAL compiled scripts: the full preprod-v1
 * bootstrap (reserve, vault, queue), then the four actions, reading every
 * State back; then refusals: Mint with 2 of 5 signatures, Mint above the
 * attested reserve, a StakeShort that mints itself extra sTSRA, Fund with 2 of 5.
 */
import assert from "node:assert/strict";
import {
  Constr,
  Data,
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  slotToUnixTime,
  unixTimeToSlot,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  applyRedeemQueue,
  applyQueueScripts,
  applyVault,
  applyVaultOps,
  rewardAddress,
} from "./lib/blueprint";
import { buildGenesis } from "./lib/build-genesis";
import { BUILDERS, STAGES, pickSeed, type VaultContext } from "./lib/build-vault";
import { QUEUE_BUILDERS, QUEUE_STAGES, type QueueContext } from "./lib/build-queue";
import {
  STSRA,
  TSRA,
  buildAttest,
  buildFund,
  buildMint,
  buildStakeShort,
  supplyFields,
  type ReserveCtx,
} from "./lib/build-actions";
import { tsraToUnits } from "./lib/genesis";
import { PROPOSED_BOUNDS } from "./lib/vault-genesis";

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
const keyHash = (a: string) => getAddressDetails(a).paymentCredential!.hash;

async function main() {
  const operator = generateEmulatorAccountFromPrivateKey({ lovelace: 2_000_000_000n });
  const committee = [1, 2, 3, 4, 5].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 10_000_000n }),
  );
  const emulator = new Emulator([operator, ...committee]);
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  const reset = () => {
    lucid.overrideUTxOs([]);
    lucid.selectWallet.fromPrivateKey(operator.privateKey);
  };
  reset();
  emulator.awaitSlot(600);
  const ops5 = committee.map((c) => keyHash(c.address));
  const opKey = keyHash(operator.address);

  async function submitAll(
    steps: { name: string; tx: { sign: { withWallet: () => any } } }[],
    committeeSigned: string[],
  ) {
    reset();
    for (const s of steps) {
      let b = s.tx.sign.withWallet();
      if (committeeSigned.includes(s.name))
        for (const c of committee.slice(0, 3)) b = b.sign.withPrivateKey(c.privateKey);
      const h = await (await b.complete()).submit();
      emulator.awaitBlock(1);
      if (!(await lucid.awaitTx(h))) throw new Error(`${s.name} not confirmed`);
    }
  }

  console.log("bootstrap (setup): reserve, vault, queue");
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
  await submitAll([{ name: "reserve", tx: rplan.tx }], []);
  const at = async (addr: string, unit: string): Promise<UTxO> =>
    (await lucid.utxosAt(addr)).find((u) => (u.assets[unit] ?? 0n) === 1n)!;
  const cfgRef = () => at(rplan.reserveAddress, rplan.units.config);
  const supply = () => at(rplan.reserveAddress, rplan.units.supply);

  const vctx: VaultContext = {
    reserve: rplan.reserve,
    reserveAddress: rplan.reserveAddress,
    treasuryAddress: operator.address,
    bounds: PROPOSED_BOUNDS,
    configUtxo: await cfgRef(),
    signers: ops5.slice(0, 3),
  };
  const vsteps = [];
  for (const s of STAGES) vsteps.push(await BUILDERS[s](lucid, vctx));
  await submitAll(vsteps, ["setVault"]);
  const vrec = Object.fromEntries(vsteps.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, any>
  >;

  const qctx: QueueContext = {
    reserve: rplan.reserve,
    operatorKeyHash: opKey,
    reserveConfig: await cfgRef(),
    reserveSupply: await supply(),
    signers: ops5.slice(0, 3),
    refs: {},
  };
  const qsteps = [];
  for (const s of QUEUE_STAGES) qsteps.push(await QUEUE_BUILDERS[s](lucid, qctx, emulator.now()));
  await submitAll(qsteps, ["queue"]);
  const qrec = Object.fromEntries(qsteps.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, any>
  >;
  await check("bootstrap complete (reserve + 4 vault + 6 queue stages)", () =>
    assert.ok(qrec.queue && vrec.setVault),
  );

  const vault = applyVault(
    vrec.vault!.seed,
    rplan.reserve.hash,
    applyVaultOps(rplan.reserve.hash).hash,
  );
  const qs = applyQueueScripts(rplan.reserve.hash);
  const queue = applyRedeemQueue(qrec.queue!.seed, rplan.reserve.hash, {
    flow: qs.flow.hash,
    admin: qs.admin.hash,
    short: qs.short.hash,
  });
  const tsraUnit = rplan.reserve.hash + TSRA;
  const payoutUnit = qrec.tusd!.unit as string;

  console.log("stage 5a: attest → mint → stake → fund (real validators)");
  reset();
  const rc: ReserveCtx = {
    reserve: rplan.reserve,
    reserveAddress: rplan.reserveAddress,
    configRef: await cfgRef(),
    signers: ops5.slice(0, 3),
  };
  const attest = await buildAttest(
    lucid,
    rc,
    await supply(),
    tsraToUnits("100000"),
    emulator.now(),
  );
  const supply1 = attest.derived.find((u) => (u.assets[rplan.units.supply] ?? 0n) === 1n)!;
  const mint = await buildMint(
    lucid,
    rc,
    supply1,
    tsraToUnits("10000"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const state0 = await at(vrec.vault!.address, vrec.vault!.stateUnit);
  const stake = await buildStakeShort(
    lucid,
    { vault, reserveHash: rplan.reserve.hash, configRef: rc.configRef },
    state0,
    tsraToUnits("1000"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const shard0 = await at(qrec.queue!.address, qrec.queue!.shardUnits[0]);
  const fund = await buildFund(
    lucid,
    {
      queue,
      adminReward: rewardAddress("Custom", qs.admin),
      adminRef: qctx.refs.admin!,
      queueConfig: await at(qrec.queue!.address, qrec.queue!.configUnit),
      reserveConfig: rc.configRef,
      payoutUnit,
      signers: ops5.slice(0, 3),
    },
    shard0,
    20_000_000_000n,
    emulator.now(),
  );
  for (const s of [attest, mint, stake, fund])
    await check(`${s.name}: built and evaluated (${String(s.tx.toCBOR().length / 2)} bytes)`, () =>
      assert.ok(s.tx.toCBOR().length / 2 <= 16_384),
    );
  await submitAll([attest, mint, stake, fund], ["attest", "mint", "fund"]);
  await check("all four confirmed", () => true);

  const bal = async (unit: string) =>
    (await lucid.wallet().getUtxos()).reduce((a, u) => a + (u.assets[unit] ?? 0n), 0n);
  await check("Supply: attested 100,000, minted 10,000, epoch 2", async () => {
    const s = supplyFields((await supply()).datum!);
    assert.equal(s[1], tsraToUnits("100000"));
    assert.equal(s[0], tsraToUnits("10000"));
    assert.equal(s[3], 1n);
    assert.equal(s[5], 2n);
  });
  await check("operator holds 9,000 TSRA and 1,000 sTSRA", async () => {
    assert.equal(await bal(tsraUnit), tsraToUnits("9000"));
    assert.equal(await bal(vault.hash + STSRA), tsraToUnits("1000"));
  });
  await check("vault State holds 1,000 TSRA; short_shares = short_assets = 1,000", async () => {
    const st = await at(vrec.vault!.address, vrec.vault!.stateUnit);
    assert.equal(st.assets[tsraUnit], tsraToUnits("1000"));
    const f = (Data.from(st.datum!) as Constr<Constr<bigint>>).fields[0]!.fields;
    assert.equal(f[0], tsraToUnits("1000"));
    assert.equal(f[1], tsraToUnits("1000"));
  });
  await check("shard 0 holds 20,000 tUSD; operator 980,000", async () => {
    const sh = await at(qrec.queue!.address, qrec.queue!.shardUnits[0]);
    assert.equal(sh.assets[payoutUnit], 20_000_000_000n);
    assert.equal(await bal(payoutUnit), 980_000_000_000n);
  });

  console.log("on-chain refusals (validator must reject)");
  reset();
  const rc2 = { ...rc, configRef: await cfgRef() };
  await check("control: another Mint of 1 TSRA with 3 of 5 is accepted", async () =>
    buildMint(lucid, rc2, await supply(), 1_000_000n, opKey, operator.address, emulator.now()),
  );
  reset();
  await check("Mint signed by only 2 of 5 is rejected", async () =>
    assert.rejects(
      buildMint(
        lucid,
        { ...rc2, signers: ops5.slice(0, 2) },
        await supply(),
        1_000_000n,
        opKey,
        operator.address,
        emulator.now(),
      ),
    ),
  );
  reset();
  await check("Mint above the attested reserve is rejected on chain", async () => {
    const sup = await supply();
    const s = supplyFields(sup.datum!);
    const qty = s[1]! - s[0]! + 1n;
    const n = "Custom";
    const lo = slotToUnixTime(n, unixTimeToSlot(n, emulator.now() - 120_000));
    const next = Data.to(
      new Constr(1, [new Constr(0, [s[0]! + qty, s[1], s[2], s[3], s[4], s[5]! + 1n])]) as never,
    );
    let b = lucid
      .newTx()
      .collectFrom([sup], Data.to(new Constr(0, [qty, opKey]) as never))
      .readFrom([rc2.configRef])
      .attach.SpendingValidator(rplan.reserve.script)
      .mintAssets({ [tsraUnit]: qty }, Data.void())
      .pay.ToContract(rplan.reserveAddress, { kind: "inline", value: next }, sup.assets)
      .validFrom(lo)
      .validTo(lo + 3_600_000);
    for (const k of ops5.slice(0, 3)) b = b.addSignerKey(k);
    await assert.rejects(b.complete());
  });
  reset();
  await check("StakeShort that mints itself 1 extra sTSRA is rejected", async () => {
    const st = await at(vrec.vault!.address, vrec.vault!.stateUnit);
    const real = await buildStakeShort(
      lucid,
      { vault, reserveHash: rplan.reserve.hash, configRef: rc2.configRef },
      st,
      tsraToUnits("100"),
      opKey,
      operator.address,
      emulator.now(),
    );
    assert.ok(real);
    reset();
    const f = [...(Data.from(st.datum!) as Constr<Constr<bigint>>).fields[0]!.fields];
    const amt = tsraToUnits("100");
    const minted = (amt * f[0]!) / f[1]! + 1n;
    f[0] = f[0]! + minted;
    f[1] = f[1]! + amt;
    f[18] = f[18]! + 1n;
    const n = "Custom";
    const lo = slotToUnixTime(n, unixTimeToSlot(n, emulator.now() - 120_000));
    await assert.rejects(
      lucid
        .newTx()
        .collectFrom([st], Data.to(new Constr(0, [amt, opKey]) as never))
        .readFrom([rc2.configRef])
        .attach.SpendingValidator(vault.script)
        .mintAssets({ [vault.hash + STSRA]: minted }, Data.void())
        .pay.ToContract(
          st.address,
          { kind: "inline", value: Data.to(new Constr(0, [new Constr(0, f)]) as never) },
          {
            lovelace: st.assets.lovelace!,
            [vault.hash + fromHexState()]: 1n,
            [tsraUnit]: st.assets[tsraUnit]! + amt,
          },
        )
        .validFrom(lo)
        .validTo(lo + 3_600_000)
        .complete(),
    );
  });
  reset();
  await check("Fund signed by only 2 of 5 is rejected", async () =>
    assert.rejects(
      buildFund(
        lucid,
        {
          queue,
          adminReward: rewardAddress("Custom", qs.admin),
          adminRef: qctx.refs.admin!,
          queueConfig: await at(qrec.queue!.address, qrec.queue!.configUnit),
          reserveConfig: rc2.configRef,
          payoutUnit,
          signers: ops5.slice(0, 2),
        },
        await at(qrec.queue!.address, qrec.queue!.shardUnits[1]),
        1_000_000n,
        emulator.now(),
      ),
    ),
  );

  console.log(`\n${passed} checks passed.`);
}

function fromHexState() {
  return "7374617465"; // "state"
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
