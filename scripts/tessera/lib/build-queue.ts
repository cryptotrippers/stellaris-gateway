/**
 * Build (never sign) the redemption-queue bootstrap, after the reserve and vault:
 *
 *   tusd        mint the Preprod test payout token tUSD (6 decimals) under a
 *               native script that only the operator key can satisfy.
 *   refFlow     publish queue_flow  as a reference script ┐ at an address no one
 *   refAdmin    publish queue_admin as a reference script ├ can ever spend (a
 *   refShort    publish queue_short as a reference script ┘ native "any of []").
 *               ~12 KB each: inline in Genesis they would exceed 16 KB.
 *   queueStake  register the three scripts' stake credentials (their publish
 *               handlers accept registration only), using the reference scripts.
 *   queue       Genesis: consume a seed, mint `queue`, `short`, `shard0..N-1`
 *               under redeem_queue, withdraw 0 from queue_admin with
 *               { queue, Genesis }, committee M-of-N, reserve Config + Supply
 *               as reference inputs (committee and limit floor).
 *
 * Builders `.chain()` so later stages spend earlier change before submission;
 * `.chain()` evaluates every Plutus script locally against the exact tx.
 */
import {
  Data,
  scriptFromNative,
  slotToUnixTime,
  unixTimeToSlot,
  validatorToAddress,
  mintingPolicyToId,
  fromText,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  applyQueueScripts,
  applyRedeemQueue,
  enterpriseAddress,
  rewardAddress,
  type AppliedScript,
} from "./blueprint";
import { pickSeed, type Built } from "./build-vault";
import {
  CONFIG_NAME,
  SHORT_NAME,
  adminGenesisRedeemer,
  defaultQueueParams,
  mintedSupplyOf,
  queueConfigDatumCbor,
  queueProblems,
  shardGenesisDatumCbor,
  shardName,
  shortGenesisDatumCbor,
} from "./queue-genesis";

export type QueueStage = "tusd" | "refFlow" | "refAdmin" | "refShort" | "queueStake" | "queue";
export const QUEUE_STAGES: QueueStage[] = [
  "tusd",
  "refFlow",
  "refAdmin",
  "refShort",
  "queueStake",
  "queue",
];

/** tUSD minted at bootstrap: 1,000,000 tUSD (6 decimals). */
export const TUSD_SUPPLY = 1_000_000_000_000n;
export const TUSD_NAME = fromText("tUSD");
const QUEUE_UTXO_LOVELACE = 3_000_000n;

/** A native script no transaction can ever satisfy: reference scripts parked here stay forever. */
export function lockScript(): Script {
  return scriptFromNative({ type: "any", scripts: [] });
}

export function tusdPolicy(operatorKeyHash: string): { script: Script; id: string } {
  const script = scriptFromNative({ type: "sig", keyHash: operatorKeyHash });
  return { script, id: mintingPolicyToId(script) };
}

export interface QueueContext {
  reserve: AppliedScript;
  operatorKeyHash: string;
  /** Reserve Config and Supply UTxOs (reference inputs for Genesis). */
  reserveConfig?: UTxO;
  reserveSupply?: UTxO;
  /** Committee key hashes signing Genesis (≥ threshold). */
  signers?: string[];
  /** Reference-script UTxOs, filled by the ref stages or found on chain when resuming. */
  refs: Partial<Record<"flow" | "admin" | "short", UTxO>>;
  /** tUSD policy, filled by the tusd stage or from the record. */
  tusdPolicyId?: string;
}

async function chained(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>) {
  const [walletUtxos, derived, tx] = await b.chain();
  lucid.overrideUTxOs(walletUtxos);
  return { tx, derived };
}

export async function buildTusd(lucid: LucidEvolution, ctx: QueueContext): Promise<Built> {
  const p = tusdPolicy(ctx.operatorKeyHash);
  const unit = p.id + TUSD_NAME;
  const operator = await lucid.wallet().address();
  const { tx } = await chained(
    lucid,
    lucid
      .newTx()
      .mintAssets({ [unit]: TUSD_SUPPLY })
      .attach.MintingPolicy(p.script)
      .addSignerKey(ctx.operatorKeyHash)
      .pay.ToAddress(operator, { lovelace: 2_000_000n, [unit]: TUSD_SUPPLY }),
  );
  ctx.tusdPolicyId = p.id;
  return {
    name: "tusd",
    tx,
    record: {
      policyId: p.id,
      unit,
      decimals: 6,
      minted: TUSD_SUPPLY.toString(),
      nativeScript: { type: "sig", keyHash: ctx.operatorKeyHash },
      mintTx: tx.toHash(),
      holder: operator,
    },
  };
}

function refBuilder(which: "flow" | "admin" | "short") {
  return async (lucid: LucidEvolution, ctx: QueueContext): Promise<Built> => {
    const network = lucid.config().network!;
    const s = applyQueueScripts(ctx.reserve.hash)[which];
    const lockAddress = validatorToAddress(network, lockScript());
    const { tx, derived } = await chained(
      lucid,
      lucid.newTx().pay.ToAddressWithData(lockAddress, undefined, {}, s.script),
    );
    const ref = derived.find((u) => u.address === lockAddress);
    if (!ref) throw new Error(`ref ${which}: output not found`);
    ctx.refs[which] = ref;
    return {
      name: `ref${which[0]!.toUpperCase()}${which.slice(1)}`,
      tx,
      record: {
        scriptHash: s.hash,
        lockAddress,
        refUtxo: `${tx.toHash()}#${String(ref.outputIndex)}`,
        lovelaceLocked: ref.assets.lovelace?.toString(),
      },
    };
  };
}

export async function buildQueueStake(lucid: LucidEvolution, ctx: QueueContext): Promise<Built> {
  const network = lucid.config().network!;
  const q = applyQueueScripts(ctx.reserve.hash);
  const refs = [ctx.refs.flow, ctx.refs.admin, ctx.refs.short];
  if (refs.some((r) => !r)) throw new Error("queueStake needs the three reference scripts");
  const rewards = {
    flow: rewardAddress(network, q.flow),
    admin: rewardAddress(network, q.admin),
    short: rewardAddress(network, q.short),
  };
  const { tx } = await chained(
    lucid,
    lucid
      .newTx()
      .readFrom(refs as UTxO[])
      .register.Stake(rewards.flow, Data.void())
      .register.Stake(rewards.admin, Data.void())
      .register.Stake(rewards.short, Data.void()),
  );
  return {
    name: "queueStake",
    tx,
    record: {
      flow: { scriptHash: q.flow.hash, rewardAddress: rewards.flow },
      admin: { scriptHash: q.admin.hash, rewardAddress: rewards.admin },
      short: { scriptHash: q.short.hash, rewardAddress: rewards.short },
      registrationTx: tx.toHash(),
    },
  };
}

export async function buildQueue(
  lucid: LucidEvolution,
  ctx: QueueContext,
  nowMs: number,
): Promise<Built> {
  const network = lucid.config().network!;
  if (!ctx.tusdPolicyId) throw new Error("queue genesis needs the tUSD policy");
  if (!ctx.refs.admin) throw new Error("queue genesis needs the queue_admin reference script");
  if (!ctx.reserveConfig || !ctx.reserveSupply)
    throw new Error("queue genesis needs the reserve Config and Supply");
  if (!ctx.signers?.length) throw new Error("queue genesis needs committee signers");

  const q = applyQueueScripts(ctx.reserve.hash);
  const seed = await pickSeed(lucid);
  const queue = applyRedeemQueue(
    { txHash: seed.txHash, outputIndex: seed.outputIndex },
    ctx.reserve.hash,
    { flow: q.flow.hash, admin: q.admin.hash, short: q.short.hash },
  );
  const params = defaultQueueParams(ctx.tusdPolicyId, TUSD_NAME);
  const problems = queueProblems(params, mintedSupplyOf(ctx.reserveSupply.datum!));
  if (problems.length) throw new Error(`Queue genesis refused:\n  - ${problems.join("\n  - ")}`);

  const address = enterpriseAddress(network, queue);
  const unit = (name: string) => queue.hash + name;
  const shardUnits = Array.from({ length: params.shards }, (_, i) => unit(shardName(i)));
  const lo = slotToUnixTime(network, unixTimeToSlot(network, nowMs - 120_000));
  const hi = slotToUnixTime(network, unixTimeToSlot(network, lo + 3_600_000));

  let b = lucid
    .newTx()
    .collectFrom([seed])
    .readFrom([ctx.refs.admin, ctx.reserveConfig, ctx.reserveSupply])
    .mintAssets(
      Object.fromEntries([unit(CONFIG_NAME), unit(SHORT_NAME), ...shardUnits].map((u) => [u, 1n])),
      Data.void(),
    )
    .attach.MintingPolicy(queue.script)
    .withdraw(rewardAddress(network, q.admin), 0n, adminGenesisRedeemer(queue.hash))
    .pay.ToContract(
      address,
      { kind: "inline", value: queueConfigDatumCbor(params) },
      { lovelace: QUEUE_UTXO_LOVELACE, [unit(CONFIG_NAME)]: 1n },
    )
    .pay.ToContract(
      address,
      { kind: "inline", value: shortGenesisDatumCbor() },
      { lovelace: QUEUE_UTXO_LOVELACE, [unit(SHORT_NAME)]: 1n },
    );
  for (const s of shardUnits)
    b = b.pay.ToContract(
      address,
      { kind: "inline", value: shardGenesisDatumCbor() },
      { lovelace: QUEUE_UTXO_LOVELACE, [s]: 1n },
    );
  for (const k of ctx.signers) b = b.addSignerKey(k);
  const { tx } = await chained(lucid, b.validFrom(lo).validTo(hi));

  return {
    name: "queue",
    tx,
    record: {
      seed: { txHash: seed.txHash, outputIndex: seed.outputIndex },
      scriptHash: queue.hash,
      address,
      configUnit: unit(CONFIG_NAME),
      shortUnit: unit(SHORT_NAME),
      shardUnits,
      params: {
        payoutUnit: ctx.tusdPolicyId + TUSD_NAME,
        settleDelayMs: params.settleDelayMs,
        minRequest: params.minRequest.toString(),
        instantMax: params.instantMax.toString(),
        settleTip: params.settleTip.toString(),
        dailyLimit: params.dailyLimit.toString(),
        monthlyLimit: params.monthlyLimit.toString(),
        shards: params.shards,
        graceMs: params.graceMs,
      },
      signers: ctx.signers,
      genesisTx: tx.toHash(),
    },
  };
}

export const QUEUE_BUILDERS: Record<
  QueueStage,
  (l: LucidEvolution, c: QueueContext, now: number) => Promise<Built>
> = {
  tusd: (l, c) => buildTusd(l, c),
  refFlow: refBuilder("flow"),
  refAdmin: refBuilder("admin"),
  refShort: refBuilder("short"),
  queueStake: (l, c) => buildQueueStake(l, c),
  queue: buildQueue,
};
