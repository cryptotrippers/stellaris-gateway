/**
 * Stage 5b — yield, exit and redemption on Preprod. Build only; never sign.
 *
 *   refs         publish vault, vault_ops, first_loss and reserve as reference
 *                scripts (ReportYield needs three of them in one tx: > 16 KB inline).
 *   reportYield  vault ReportYield via vault_ops (committee): `gross` TSRA in;
 *                protocol cut half → first-loss (Deposit, ≤ 3% of supply),
 *                rest → treasury; net vests to the classes over 7 days.
 *   unstake      vault RequestUnstake: burn sTSRA, mint a marker, open a Ticket
 *                escrowing their value; claimable after the 7-day cooldown.
 *   request      queue_flow Request: TSRA into a Request UTxO (marker minted),
 *                payable after (bucket + 1) day + settle_delay.
 *   instant      queue_flow Instant: TSRA → Sink, tUSD from a shard to the
 *                holder at once (≤ instant_max and the shard's day/month room).
 *
 * Encodings (plutus.json): VaultRedeemer RequestUnstake=2, ReportYield=5;
 * OpsRedeemer {vault, OpsReportYield{gross}=1}; FirstLossRedeemer Deposit=0;
 * VaultDatum TicketDatum=2; QueueDatum Request=1, Sink=2, Shard=3;
 * QueueSpend Run=1; FlowRedeemer {queue, FlowRequest=0 | FlowInstant{holder,qty}=1}.
 */
import {
  Constr,
  Data,
  slotToUnixTime,
  unixTimeToSlot,
  validatorToAddress,
  type Assets,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { AppliedScript } from "./blueprint";
import { STATE, STSRA, TSRA, fold, type Step } from "./build-actions";
import { lockScript } from "./build-queue";
import { addressData } from "./vault-genesis";

const DAY = 86_400_000n;
const MARKER = "706f736974696f6e"; // "position"
const REQUEST = "72657175657374"; // "request"

async function chained(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>) {
  const [walletUtxos, derived, tx] = await b.chain();
  lucid.overrideUTxOs(walletUtxos);
  return { tx, derived };
}
function window(lucid: LucidEvolution, nowMs: number, lengthMs = 3_600_000) {
  const n = lucid.config().network!;
  const lo = slotToUnixTime(n, unixTimeToSlot(n, nowMs - 120_000));
  const hi = slotToUnixTime(n, unixTimeToSlot(n, lo + lengthMs));
  return { lo, hi };
}
const inner = (cbor: string) => [...(Data.from(cbor) as Constr<Constr<unknown>>).fields[0]!.fields];
const big = (x: unknown) => x as bigint;
const outref = (u: UTxO) => `${u.txHash}#${String(u.outputIndex)}`;

// ------------------------------------------------------------------- refs

export async function buildRef(
  lucid: LucidEvolution,
  name: string,
  s: AppliedScript,
): Promise<Step> {
  const lock = validatorToAddress(lucid.config().network!, lockScript());
  const { tx, derived } = await chained(
    lucid,
    lucid.newTx().pay.ToAddressWithData(lock, undefined, {}, s.script),
  );
  const ref = derived.find((u) => u.address === lock && u.scriptRef)!;
  return {
    name,
    tx,
    derived,
    record: { scriptHash: s.hash, refUtxo: `${tx.toHash()}#${String(ref.outputIndex)}` },
  };
}

// -------------------------------------------------------------- reportYield

/** vault_state.split_yield */
export function splitYield(
  gross: bigint,
  protocolBps: bigint,
  aShort: bigint,
  aLong: bigint,
  longW: bigint,
) {
  const cut = (gross * protocolBps) / 10_000n;
  const half = cut / 2n;
  const rest = cut - half;
  const net = gross - cut;
  const wS = aShort * 10_000n;
  const wL = aLong * longW;
  const yLong = (net * wL) / (wS + wL);
  return { half, rest, yShort: net - yLong, yLong };
}

export interface VaultCtx {
  vault: AppliedScript;
  ops: AppliedScript;
  opsReward: string;
  reserveHash: string;
  refs: { vault: UTxO; ops: UTxO; firstLoss: UTxO };
  reserveConfig: UTxO;
  reserveSupply: UTxO;
  signers: string[];
}

export async function buildReportYield(
  lucid: LucidEvolution,
  c: VaultCtx,
  state: UTxO,
  firstLoss: UTxO,
  gross: bigint,
  nowMs: number,
): Promise<Step> {
  const { lo, hi } = window(lucid, nowMs);
  const s0 = inner(state.datum!);
  const sf = fold(s0, BigInt(lo));
  const aShort = big(sf[1]) + big(sf[8]);
  const aLong = big(sf[3]) + big(sf[9]);
  const { half, rest, yShort, yLong } = splitYield(gross, big(s0[15]), aShort, aLong, big(s0[12]));
  const minted = big(inner(c.reserveSupply.datum!)[0]);
  const fl0 = (Data.from(firstLoss.datum!) as Constr<bigint>).fields;
  const cap = (minted * 300n) / 10_000n;
  const room = cap > fl0[0]! ? cap - fl0[0]! : 0n;
  const toReserve = half < room ? half : room;
  const start = BigInt(lo) > big(sf[10]) ? BigInt(lo) : big(sf[10]);
  const s1 = [...sf];
  s1[8] = big(sf[8]) + yShort;
  s1[9] = big(sf[9]) + yLong;
  s1[10] = start;
  s1[11] = start + 604_800_000n;
  s1[18] = big(s0[18]) + 1n;
  const tsraUnit = c.reserveHash + TSRA;
  const stateTsra = big(s1[1]) + big(s1[3]) + big(s1[8]) + big(s1[9]);
  let b = lucid
    .newTx()
    .collectFrom([state], Data.to(new Constr(5, []) as never))
    .readFrom([c.refs.vault, c.refs.ops, c.reserveConfig, c.reserveSupply])
    .withdraw(
      c.opsReward,
      0n,
      Data.to(new Constr(0, [c.vault.hash, new Constr(1, [gross])]) as never),
    )
    .pay.ToContract(
      state.address,
      { kind: "inline", value: Data.to(new Constr(0, [new Constr(0, s1)]) as never) },
      { lovelace: state.assets.lovelace!, [c.vault.hash + STATE]: 1n, [tsraUnit]: stateTsra },
    )
    .validFrom(lo)
    .validTo(hi);
  if (toReserve > 0n) {
    const flAssets: Assets = {
      ...firstLoss.assets,
      [tsraUnit]: (firstLoss.assets[tsraUnit] ?? 0n) + toReserve,
    };
    b = b
      .collectFrom([firstLoss], Data.to(new Constr(0, [toReserve]) as never))
      .readFrom([c.refs.firstLoss])
      .pay.ToContract(
        firstLoss.address,
        {
          kind: "inline",
          value: Data.to(new Constr(0, [fl0[0]! + toReserve, fl0[1]! + 1n]) as never),
        },
        flAssets,
      );
  } else {
    // ops still reads the first-loss balance: reference it.
    b = b.readFrom([firstLoss]);
  }
  for (const k of c.signers) b = b.addSignerKey(k);
  const { tx, derived } = await chained(lucid, b);
  return {
    name: "reportYield",
    tx,
    derived,
    record: {
      gross: gross.toString(),
      toFirstLoss: toReserve.toString(),
      toTreasury: (rest + half - toReserve).toString(),
      vestShort: yShort.toString(),
      vestLong: yLong.toString(),
      vestUntil: Number(start + 604_800_000n),
      tx: tx.toHash(),
    },
  };
}

// ----------------------------------------------------------------- unstake

export async function buildRequestUnstake(
  lucid: LucidEvolution,
  c: VaultCtx,
  state: UTxO,
  shares: bigint,
  owner: string,
  nowMs: number,
): Promise<Step> {
  const { lo, hi } = window(lucid, nowMs);
  const s0 = inner(state.datum!);
  const sf = fold(s0, BigInt(lo));
  const totalShares = big(sf[0]);
  const shortAssets = big(sf[1]);
  if (shares <= 0n || shares > totalShares) throw new Error("RequestUnstake: shares out of range");
  if (shares >= totalShares)
    throw new Error("RequestUnstake: full exit (sweep) is not handled here; unstake part");
  const v = (shares * shortAssets) / totalShares;
  if (v < 2_000_000n) throw new Error("RequestUnstake: below the 2 TSRA minimum");
  if (big(sf[6]) !== 0n) throw new Error("RequestUnstake: generation > 0 not handled here");
  const claimAfter = BigInt(hi) + big(s0[13]);
  const s1 = [...sf];
  s1[0] = totalShares - shares;
  s1[1] = shortAssets - v;
  s1[5] = big(s0[5]) + v;
  s1[18] = big(s0[18]) + 1n;
  const tsraUnit = c.reserveHash + TSRA;
  const stateTsra = big(s1[1]) + big(s1[3]) + big(s1[8]) + big(s1[9]);
  const ticket = Data.to(
    new Constr(2, [new Constr(0, [addressData(owner), v, big(s0[4]), claimAfter])]) as never,
  );
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([state], Data.to(new Constr(2, [shares, addressData(owner)]) as never))
      .readFrom([c.refs.vault, c.reserveConfig])
      .mintAssets({ [c.vault.hash + MARKER]: 1n, [c.vault.hash + STSRA]: -shares }, Data.void())
      .pay.ToContract(
        state.address,
        { kind: "inline", value: Data.to(new Constr(0, [new Constr(0, s1)]) as never) },
        { lovelace: state.assets.lovelace!, [c.vault.hash + STATE]: 1n, [tsraUnit]: stateTsra },
      )
      .pay.ToContract(
        state.address,
        { kind: "inline", value: ticket },
        {
          lovelace: 3_000_000n,
          [c.vault.hash + MARKER]: 1n,
          [tsraUnit]: v,
        },
      )
      .validFrom(lo)
      .validTo(hi),
  );
  const t = derived.find((u) => (u.assets[c.vault.hash + MARKER] ?? 0n) === 1n);
  return {
    name: "unstake",
    tx,
    derived,
    record: {
      shares: shares.toString(),
      ticketValue: v.toString(),
      claimAfter: Number(claimAfter),
      claimAfterIso: new Date(Number(claimAfter)).toISOString(),
      ticket: t ? `${tx.toHash()}#${String(t.outputIndex)}` : null,
      tx: tx.toHash(),
    },
  };
}

// ------------------------------------------------------------------- queue

export interface QueueCtx {
  queue: AppliedScript;
  flowReward: string;
  reserveHash: string;
  refs: { flow: UTxO };
  queueConfig: UTxO;
  queueShort: UTxO;
  reserveConfig: UTxO;
}

const flowRedeemer = (q: string, action: Constr<unknown>) =>
  Data.to(new Constr(0, [q, action]) as never);

export async function buildRequest(
  lucid: LucidEvolution,
  c: QueueCtx,
  qty: bigint,
  ownerKeyHash: string,
  payoutTo: string,
  nowMs: number,
): Promise<Step> {
  const cfg = inner(c.queueConfig.datum!);
  // a Request's window: ≤ 1 h and inside one UTC day
  // (UTC midnight is 11:00 in Sydney): cut the window at the end of the day,
  // and refuse when too little of the day is left for the tx to land in it.
  const net = lucid.config().network!;
  const w = window(lucid, nowMs, 1_800_000);
  const lo = w.lo;
  let hi = w.hi;
  const dayEnd = Number((BigInt(lo) / DAY + 1n) * DAY) - 1_000;
  if (hi > dayEnd) hi = slotToUnixTime(net, unixTimeToSlot(net, dayEnd));
  if (hi - lo < 15 * 60_000)
    throw new Error(
      "Request: under 15 minutes left in this UTC day (midnight UTC = 11:00 Sydney). Re-run after midnight UTC.",
    );
  if (qty < big(cfg[3])) throw new Error(`Request: below min_request ${String(cfg[3])}`);
  const bucket = BigInt(lo) / DAY;
  const payableAfter = (bucket + 1n) * DAY + big(cfg[2]);
  const datum = Data.to(
    new Constr(1, [
      new Constr(0, [ownerKeyHash, addressData(payoutTo), qty, bucket, payableAfter, 0n]),
    ]) as never,
  );
  const qAddr = validatorToAddress(lucid.config().network!, c.queue.script);
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .readFrom([c.refs.flow, c.queueConfig, c.reserveConfig])
      .withdraw(c.flowReward, 0n, flowRedeemer(c.queue.hash, new Constr(0, [])))
      .mintAssets({ [c.queue.hash + REQUEST]: 1n }, Data.void())
      .attach.MintingPolicy(c.queue.script)
      .pay.ToContract(
        qAddr,
        { kind: "inline", value: datum },
        {
          lovelace: 3_000_000n,
          [c.queue.hash + REQUEST]: 1n,
          [c.reserveHash + TSRA]: qty,
        },
      )
      .addSignerKey(ownerKeyHash)
      .validFrom(lo)
      .validTo(hi),
  );
  const r = derived.find((u) => (u.assets[c.queue.hash + REQUEST] ?? 0n) === 1n);
  return {
    name: "request",
    tx,
    derived,
    record: {
      qty: qty.toString(),
      payoutTo,
      bucket: Number(bucket),
      payableAfter: Number(payableAfter),
      payableAfterIso: new Date(Number(payableAfter)).toISOString(),
      request: r ? `${tx.toHash()}#${String(r.outputIndex)}` : null,
      tx: tx.toHash(),
    },
  };
}

export async function buildInstant(
  lucid: LucidEvolution,
  c: QueueCtx,
  shard: UTxO,
  qty: bigint,
  holderKeyHash: string,
  holderAddress: string,
  nowMs: number,
): Promise<Step> {
  const cfg = inner(c.queueConfig.datum!);
  const { lo, hi } = window(lucid, nowMs);
  const payoutUnit = String(cfg[0]) + String(cfg[1]);
  const shards = big(cfg[8]);
  const dailyCap = big(cfg[6]) / shards;
  const monthlyCap = big(cfg[7]) / shards;
  if (qty <= 0n || qty > big(cfg[4])) throw new Error("Instant: above instant_max");
  const s0 = inner(shard.datum!).map(big);
  const day = BigInt(lo) / DAY;
  const month = day / 30n;
  if (day < s0[0]! || month < s0[2]!) throw new Error("Instant: shard is ahead of today");
  const pd = (day === s0[0] ? s0[1]! : 0n) + qty;
  const pm = (month === s0[2] ? s0[3]! : 0n) + qty;
  if (pd > dailyCap || pm > monthlyCap) throw new Error("Instant: shard day/month room exceeded");
  if ((shard.assets[payoutUnit] ?? 0n) < qty) throw new Error("Instant: shard balance too low");
  const shardAssets: Assets = { ...shard.assets, [payoutUnit]: shard.assets[payoutUnit]! - qty };
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([shard], Data.to(new Constr(1, []) as never))
      .attach.SpendingValidator(c.queue.script)
      .readFrom([c.refs.flow, c.queueConfig, c.queueShort, c.reserveConfig])
      .withdraw(c.flowReward, 0n, flowRedeemer(c.queue.hash, new Constr(1, [holderKeyHash, qty])))
      .pay.ToContract(
        shard.address,
        {
          kind: "inline",
          value: Data.to(new Constr(3, [new Constr(0, [day, pd, month, pm])]) as never),
        },
        shardAssets,
      )
      .pay.ToContract(
        shard.address,
        { kind: "inline", value: Data.to(new Constr(2, []) as never) },
        {
          lovelace: 2_000_000n,
          [c.reserveHash + TSRA]: qty,
        },
      )
      .pay.ToAddress(holderAddress, { lovelace: 2_000_000n, [payoutUnit]: qty })
      .addSignerKey(holderKeyHash)
      .validFrom(lo)
      .validTo(hi),
  );
  return {
    name: "instant",
    tx,
    derived,
    record: { qty: qty.toString(), shard: outref(shard), paidTo: holderAddress, tx: tx.toHash() },
  };
}
