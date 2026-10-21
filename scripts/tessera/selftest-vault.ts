/**
 * Self-test for the vault bootstrap. No network, no keys.
 *
 *   npx tsx scripts/tessera/selftest-vault.ts
 *
 * On Lucid's Emulator, with the REAL compiled scripts from contracts/tessera:
 *   reserve genesis → first_loss genesis → vault_ops stake registration →
 *   stsra_vault genesis → reserve SetVault (3-of-5 committee),
 * then reads every State back, and checks the validators refuse:
 *   SetVault signed by 2 of 5, SetVault that also changes another Config field,
 *   a vault genesis with out-of-range bounds, a first-loss genesis holding TSRA… (not
 *   mintable here) → a first-loss genesis with balance 1 in its datum.
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
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { applyFirstLoss, applyVault, applyVaultOps, enterpriseAddress } from "./lib/blueprint";
import { buildGenesis } from "./lib/build-genesis";
import { BUILDERS, STAGES, pickSeed, type VaultContext } from "./lib/build-vault";
import { decodeReserveDatum, tsraToUnits } from "./lib/genesis";
import {
  PROPOSED_BOUNDS,
  THREAD_NAME,
  boundsProblems,
  setVaultConfigDatum,
  setVaultRedeemer,
  vaultStateDatumCbor,
} from "./lib/vault-genesis";

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
  const operator = generateEmulatorAccount({ lovelace: 500_000_000n });
  const committee = [1, 2, 3, 4, 5].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 10_000_000n }),
  );
  const emulator = new Emulator([operator, ...committee]);
  const lucid: LucidEvolution = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(operator.seedPhrase);
  emulator.awaitSlot(600);

  console.log("pure checks");
  await check("proposed SPEC bounds pass bounds_ok", () =>
    assert.deepEqual(boundsProblems(PROPOSED_BOUNDS), []),
  );
  await check("cooldown under 7 days is refused", () =>
    assert.ok(boundsProblems({ ...PROPOSED_BOUNDS, shortCooldownMs: 6 * 86_400_000 }).length),
  );
  await check("lock under 2x cooldown is refused", () =>
    assert.ok(boundsProblems({ ...PROPOSED_BOUNDS, longLockMs: 13 * 86_400_000 }).length),
  );
  await check("protocol fee above 20% is refused", () =>
    assert.ok(boundsProblems({ ...PROPOSED_BOUNDS, protocolBps: 2_001 }).length),
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
  const rtx = await (await rplan.tx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  await check("reserve genesis confirmed", async () => assert.ok(await lucid.awaitTx(rtx)));
  const configUtxo = async (): Promise<UTxO> =>
    (await lucid.utxosAt(rplan.reserveAddress)).find(
      (u) => (u.assets[rplan.units.config] ?? 0n) === 1n,
    )!;

  console.log("vault bootstrap: 4 chained transactions (real validators)");
  const ctx: VaultContext = {
    reserve: rplan.reserve,
    reserveAddress: rplan.reserveAddress,
    treasuryAddress: operator.address,
    bounds: PROPOSED_BOUNDS,
    configUtxo: await configUtxo(),
    signers: ops5.slice(0, 3),
  };
  const built = [];
  for (const s of STAGES) {
    const b = await BUILDERS[s](lucid, ctx);
    built.push(b);
    await check(`${s}: built and evaluated (${String(b.tx.toCBOR().length / 2)} bytes)`, () =>
      assert.ok(b.tx.toCBOR().length / 2 <= 16_384),
    );
  }
  lucid.overrideUTxOs([]); // back to the chain's view
  lucid.selectWallet.fromSeed(operator.seedPhrase);

  for (const b of built) {
    let signer = b.tx.sign.withWallet();
    if (b.name === "setVault")
      for (const c of committee.slice(0, 3)) signer = signer.sign.withPrivateKey(c.privateKey);
    const h = await (await signer.complete()).submit();
    emulator.awaitBlock(1);
    await check(`${b.name}: confirmed`, async () => assert.ok(await lucid.awaitTx(h)));
  }

  const r = Object.fromEntries(built.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, unknown>
  >;
  await check("first-loss State: one UTxO, ADA + `state`, datum {0, 0}", async () => {
    const at = await lucid.utxosAt(r.firstLoss!.address as string);
    assert.equal(at.length, 1);
    assert.deepEqual(
      Object.keys(at[0]!.assets).sort(),
      ["lovelace", r.firstLoss!.stateUnit].sort(),
    );
    assert.equal(at[0]!.datum, Data.to(new Constr(0, [0n, 0n]) as never));
  });
  await check("vault_ops stake credential is registered", () => {
    const reward = r.opsStake!.rewardAddress as string;
    assert.equal(
      (emulator.chain as Record<string, { registeredStake?: boolean }>)[reward]?.registeredStake,
      true,
    );
  });
  await check("vault State: one UTxO, ADA + `state`, genesis datum", async () => {
    const at = await lucid.utxosAt(r.vault!.address as string);
    assert.equal(at.length, 1);
    assert.deepEqual(Object.keys(at[0]!.assets).sort(), ["lovelace", r.vault!.stateUnit].sort());
    assert.equal(
      at[0]!.datum,
      vaultStateDatumCbor({
        bounds: PROPOSED_BOUNDS,
        firstLossHash: r.firstLoss!.scriptHash as string,
        treasuryAddress: operator.address,
      }),
    );
  });
  await check("vault is parameterised by the applied vault_ops hash", () =>
    assert.equal(r.vault!.opsHash, applyVaultOps(rplan.reserve.hash).hash),
  );
  await check("Config now points at the vault, epoch 1, nothing else changed", async () => {
    const c = await configUtxo();
    const d = decodeReserveDatum(c.datum!)!;
    assert.equal(d.kind, "config");
    assert.equal(d.fields[7], r.vault!.scriptHash);
    assert.equal(d.fields[9], 1n);
    assert.deepEqual(d.fields[0], ops5);
    assert.equal(d.fields[6], rplan.eligibility.hash);
  });
  await check("reserve still holds exactly Config + Supply", async () =>
    assert.equal((await lucid.utxosAt(rplan.reserveAddress)).length, 2),
  );

  console.log("on-chain refusals (validator must reject)");
  const vault2Hash = applyVault(
    { txHash: "00".repeat(32), outputIndex: 9 },
    rplan.reserve.hash,
    applyVaultOps(rplan.reserve.hash).hash,
  ).hash;
  async function setVaultWith(signers: string[], tamper?: (cbor: string) => string) {
    const c = await configUtxo();
    let next = setVaultConfigDatum(c.datum!, vault2Hash);
    if (tamper) next = tamper(next);
    let b = lucid
      .newTx()
      .collectFrom([c], setVaultRedeemer(vault2Hash))
      .attach.SpendingValidator(rplan.reserve.script)
      .pay.ToContract(rplan.reserveAddress, { kind: "inline", value: next }, c.assets);
    for (const s of signers) b = b.addSignerKey(s);
    return b.complete();
  }
  await check("control: SetVault again with 3 of 5 is accepted", () =>
    setVaultWith(ops5.slice(2, 5)),
  );
  await check("SetVault with only 2 of 5 signatures is rejected", () =>
    assert.rejects(setVaultWith(ops5.slice(0, 2))),
  );
  await check("SetVault that also pauses the reserve is rejected", () =>
    assert.rejects(
      setVaultWith(ops5.slice(0, 3), (cbor) => {
        const d = decodeReserveDatum(cbor)!;
        const f = [...d.fields];
        f[2] = new Constr(1, []);
        return Data.to(new Constr(0, [new Constr(0, f)]) as never);
      }),
    ),
  );
  async function vaultGenesisWith(datum: (fl: string) => string) {
    const seed = await pickSeed(lucid);
    const v = applyVault(
      { txHash: seed.txHash, outputIndex: seed.outputIndex },
      rplan.reserve.hash,
      applyVaultOps(rplan.reserve.hash).hash,
    );
    return lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [v.hash + THREAD_NAME]: 1n }, Data.void())
      .attach.MintingPolicy(v.script)
      .pay.ToContract(
        enterpriseAddress("Custom", v),
        { kind: "inline", value: datum(r.firstLoss!.scriptHash as string) },
        { lovelace: 5_000_000n, [v.hash + THREAD_NAME]: 1n },
      )
      .complete();
  }
  const okDatum = (fl: string) =>
    vaultStateDatumCbor({
      bounds: PROPOSED_BOUNDS,
      firstLossHash: fl,
      treasuryAddress: operator.address,
    });
  await check("control: a second, untampered vault genesis is accepted", () =>
    vaultGenesisWith(okDatum),
  );
  await check("vault genesis with a 6-day cooldown is rejected", () =>
    assert.rejects(
      vaultGenesisWith((fl) =>
        vaultStateDatumCbor({
          bounds: { ...PROPOSED_BOUNDS, shortCooldownMs: 6 * 86_400_000 },
          firstLossHash: fl,
          treasuryAddress: operator.address,
        }),
      ),
    ),
  );
  await check("first-loss genesis with balance 1 in its datum is rejected", async () => {
    const seed = await pickSeed(lucid);
    const fl = applyFirstLoss(
      { txHash: seed.txHash, outputIndex: seed.outputIndex },
      rplan.reserve.hash,
    );
    await assert.rejects(
      lucid
        .newTx()
        .collectFrom([seed])
        .mintAssets({ [fl.hash + THREAD_NAME]: 1n }, Data.void())
        .attach.MintingPolicy(fl.script)
        .pay.ToContract(
          enterpriseAddress("Custom", fl),
          { kind: "inline", value: Data.to(new Constr(0, [1n, 0n]) as never) },
          { lovelace: 5_000_000n, [fl.hash + THREAD_NAME]: 1n },
        )
        .complete(),
    );
  });

  console.log(`\n${passed} checks passed.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
