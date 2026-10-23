/**
 * Emulator fixture for the self-tests: the whole preprod-v1 deployment
 * (reserve, vault, queue) plus Stage 5a, built with the same builders the
 * operator scripts use and the real compiled scripts. Test-only.
 */
import {
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { applyQueueScripts, applyRedeemQueue, applyVault, applyVaultOps } from "./blueprint";
import { buildAttest, buildFund, buildMint, buildStakeShort } from "./build-actions";
import { buildGenesis } from "./build-genesis";
import { QUEUE_BUILDERS, QUEUE_STAGES, type QueueContext } from "./build-queue";
import { BUILDERS, STAGES, pickSeed, type VaultContext } from "./build-vault";
import { tsraToUnits } from "./genesis";
import { rewardAddress } from "./blueprint";
import { PROPOSED_BOUNDS } from "./vault-genesis";

export const keyHash = (a: string) => getAddressDetails(a).paymentCredential!.hash;

export async function setupDeployment() {
  const operator = generateEmulatorAccountFromPrivateKey({ lovelace: 3_000_000_000n });
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
  const signers = ops5.slice(0, 3);

  async function submit(steps: { name: string; tx: any }[], committeeSigned: string[]) {
    reset();
    for (const s of steps) {
      let b = s.tx.sign.withWallet();
      if (committeeSigned.includes(s.name))
        for (const c of committee.slice(0, 3)) b = b.sign.withPrivateKey(c.privateKey);
      const h = await (await b.complete()).submit();
      emulator.awaitBlock(1);
      if (!(await lucid.awaitTx(h))) throw new Error(`${s.name} not confirmed`);
    }
    reset();
  }
  const at = async (addr: string, unit: string): Promise<UTxO> =>
    (await lucid.utxosAt(addr)).find((u) => (u.assets[unit] ?? 0n) === 1n)!;

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
  await submit([{ name: "reserve", tx: rplan.tx }], []);
  const cfg = () => at(rplan.reserveAddress, rplan.units.config);
  const supply = () => at(rplan.reserveAddress, rplan.units.supply);

  const vctx: VaultContext = {
    reserve: rplan.reserve,
    reserveAddress: rplan.reserveAddress,
    treasuryAddress: operator.address,
    bounds: PROPOSED_BOUNDS,
    configUtxo: await cfg(),
    signers,
  };
  const vs = [];
  for (const s of STAGES) vs.push(await BUILDERS[s](lucid, vctx));
  await submit(vs, ["setVault"]);
  const v = Object.fromEntries(vs.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, any>
  >;

  const qctx: QueueContext = {
    reserve: rplan.reserve,
    operatorKeyHash: opKey,
    reserveConfig: await cfg(),
    reserveSupply: await supply(),
    signers,
    refs: {},
  };
  const qsteps = [];
  for (const s of QUEUE_STAGES) qsteps.push(await QUEUE_BUILDERS[s](lucid, qctx, emulator.now()));
  await submit(qsteps, ["queue"]);
  const q = Object.fromEntries(qsteps.map((b) => [b.name, b.record])) as Record<
    string,
    Record<string, any>
  >;

  const ops = applyVaultOps(rplan.reserve.hash);
  const vault = applyVault(v.vault!.seed, rplan.reserve.hash, ops.hash);
  const qs = applyQueueScripts(rplan.reserve.hash);
  const queue = applyRedeemQueue(q.queue!.seed, rplan.reserve.hash, {
    flow: qs.flow.hash,
    admin: qs.admin.hash,
    short: qs.short.hash,
  });

  // Stage 5a
  const rc = {
    reserve: rplan.reserve,
    reserveAddress: rplan.reserveAddress,
    configRef: await cfg(),
    signers,
  };
  const a = await buildAttest(lucid, rc, await supply(), tsraToUnits("100000"), emulator.now());
  const s1 = a.derived.find((u) => (u.assets[rplan.units.supply] ?? 0n) === 1n)!;
  const m = await buildMint(
    lucid,
    rc,
    s1,
    tsraToUnits("10000"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const st = await buildStakeShort(
    lucid,
    { vault, reserveHash: rplan.reserve.hash, configRef: rc.configRef },
    await at(v.vault!.address, v.vault!.stateUnit),
    tsraToUnits("1000"),
    opKey,
    operator.address,
    emulator.now(),
  );
  const f = await buildFund(
    lucid,
    {
      queue,
      adminReward: rewardAddress("Custom", qs.admin),
      adminRef: qctx.refs.admin!,
      queueConfig: await at(q.queue!.address, q.queue!.configUnit),
      reserveConfig: rc.configRef,
      payoutUnit: q.tusd!.unit,
      signers,
    },
    await at(q.queue!.address, q.queue!.shardUnits[0]),
    20_000_000_000n,
    emulator.now(),
  );
  await submit([a, m, st, f], ["attest", "mint", "fund"]);

  return {
    emulator,
    lucid,
    operator,
    committee,
    ops5,
    opKey,
    signers,
    reset,
    submit,
    at,
    cfg,
    supply,
    rplan,
    v,
    q,
    qctx,
    ops,
    vault,
    qs,
    queue,
  };
}
