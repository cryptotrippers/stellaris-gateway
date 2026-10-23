/**
 * Stage 5c — closing the loops opened in 5b. Build only; never sign.
 * No step needs the committee: Settle is permissionless (a keeper earns the
 * settle tip), Sweep burns under the reserve's bearer `Burn`, and Claim is
 * permissionless (the Ticket pays only its owner).
 *
 *   settle  queue_flow Settle: spend one shard + the payable Requests, burn
 *           their markers, move their TSRA into one Sink and pay each
 *           `payout_to` its qty in tUSD plus its lovelace less the tip.
 *   sweep   queue_flow Sweep: spend every Sink and the reserve Supply under
 *           `Burn { qty = Σ Sink TSRA }`; the TSRA is burned, no queue output.
 *   claim   vault Claim (State via vault_ops OpsClaim + the Ticket): after
 *           the cooldown, pay the owner the Ticket's value and its lovelace,
 *           burn the marker, lower ticket_escrow.
 *
 * Encodings (plutus.json): QueueSpend Run=1; FlowAction Settle=2, Sweep=3;
 * ReserveRedeemer Burn{qty,holder}=1; VaultRedeemer Claim=3;
 * OpsAction OpsClaim=3; QueueDatum Request=1, Sink=2, Shard=3;
 * VaultDatum TicketDatum=2.
 */
import {
  CML,
  Constr,
  Data,
  slotToUnixTime,
  unixTimeToSlot,
  type Assets,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { plutusAddressToBech32 } from "../../../src/lib/tessera-live.server";
import type { AppliedScript } from "./blueprint";
import { STATE, TSRA, type Step } from "./build-actions";

const DAY = 86_400_000n;
const MARKER = "706f736974696f6e"; // "position"
const REQUEST = "72657175657374"; // "request"
const RUN = Data.to(new Constr(1, []) as never);
const SINK = Data.to(new Constr(2, []) as never);

async function chained(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>) {
  const [walletUtxos, derived, tx] = await b.chain();
  lucid.overrideUTxOs(walletUtxos);
  return { tx, derived };
}
function window(lucid: LucidEvolution, nowMs: number) {
  const n = lucid.config().network!;
  const lo = slotToUnixTime(n, unixTimeToSlot(n, nowMs - 120_000));
  const hi = slotToUnixTime(n, unixTimeToSlot(n, lo + 3_600_000));
  return { lo, hi };
}
const big = (x: unknown) => x as bigint;
const inner = (cbor: string) => [...(Data.from(cbor) as Constr<Constr<unknown>>).fields[0]!.fields];
const outref = (u: UTxO) => `${u.txHash}#${String(u.outputIndex)}`;
const iso = (ms: bigint | number) => new Date(Number(ms)).toISOString();
const toBech32 = (a: unknown) => plutusAddressToBech32(a, CML);

/** Tests only: skip the off-chain guards so the validators get to refuse. */
export interface Unsafe {
  skipGuards?: boolean;
}

// ------------------------------------------------------------------ settle

export interface SettleCtx {
  queue: AppliedScript;
  flowReward: string;
  reserveHash: string;
  refs: { flow: UTxO };
  queueConfig: UTxO;
  queueShort: UTxO;
  reserveConfig: UTxO;
}

export const payableAfterOf = (r: UTxO) => big(inner(r.datum!)[4]);

/** The Requests payable at `nowMs` (their window must open 2 min before now). */
export function payable(requests: UTxO[], nowMs: number): UTxO[] {
  return requests.filter((r) => payableAfterOf(r) <= BigInt(nowMs - 120_000));
}

export async function buildSettle(
  lucid: LucidEvolution,
  c: SettleCtx,
  shard: UTxO,
  requests: UTxO[],
  nowMs: number,
  unsafe: Unsafe = {},
): Promise<Step> {
  if (!requests.length) throw new Error("Settle: no Requests given");
  const cfg = inner(c.queueConfig.datum!);
  const payoutUnit = String(cfg[0]) + String(cfg[1]);
  const tip = big(cfg[5]);
  const shards = big(cfg[8]);
  const { lo, hi } = window(lucid, nowMs);
  const rs = requests.map((u) => {
    const f = inner(u.datum!);
    return {
      u,
      payoutTo: toBech32(f[1]),
      qty: big(f[2]),
      payableAfter: big(f[4]),
      regEpisode: big(f[5]),
    };
  });
  const total = rs.reduce((a, r) => a + r.qty, 0n);
  if (!unsafe.skipGuards) {
    for (const r of rs) {
      if (BigInt(lo) < r.payableAfter)
        throw new Error(
          `Settle: ${outref(r.u)} is payable after ${iso(r.payableAfter)} (UTC); not yet.`,
        );
      if (r.regEpisode !== 0n) throw new Error("Settle: a registered (short-mode) Request");
    }
  }
  const s0 = inner(shard.datum!).map(big);
  const day = BigInt(lo) / DAY;
  const month = day / 30n;
  if (day < s0[0]! || month < s0[2]!) throw new Error("Settle: shard is ahead of today");
  const pd = (day === s0[0] ? s0[1]! : 0n) + total;
  const pm = (month === s0[2] ? s0[3]! : 0n) + total;
  if (!unsafe.skipGuards) {
    if (pd > big(cfg[6]) / shards || pm > big(cfg[7]) / shards)
      throw new Error("Settle: shard day/month room exceeded; use another --shard");
    if ((shard.assets[payoutUnit] ?? 0n) < total)
      throw new Error("Settle: shard balance too low; use another --shard");
  }
  const shardAssets: Assets = { ...shard.assets, [payoutUnit]: shard.assets[payoutUnit]! - total };
  let b = lucid
    .newTx()
    .collectFrom([shard, ...rs.map((r) => r.u)], RUN)
    .attach.SpendingValidator(c.queue.script)
    .readFrom([c.refs.flow, c.queueConfig, c.queueShort, c.reserveConfig])
    .withdraw(c.flowReward, 0n, Data.to(new Constr(0, [c.queue.hash, new Constr(2, [])]) as never))
    .mintAssets({ [c.queue.hash + REQUEST]: -BigInt(rs.length) }, Data.void())
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
      { kind: "inline", value: SINK },
      { lovelace: 2_000_000n, [c.reserveHash + TSRA]: total },
    );
  for (const r of rs)
    b = b.pay.ToAddress(r.payoutTo, {
      lovelace: r.u.assets.lovelace! - tip,
      [payoutUnit]: r.qty,
    });
  const { tx, derived } = await chained(lucid, b.validFrom(lo).validTo(hi));
  return {
    name: "settle",
    tx,
    derived,
    record: {
      requests: rs.map((r) => outref(r.u)).join(", "),
      totalTsra: total.toString(),
      paidTusd: total.toString(),
      paidTo: [...new Set(rs.map((r) => r.payoutTo))].join(", "),
      shard: outref(shard),
      tx: tx.toHash(),
    },
  };
}

// ------------------------------------------------------------------- sweep

export interface SweepCtx {
  queue: AppliedScript;
  flowReward: string;
  reserveHash: string;
  reserveAddress: string;
  refs: { flow: UTxO; reserve: UTxO };
  reserveConfig: UTxO;
}

/** Queue UTxOs carrying a `Sink` datum. */
export function sinksAt(queueUtxos: UTxO[]): UTxO[] {
  return queueUtxos.filter((u) => {
    if (!u.datum) return false;
    try {
      const d = Data.from(u.datum) as Constr<unknown>;
      return d.index === 2 && d.fields.length === 0;
    } catch {
      return false;
    }
  });
}

export async function buildSweep(
  lucid: LucidEvolution,
  c: SweepCtx,
  sinks: UTxO[],
  supply: UTxO,
  burner: string,
  nowMs: number,
  unsafe: Unsafe & { burnDelta?: bigint } = {},
): Promise<Step> {
  if (!sinks.length) throw new Error("Sweep: no Sinks to sweep");
  const tsraUnit = c.reserveHash + TSRA;
  const total = sinks.reduce((a, s) => a + (s.assets[tsraUnit] ?? 0n), 0n);
  const qty = total + (unsafe.burnDelta ?? 0n);
  const sp = inner(supply.datum!).map(big);
  if (qty > sp[0]!) throw new Error("Sweep: burn exceeds the minted supply");
  const next = Data.to(
    new Constr(1, [
      new Constr(0, [sp[0]! - qty, sp[1], sp[2], sp[3], sp[4], sp[5]! + 1n]),
    ]) as never,
  );
  const { lo, hi } = window(lucid, nowMs);
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom(sinks, RUN)
      .attach.SpendingValidator(c.queue.script)
      .collectFrom([supply], Data.to(new Constr(1, [qty, burner]) as never))
      .readFrom([c.refs.flow, c.refs.reserve, c.reserveConfig])
      .withdraw(
        c.flowReward,
        0n,
        Data.to(new Constr(0, [c.queue.hash, new Constr(3, [])]) as never),
      )
      .mintAssets({ [tsraUnit]: -qty }, Data.void())
      .pay.ToContract(c.reserveAddress, { kind: "inline", value: next }, supply.assets)
      .validFrom(lo)
      .validTo(hi),
  );
  return {
    name: "sweep",
    tx,
    derived,
    record: {
      sinks: sinks.map(outref).join(", "),
      burnedTsra: qty.toString(),
      mintedSupplyAfter: (sp[0]! - qty).toString(),
      tx: tx.toHash(),
    },
  };
}

// ------------------------------------------------------------------- claim

export interface ClaimCtx {
  vault: AppliedScript;
  opsReward: string;
  reserveHash: string;
  refs: { vault: UTxO; ops: UTxO };
  reserveConfig: UTxO;
}

/** Ticket fields: [owner, value, index_at_request, claim_after]. */
export const ticketFields = (u: UTxO) => {
  const d = Data.from(u.datum!) as Constr<Constr<unknown>>;
  if (d.index !== 2) throw new Error(`${outref(u)} is not a Ticket`);
  const f = d.fields[0]!.fields;
  return {
    owner: toBech32(f[0]),
    value: big(f[1]),
    indexAtRequest: big(f[2]),
    claimAfter: big(f[3]),
  };
};

export async function buildClaim(
  lucid: LucidEvolution,
  c: ClaimCtx,
  state: UTxO,
  ticket: UTxO,
  nowMs: number,
  unsafe: Unsafe & { payTo?: string } = {},
): Promise<Step> {
  const t = ticketFields(ticket);
  const { lo, hi } = window(lucid, nowMs);
  if (!unsafe.skipGuards && BigInt(lo) < t.claimAfter)
    throw new Error(
      `Claim: ${outref(ticket)} is claimable after ${iso(t.claimAfter)} (UTC); not yet.`,
    );
  const s0 = inner(state.datum!);
  const lossIndex = big(s0[4]);
  const scaled = (t.value * lossIndex) / t.indexAtRequest;
  const payout = scaled > t.value ? t.value : scaled;
  if (payout !== t.value)
    throw new Error("Claim: the Ticket lost value (VaultClaimBurn needed); not handled here");
  const s1 = [...s0];
  const left = big(s0[5]) - payout;
  s1[5] = left > 0n ? left : 0n;
  s1[18] = big(s0[18]) + 1n;
  const claim = Data.to(new Constr(3, []) as never);
  const tsraUnit = c.reserveHash + TSRA;
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([state, ticket], claim)
      .readFrom([c.refs.vault, c.refs.ops, c.reserveConfig])
      .withdraw(c.opsReward, 0n, Data.to(new Constr(0, [c.vault.hash, new Constr(3, [])]) as never))
      .mintAssets({ [c.vault.hash + MARKER]: -1n }, Data.void())
      .pay.ToContract(
        state.address,
        { kind: "inline", value: Data.to(new Constr(0, [new Constr(0, s1)]) as never) },
        { ...state.assets, [c.vault.hash + STATE]: 1n },
      )
      .pay.ToAddress(unsafe.payTo ?? t.owner, {
        lovelace: ticket.assets.lovelace!,
        [tsraUnit]: payout,
      })
      .validFrom(lo)
      .validTo(hi),
  );
  return {
    name: "claim",
    tx,
    derived,
    record: {
      ticket: outref(ticket),
      paidTsra: payout.toString(),
      paidTo: t.owner,
      escrowAfter: s1[5]!.toString(),
      tx: tx.toHash(),
    },
  };
}
