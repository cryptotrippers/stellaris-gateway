/**
 * Tessera in the browser (build guide P5): the user actions on a deployed
 * Tessera, built for a CIP-30 wallet.
 *
 *   stakeShort       TSRA → sTSRA at the vault's current price
 *   requestUnstake   sTSRA → a Ticket of TSRA, claimable after the cooldown
 *   claim            a Ticket → its TSRA, to its owner (anyone may build it)
 *   request          TSRA → a queue Request, paid in the payout token after the delay
 *   instant          TSRA → the payout token now, within a shard's limits
 *   settle           pay payable Requests from a shard (keeper; anyone may)
 *   cancel           take an unregistered Request back (owner) — off on preprod-v1 (C-1)
 *
 * Ported from the operator builders in scripts/tessera/lib (build-actions,
 * build-5b, build-5c), which ran on Preprod, with three changes for the
 * browser: Lucid is passed in (never imported at runtime, so nothing ships
 * into the SSR bundle); scripts come from the on-chain reference scripts, each
 * checked against its expected hash, plus the applied `redeem_queue` (checked
 * too); and every builder returns the S1 intent the wallet guard checks the
 * transaction against before it can be signed.
 *
 * Each builder re-reads the genuine State (by thread token) at build time and
 * refuses early, with a readable reason, where the scripts would refuse.
 */
import type * as LucidNs from "@lucid-evolution/lucid";
import type { LucidEvolution, TxSignBuilder, UTxO } from "@lucid-evolution/lucid";
import { tesseraAddressToBech32 } from "./tessera-datum.shared";
import type { TesseraDeployment } from "./tessera-deployment";
import type { TxIntent } from "./tx-intent-guard.shared";

type LucidMod = typeof LucidNs;

export interface TesseraCtx {
  lucid: LucidEvolution;
  L: LucidMod;
  dep: TesseraDeployment;
}

export interface TesseraBuilt {
  tx: TxSignBuilder;
  intent: TxIntent;
  /** What the action does, in numbers, for the confirm step and the record. */
  summary: Record<string, string>;
}

/** A refusal the user can read: the scripts would refuse this, so nothing was built. */
export class TesseraRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TesseraRefused";
  }
}

const refuse = (m: string): never => {
  throw new TesseraRefused(m);
};

const DAY = 86_400_000n;
const MIN_INITIAL_DEPOSIT = 10_000_000n;
const MIN_TICKET = 2_000_000n;
const TICKET_RIDER = 3_000_000n;
const REQUEST_RIDER = 3_000_000n;
const OUT_RIDER = 2_000_000n;

// ---------------------------------------------------------------- guards

/** Refuse unless the wallet is on Preprod (network id 0 and an addr_test1 address). */
export function assertPreprodWallet(address: string, networkId?: number): void {
  if (networkId !== undefined && networkId !== 0)
    refuse("Your wallet is not on Preprod. Switch it to the Preprod testnet and reconnect.");
  if (!address.startsWith("addr_test1"))
    refuse("This is not a Preprod (testnet) address. Tessera here runs on Preprod only.");
}

export type TesseraErrorKind = "refused" | "contention" | "declined" | "other";

/**
 * Sort an error for the UI. "contention": someone else spent an input first
 * (a busy State or shard) — rebuild against the fresh chain and ask the user to
 * sign again; never resubmit automatically.
 */
export function classifyTesseraError(e: unknown): { kind: TesseraErrorKind; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof TesseraRefused) return { kind: "refused", message };
  if (
    /BadInputs|inputs are spent|already (been )?spent|UTxO.{0,40}not found|unknown input/i.test(
      message,
    )
  )
    return {
      kind: "contention",
      message:
        "Someone else used the same on-chain state first. Nothing was taken from your wallet; build it again and sign the new transaction.",
    };
  if (/declin|reject|cancel(l)?ed by user|user canceled/i.test(message))
    return { kind: "declined", message: "You declined in the wallet. Nothing was sent." };
  return { kind: "other", message };
}

// ---------------------------------------------------------------- data

type Constr = { index: number; fields: unknown[] };
const big = (x: unknown) => x as bigint;
const outref = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

function inner(ctx: TesseraCtx, cbor: string): unknown[] {
  const d = ctx.L.Data.from(cbor) as unknown as Constr;
  const i = d.fields[0] as Constr | undefined;
  if (!i || !Array.isArray(i.fields)) throw new TesseraRefused("Unexpected datum shape.");
  return [...i.fields];
}
const C = (ctx: TesseraCtx, index: number, fields: unknown[]) => new ctx.L.Constr(index, fields);
const enc = (ctx: TesseraCtx, d: unknown) => ctx.L.Data.to(d as never);

/** Plutus Address data for a bech32 address. */
function addressData(ctx: TesseraCtx, bech32: string) {
  const d = ctx.L.getAddressDetails(bech32);
  const pay = d.paymentCredential;
  if (!pay) refuse(`${bech32} has no payment credential.`);
  const cred = (c: { type: "Key" | "Script"; hash: string }) =>
    C(ctx, c.type === "Key" ? 0 : 1, [c.hash]);
  const stake = d.stakeCredential
    ? C(ctx, 0, [C(ctx, 0, [cred(d.stakeCredential)])])
    : C(ctx, 1, []);
  return C(ctx, 0, [cred(pay!), stake]);
}

function keyHashOf(ctx: TesseraCtx, bech32: string): string {
  const c = ctx.L.getAddressDetails(bech32).paymentCredential;
  if (!c || c.type !== "Key") refuse("Connect a wallet with a key (not script) address.");
  return c!.hash;
}

/** Validity: from 2 min before now (the chain tip trails the clock) for `lengthMs`. */
function window(ctx: TesseraCtx, nowMs: number, lengthMs = 3_600_000) {
  const n = ctx.dep.network as never;
  const lo = ctx.L.slotToUnixTime(n, ctx.L.unixTimeToSlot(n, nowMs - 120_000));
  const hi = ctx.L.slotToUnixTime(n, ctx.L.unixTimeToSlot(n, lo + lengthMs));
  return { lo, hi };
}

// ---------------------------------------------------------------- reading

async function one(ctx: TesseraCtx, address: string, unit: string, what: string): Promise<UTxO> {
  const xs = (await ctx.lucid.utxosAtWithUnit(address, unit)).filter(
    (u) => (u.assets[unit] ?? 0n) === 1n && u.address === address,
  );
  if (xs.length === 0) refuse(`The ${what} is not on chain.`);
  if (xs.length > 1) refuse(`More than one UTxO claims the ${what}'s thread token. Refusing.`);
  return xs[0]!;
}

export const vaultState = (ctx: TesseraCtx) =>
  one(ctx, ctx.dep.vault.address, ctx.dep.vault.stateUnit, "vault State");
export const queueConfig = (ctx: TesseraCtx) =>
  one(ctx, ctx.dep.queue.address, ctx.dep.queue.configUnit, "queue Config");
export const queueShort = (ctx: TesseraCtx) =>
  one(ctx, ctx.dep.queue.address, ctx.dep.queue.shortUnit, "queue ShortState");
export const reserveConfig = (ctx: TesseraCtx) =>
  one(ctx, ctx.dep.reserve.address, ctx.dep.reserve.configUnit, "reserve Config");
export const shards = async (ctx: TesseraCtx) =>
  Promise.all(
    ctx.dep.queue.shardUnits.map((u, i) => one(ctx, ctx.dep.queue.address, u, `shard ${i}`)),
  );

/** The three reference scripts, each checked to carry the script it should. */
export async function loadRefs(ctx: TesseraCtx): Promise<{ vault: UTxO; ops: UTxO; flow: UTxO }> {
  const { refs } = ctx.dep;
  const got = await ctx.lucid.utxosByOutRef([refs.vault, refs.ops, refs.flow]);
  const pick = (r: { txHash: string; outputIndex: number }, hash: string, name: string) => {
    const u = got.find((x) => x.txHash === r.txHash && x.outputIndex === r.outputIndex);
    if (!u?.scriptRef) refuse(`The ${name} reference script is missing on chain.`);
    if (ctx.L.validatorToScriptHash(u!.scriptRef!) !== hash)
      refuse(`The ${name} reference script is not the expected script. Do not sign.`);
    return u!;
  };
  return {
    vault: pick(refs.vault, ctx.dep.vault.hash, "vault"),
    ops: pick(refs.ops, ctx.dep.ops.hash, "vault_ops"),
    flow: pick(refs.flow, ctx.dep.flow.hash, "queue_flow"),
  };
}

/** The applied redeem_queue, checked against the deployment's queue hash. */
function queueScript(ctx: TesseraCtx) {
  const s = { type: "PlutusV3" as const, script: ctx.dep.queue.script };
  if (ctx.L.validatorToScriptHash(s) !== ctx.dep.queue.hash)
    refuse("The bundled queue script does not match this deployment. Do not sign.");
  return s;
}

export interface Ticket {
  utxo: UTxO;
  owner: string;
  value: bigint;
  indexAtRequest: bigint;
  claimAfter: bigint;
}

/** Tickets at the vault (marker-bearing, Ticket datum); optionally only `owner`'s. */
export async function tickets(ctx: TesseraCtx, owner?: string): Promise<Ticket[]> {
  const xs = await ctx.lucid.utxosAtWithUnit(ctx.dep.vault.address, ctx.dep.vault.markerUnit);
  const out: Ticket[] = [];
  for (const u of xs) {
    if (u.address !== ctx.dep.vault.address || !u.datum) continue;
    try {
      const d = ctx.L.Data.from(u.datum) as unknown as Constr;
      if (d.index !== 2) continue;
      const f = (d.fields[0] as Constr).fields;
      const t = {
        utxo: u,
        owner: tesseraAddressToBech32(f[0]),
        value: big(f[1]),
        indexAtRequest: big(f[2]),
        claimAfter: big(f[3]),
      };
      if (!owner || t.owner === owner) out.push(t);
    } catch {
      // not a Ticket
    }
  }
  return out;
}

export interface Request {
  utxo: UTxO;
  ownerKeyHash: string;
  payoutTo: string;
  qty: bigint;
  bucket: bigint;
  payableAfter: bigint;
  regEpisode: bigint;
}

/** Request UTxOs (marker-bearing); optionally only those of `ownerKeyHash`. */
export async function requests(ctx: TesseraCtx, ownerKeyHash?: string): Promise<Request[]> {
  const xs = await ctx.lucid.utxosAtWithUnit(ctx.dep.queue.address, ctx.dep.queue.requestUnit);
  const out: Request[] = [];
  for (const u of xs) {
    if (u.address !== ctx.dep.queue.address || !u.datum) continue;
    try {
      const d = ctx.L.Data.from(u.datum) as unknown as Constr;
      if (d.index !== 1) continue;
      const f = (d.fields[0] as Constr).fields;
      const r = {
        utxo: u,
        ownerKeyHash: String(f[0]),
        payoutTo: tesseraAddressToBech32(f[1]),
        qty: big(f[2]),
        bucket: big(f[3]),
        payableAfter: big(f[4]),
        regEpisode: big(f[5]),
      };
      if (!ownerKeyHash || r.ownerKeyHash === ownerKeyHash) out.push(r);
    } catch {
      // not a Request
    }
  }
  return out;
}

// ---------------------------------------------------------------- vault maths

const V = {
  shortShares: 0,
  shortAssets: 1,
  longAssets: 3,
  lossIndex: 4,
  ticketEscrow: 5,
  shortGen: 6,
  vestShort: 8,
  vestLong: 9,
  vestFrom: 10,
  vestUntil: 11,
  cooldown: 13,
  epoch: 18,
} as const;

const vested = (u: bigint, from: bigint, until: bigint, t: bigint) =>
  t <= from ? 0n : t >= until ? u : (u * (t - from)) / (until - from);

/** vault_state.fold at t: move what has vested into the classes. */
export function foldVault(f: readonly unknown[], t: bigint): unknown[] {
  const from = big(f[V.vestFrom]);
  const until = big(f[V.vestUntil]);
  const t1 = t < from ? from : t > until ? until : t;
  const vs = vested(big(f[V.vestShort]), from, until, t1);
  const vl = vested(big(f[V.vestLong]), from, until, t1);
  const g = [...f];
  g[V.shortAssets] = big(f[V.shortAssets]) + vs;
  g[V.longAssets] = big(f[V.longAssets]) + vl;
  g[V.vestShort] = big(f[V.vestShort]) - vs;
  g[V.vestLong] = big(f[V.vestLong]) - vl;
  g[V.vestFrom] = t1;
  return g;
}

const heldTsra = (s: readonly unknown[]) =>
  big(s[V.shortAssets]) + big(s[V.longAssets]) + big(s[V.vestShort]) + big(s[V.vestLong]);

/** sTSRA a stake of `amount` would mint now (the price the script will use). */
export function quoteStake(stateFields: readonly unknown[], amount: bigint, nowMs: number) {
  const lo = BigInt(nowMs - 120_000);
  const hi = lo + 3_600_000n;
  const sf = foldVault(stateFields, lo);
  const shares0 = big(sf[V.shortShares]);
  const priceAssets =
    big(sf[V.shortAssets]) +
    vested(big(sf[V.vestShort]), big(sf[V.vestFrom]), big(sf[V.vestUntil]), hi);
  return shares0 === 0n ? amount : (amount * shares0) / priceAssets;
}

// ---------------------------------------------------------------- vault actions

/** Stake TSRA in the short tier; sTSRA comes back to the wallet. */
export async function buildStakeShort(
  ctx: TesseraCtx,
  amount: bigint,
  nowMs: number,
): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  const me = await ctx.lucid.wallet().address();
  const holder = keyHashOf(ctx, me);
  const [state, refs, cfg] = await Promise.all([
    vaultState(ctx),
    loadRefs(ctx),
    reserveConfig(ctx),
  ]);
  const f0 = inner(ctx, state.datum!);
  const { lo, hi } = window(ctx, nowMs);
  const sf = foldVault(f0, BigInt(lo));
  if (big(sf[V.shortGen]) !== 0n)
    refuse("The short tier is in a new generation; not handled here.");
  const shares0 = big(sf[V.shortShares]);
  const priceAssets =
    big(sf[V.shortAssets]) +
    vested(big(sf[V.vestShort]), big(sf[V.vestFrom]), big(sf[V.vestUntil]), BigInt(hi));
  const minted = shares0 === 0n ? amount : (amount * shares0) / priceAssets;
  if (amount <= 0n || (shares0 === 0n ? amount < MIN_INITIAL_DEPOSIT : minted <= 0n))
    refuse("That stake is below the minimum.");
  const s1 = [...sf];
  s1[V.shortShares] = shares0 + minted;
  s1[V.shortAssets] = big(sf[V.shortAssets]) + amount;
  s1[V.epoch] = big(f0[V.epoch]) + 1n;
  const tx = await ctx.lucid
    .newTx()
    .collectFrom([state], enc(ctx, C(ctx, 0, [amount, holder])))
    .readFrom([refs.vault, cfg])
    .mintAssets({ [dep.vault.stsraUnit]: minted }, L.Data.void())
    .pay.ToContract(
      state.address,
      { kind: "inline", value: enc(ctx, C(ctx, 0, [C(ctx, 0, s1)])) },
      {
        lovelace: state.assets.lovelace!,
        [dep.vault.stateUnit]: 1n,
        [dep.reserve.tsraUnit]: heldTsra(sf) + amount,
      },
    )
    .pay.ToAddress(me, { lovelace: OUT_RIDER, [dep.vault.stsraUnit]: minted })
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: {
      action: "tessera.stakeShort",
      pay: [state.address],
      mint: { [dep.vault.stsraUnit]: minted },
      spend: { assets: { [dep.reserve.tsraUnit]: amount } },
    },
    summary: { stakeTsra: amount.toString(), stsraMinted: minted.toString() },
  };
}

/** Burn sTSRA for a Ticket of TSRA, claimable after the vault's cooldown. */
export async function buildRequestUnstake(
  ctx: TesseraCtx,
  shares: bigint,
  nowMs: number,
): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  const me = await ctx.lucid.wallet().address();
  const [state, refs, cfg] = await Promise.all([
    vaultState(ctx),
    loadRefs(ctx),
    reserveConfig(ctx),
  ]);
  const { lo, hi } = window(ctx, nowMs);
  const s0 = inner(ctx, state.datum!);
  const sf = foldVault(s0, BigInt(lo));
  const total = big(sf[V.shortShares]);
  const assets = big(sf[V.shortAssets]);
  if (shares <= 0n || shares > total) refuse("That is more sTSRA than the vault has issued.");
  if (shares >= total) refuse("Unstaking every last share is not handled here; leave a little.");
  if (big(sf[V.shortGen]) !== 0n)
    refuse("The short tier is in a new generation; not handled here.");
  const v = (shares * assets) / total;
  if (v < MIN_TICKET) refuse("A Ticket must be worth at least 2 TSRA.");
  const claimAfter = BigInt(hi) + big(s0[V.cooldown]);
  const s1 = [...sf];
  s1[V.shortShares] = total - shares;
  s1[V.shortAssets] = assets - v;
  s1[V.ticketEscrow] = big(s0[V.ticketEscrow]) + v;
  s1[V.epoch] = big(s0[V.epoch]) + 1n;
  const ticket = C(ctx, 2, [
    C(ctx, 0, [addressData(ctx, me), v, big(s0[V.lossIndex]), claimAfter]),
  ]);
  const tx = await ctx.lucid
    .newTx()
    .collectFrom([state], enc(ctx, C(ctx, 2, [shares, addressData(ctx, me)])))
    .readFrom([refs.vault, cfg])
    .mintAssets({ [dep.vault.markerUnit]: 1n, [dep.vault.stsraUnit]: -shares }, L.Data.void())
    .pay.ToContract(
      state.address,
      { kind: "inline", value: enc(ctx, C(ctx, 0, [C(ctx, 0, s1)])) },
      {
        lovelace: state.assets.lovelace!,
        [dep.vault.stateUnit]: 1n,
        [dep.reserve.tsraUnit]: heldTsra(s1),
      },
    )
    .pay.ToContract(
      state.address,
      { kind: "inline", value: enc(ctx, ticket) },
      { lovelace: TICKET_RIDER, [dep.vault.markerUnit]: 1n, [dep.reserve.tsraUnit]: v },
    )
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: {
      action: "tessera.requestUnstake",
      pay: [state.address],
      mint: { [dep.vault.markerUnit]: 1n, [dep.vault.stsraUnit]: -shares },
      spend: { lovelace: TICKET_RIDER, assets: { [dep.vault.stsraUnit]: shares } },
    },
    summary: {
      burnStsra: shares.toString(),
      ticketTsra: v.toString(),
      claimAfter: new Date(Number(claimAfter)).toISOString(),
    },
  };
}

/** Pay a Ticket out to its owner once its cooldown has passed. */
export async function buildClaim(ctx: TesseraCtx, t: Ticket, nowMs: number): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  const me = await ctx.lucid.wallet().address();
  const [state, refs, cfg] = await Promise.all([
    vaultState(ctx),
    loadRefs(ctx),
    reserveConfig(ctx),
  ]);
  const { lo, hi } = window(ctx, nowMs);
  if (BigInt(lo) < t.claimAfter)
    refuse(`This Ticket can be claimed after ${new Date(Number(t.claimAfter)).toISOString()}.`);
  const s0 = inner(ctx, state.datum!);
  const scaled = (t.value * big(s0[V.lossIndex])) / t.indexAtRequest;
  const payout = scaled > t.value ? t.value : scaled;
  if (payout !== t.value)
    refuse(
      "This Ticket lost value in a reported loss; claiming it needs the loss path (not here).",
    );
  const s1 = [...s0];
  const left = big(s0[V.ticketEscrow]) - payout;
  s1[V.ticketEscrow] = left > 0n ? left : 0n;
  s1[V.epoch] = big(s0[V.epoch]) + 1n;
  const tx = await ctx.lucid
    .newTx()
    .collectFrom([state, t.utxo], enc(ctx, C(ctx, 3, [])))
    .readFrom([refs.vault, refs.ops, cfg])
    .withdraw(dep.ops.rewardAddress, 0n, enc(ctx, C(ctx, 0, [dep.vault.hash, C(ctx, 3, [])])))
    .mintAssets({ [dep.vault.markerUnit]: -1n }, L.Data.void())
    .pay.ToContract(
      state.address,
      { kind: "inline", value: enc(ctx, C(ctx, 0, [C(ctx, 0, s1)])) },
      { ...state.assets, [dep.vault.stateUnit]: 1n },
    )
    .pay.ToAddress(t.owner, { lovelace: t.utxo.assets.lovelace!, [dep.reserve.tsraUnit]: payout })
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: {
      action: "tessera.claim",
      pay: t.owner === me ? [state.address] : [state.address, t.owner],
      mint: { [dep.vault.markerUnit]: -1n },
      withdrawals: [dep.ops.rewardAddress],
    },
    summary: { ticket: outref(t.utxo), paidTsra: payout.toString(), paidTo: t.owner },
  };
}

// ---------------------------------------------------------------- queue actions

/** Queue Config fields (see queue_state.QueueConfig). */
function config(ctx: TesseraCtx, cfg: UTxO) {
  const f = inner(ctx, cfg.datum!);
  return {
    payoutUnit: String(f[0]) + String(f[1]),
    settleDelay: big(f[2]),
    minRequest: big(f[3]),
    instantMax: big(f[4]),
    tip: big(f[5]),
    daily: big(f[6]),
    monthly: big(f[7]),
    shards: big(f[8]),
  };
}

/** A shard with `qty` of room today and this month and enough payout token, or null. */
function pickShard(
  ctx: TesseraCtx,
  all: UTxO[],
  cfg: ReturnType<typeof config>,
  qty: bigint,
  lo: number,
) {
  const day = BigInt(lo) / DAY;
  const month = day / 30n;
  for (const shard of all) {
    const s = inner(ctx, shard.datum!).map(big);
    if (day < s[0]! || month < s[2]!) continue;
    const pd = (day === s[0] ? s[1]! : 0n) + qty;
    const pm = (month === s[2] ? s[3]! : 0n) + qty;
    if (pd > cfg.daily / cfg.shards || pm > cfg.monthly / cfg.shards) continue;
    if ((shard.assets[cfg.payoutUnit] ?? 0n) < qty) continue;
    return { shard, next: [day, pd, month, pm] };
  }
  return null;
}

const flowRedeemer = (ctx: TesseraCtx, action: unknown) =>
  enc(ctx, C(ctx, 0, [ctx.dep.queue.hash, action]));

/**
 * The validity window of a Request: at most 30 minutes and inside one UTC day
 * (UTC midnight is 11:00 in Sydney). Refused with under 15 minutes of the day left.
 */
export function requestWindow(ctx: TesseraCtx, nowMs: number) {
  const n = ctx.dep.network as never;
  const w = window(ctx, nowMs, 1_800_000);
  const dayEnd = Number((BigInt(w.lo) / DAY + 1n) * DAY) - 1_000;
  const hi = w.hi > dayEnd ? ctx.L.slotToUnixTime(n, ctx.L.unixTimeToSlot(n, dayEnd)) : w.hi;
  if (hi - w.lo < 15 * 60_000)
    refuse(
      "Less than 15 minutes are left in this UTC day (midnight UTC is 11:00 Sydney). Try again after midnight UTC.",
    );
  return { lo: w.lo, hi };
}

/** Put TSRA in the queue; the payout token is paid to the wallet after the delay. */
export async function buildRequest(
  ctx: TesseraCtx,
  qty: bigint,
  nowMs: number,
): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  const me = await ctx.lucid.wallet().address();
  const owner = keyHashOf(ctx, me);
  const [qc, rc, refs] = await Promise.all([queueConfig(ctx), reserveConfig(ctx), loadRefs(ctx)]);
  const cfg = config(ctx, qc);
  const { lo, hi } = requestWindow(ctx, nowMs);
  if (qty < cfg.minRequest) refuse(`The smallest Request is ${cfg.minRequest} base units.`);
  const bucket = BigInt(lo) / DAY;
  const payableAfter = (bucket + 1n) * DAY + cfg.settleDelay;
  const datum = C(ctx, 1, [
    C(ctx, 0, [owner, addressData(ctx, me), qty, bucket, payableAfter, 0n]),
  ]);
  const tx = await ctx.lucid
    .newTx()
    .readFrom([refs.flow, qc, rc])
    .withdraw(dep.flow.rewardAddress, 0n, flowRedeemer(ctx, C(ctx, 0, [])))
    .mintAssets({ [dep.queue.requestUnit]: 1n }, L.Data.void())
    .attach.MintingPolicy(queueScript(ctx))
    .pay.ToContract(
      dep.queue.address,
      { kind: "inline", value: enc(ctx, datum) },
      { lovelace: REQUEST_RIDER, [dep.queue.requestUnit]: 1n, [dep.reserve.tsraUnit]: qty },
    )
    .addSignerKey(owner)
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: {
      action: "tessera.request",
      pay: [dep.queue.address],
      mint: { [dep.queue.requestUnit]: 1n },
      withdrawals: [dep.flow.rewardAddress],
      spend: { lovelace: REQUEST_RIDER, assets: { [dep.reserve.tsraUnit]: qty } },
    },
    summary: {
      requestTsra: qty.toString(),
      payableAfter: new Date(Number(payableAfter)).toISOString(),
    },
  };
}

/** Swap TSRA for the payout token now, from a shard with room. */
export async function buildInstant(
  ctx: TesseraCtx,
  qty: bigint,
  nowMs: number,
): Promise<TesseraBuilt> {
  const { dep } = ctx;
  const me = await ctx.lucid.wallet().address();
  const holder = keyHashOf(ctx, me);
  const [qc, qs, rc, refs, all] = await Promise.all([
    queueConfig(ctx),
    queueShort(ctx),
    reserveConfig(ctx),
    loadRefs(ctx),
    shards(ctx),
  ]);
  const cfg = config(ctx, qc);
  const { lo, hi } = window(ctx, nowMs);
  if (qty <= 0n || qty > cfg.instantMax)
    refuse(`An instant swap is limited to ${cfg.instantMax} base units.`);
  const pick = pickShard(ctx, all, cfg, qty, lo);
  if (!pick) refuse("No shard has room for this today. Use a Request instead.");
  const { shard, next } = pick!;
  const tx = await ctx.lucid
    .newTx()
    .collectFrom([shard], enc(ctx, C(ctx, 1, [])))
    .attach.SpendingValidator(queueScript(ctx))
    .readFrom([refs.flow, qc, qs, rc])
    .withdraw(dep.flow.rewardAddress, 0n, flowRedeemer(ctx, C(ctx, 1, [holder, qty])))
    .pay.ToContract(
      shard.address,
      { kind: "inline", value: enc(ctx, C(ctx, 3, [C(ctx, 0, next)])) },
      { ...shard.assets, [cfg.payoutUnit]: shard.assets[cfg.payoutUnit]! - qty },
    )
    .pay.ToContract(
      shard.address,
      { kind: "inline", value: enc(ctx, C(ctx, 2, [])) },
      { lovelace: OUT_RIDER, [dep.reserve.tsraUnit]: qty },
    )
    .pay.ToAddress(me, { lovelace: OUT_RIDER, [cfg.payoutUnit]: qty })
    .addSignerKey(holder)
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: {
      action: "tessera.instant",
      pay: [dep.queue.address],
      withdrawals: [dep.flow.rewardAddress],
      spend: { lovelace: OUT_RIDER, assets: { [dep.reserve.tsraUnit]: qty } },
    },
    summary: { swapTsra: qty.toString(), receive: qty.toString(), shard: outref(shard) },
  };
}

/** Pay payable Requests from a shard with room (permissionless; the keeper earns the tips). */
export async function buildSettle(
  ctx: TesseraCtx,
  rs: Request[],
  nowMs: number,
): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  if (rs.length === 0) refuse("There are no Requests to settle.");
  const [qc, qs, rc, refs, all] = await Promise.all([
    queueConfig(ctx),
    queueShort(ctx),
    reserveConfig(ctx),
    loadRefs(ctx),
    shards(ctx),
  ]);
  const cfg = config(ctx, qc);
  const { lo, hi } = window(ctx, nowMs);
  for (const r of rs) {
    if (BigInt(lo) < r.payableAfter)
      refuse(`A Request is payable only after ${new Date(Number(r.payableAfter)).toISOString()}.`);
    if (r.regEpisode !== 0n) refuse("A registered (short-mode) Request is settled differently.");
  }
  const total = rs.reduce((a, r) => a + r.qty, 0n);
  const pick = pickShard(ctx, all, cfg, total, lo);
  if (!pick) refuse("No shard has room or balance for these Requests today.");
  const { shard, next } = pick!;
  let b = ctx.lucid
    .newTx()
    .collectFrom([shard, ...rs.map((r) => r.utxo)], enc(ctx, C(ctx, 1, [])))
    .attach.SpendingValidator(queueScript(ctx))
    .readFrom([refs.flow, qc, qs, rc])
    .withdraw(dep.flow.rewardAddress, 0n, flowRedeemer(ctx, C(ctx, 2, [])))
    .mintAssets({ [dep.queue.requestUnit]: -BigInt(rs.length) }, L.Data.void())
    .pay.ToContract(
      shard.address,
      { kind: "inline", value: enc(ctx, C(ctx, 3, [C(ctx, 0, next)])) },
      { ...shard.assets, [cfg.payoutUnit]: shard.assets[cfg.payoutUnit]! - total },
    )
    .pay.ToContract(
      shard.address,
      { kind: "inline", value: enc(ctx, C(ctx, 2, [])) },
      { lovelace: OUT_RIDER, [dep.reserve.tsraUnit]: total },
    );
  for (const r of rs)
    b = b.pay.ToAddress(r.payoutTo, {
      lovelace: r.utxo.assets.lovelace! - cfg.tip,
      [cfg.payoutUnit]: r.qty,
    });
  const tx = await b.validFrom(lo).validTo(hi).complete();
  return {
    tx,
    intent: {
      action: "tessera.settle",
      pay: [dep.queue.address, ...new Set(rs.map((r) => r.payoutTo))],
      mint: { [dep.queue.requestUnit]: -BigInt(rs.length) },
      withdrawals: [dep.flow.rewardAddress],
      spend: { lovelace: OUT_RIDER },
    },
    summary: {
      requests: String(rs.length),
      totalTsra: total.toString(),
      tipsLovelace: (cfg.tip * BigInt(rs.length)).toString(),
    },
  };
}

/** Take an unregistered Request back (owner). Refused where the deployment can't (C-1). */
export async function buildCancel(
  ctx: TesseraCtx,
  r: Request,
  nowMs: number,
  opts: { force?: boolean } = {},
): Promise<TesseraBuilt> {
  const { L, dep } = ctx;
  if (!dep.features.cancel && !opts.force)
    refuse(
      `Cancelling a Request is not possible on ${dep.label} (a known contract issue, fixed in the next deployment). It will be paid out after its delay instead.`,
    );
  const me = await ctx.lucid.wallet().address();
  const owner = keyHashOf(ctx, me);
  if (r.ownerKeyHash !== owner) refuse("Only the Request's owner can cancel it.");
  if (r.regEpisode !== 0n) refuse("A registered (short-mode) Request is cancelled differently.");
  const { lo, hi } = window(ctx, nowMs);
  const tx = await ctx.lucid
    .newTx()
    .collectFrom([r.utxo], enc(ctx, C(ctx, 0, [])))
    .attach.SpendingValidator(queueScript(ctx))
    .mintAssets({ [dep.queue.requestUnit]: -1n }, L.Data.void())
    .attach.MintingPolicy(queueScript(ctx))
    .pay.ToAddress(me, { lovelace: OUT_RIDER, [dep.reserve.tsraUnit]: r.qty })
    .addSignerKey(owner)
    .validFrom(lo)
    .validTo(hi)
    .complete();
  return {
    tx,
    intent: { action: "tessera.cancel", mint: { [dep.queue.requestUnit]: -1n } },
    summary: { request: outref(r.utxo), returnTsra: r.qty.toString() },
  };
}
