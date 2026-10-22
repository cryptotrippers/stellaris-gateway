/**
 * Stage 5a — the first transactions that move value (Preprod tests).
 * Build only; never sign. Each `.chain()`s and evaluates every Plutus script
 * against the exact transaction.
 *
 *   attest   reserve `Attest { reserve }` (committee): records the attested
 *            reserve and anchors `attested_at` at the validity lower bound.
 *   mint     reserve `Mint { qty, holder }` (committee): TSRA to `to`, needs a
 *            fresh attestation and supply ≤ min(attested reserve, mint cap).
 *   stake    vault `StakeShort { amount, holder }` (anyone): TSRA into the
 *            vault State, sTSRA minted at the current price (1:1 first stake).
 *   fund     queue_admin `Fund` (committee): payout token into a Buffer shard.
 *
 * Redeemer encodings (contracts/tessera/plutus.json):
 *   ReserveRedeemer  Mint{qty,holder}=0  Attest{reserve}=2
 *   VaultRedeemer    StakeShort{amount,holder}=0
 *   QueueSpend       Run=1
 *   AdminRedeemer    {queue, action}; Fund=6
 */
import {
  Constr,
  Data,
  fromText,
  slotToUnixTime,
  unixTimeToSlot,
  type Assets,
  type LucidEvolution,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import type { AppliedScript } from "./blueprint";

const DAY = 86_400_000;
export const TSRA = fromText("TSRA");
export const STSRA = fromText("sTSRA");
export const STATE = fromText("state");
/** exchange.min_initial_deposit: 10 TSRA. */
export const MIN_INITIAL_DEPOSIT = 10_000_000n;

export interface Step {
  name: string;
  tx: TxSignBuilder;
  record: Record<string, unknown>;
  /** Outputs the next step may need (new Supply / State / shard). */
  derived: UTxO[];
}

function window(lucid: LucidEvolution, nowMs: number) {
  const n = lucid.config().network!;
  const lo = slotToUnixTime(n, unixTimeToSlot(n, nowMs - 120_000));
  const hi = slotToUnixTime(n, unixTimeToSlot(n, lo + 3_600_000));
  return { lo, hi };
}

async function chained(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>) {
  const [walletUtxos, derived, tx] = await b.chain();
  lucid.overrideUTxOs(walletUtxos);
  return { tx, derived };
}

const fieldsOf = (cbor: string, outer: number, n: number): unknown[] => {
  const d = Data.from(cbor) as Constr<Constr<unknown>>;
  if (d.index !== outer || d.fields[0]?.fields.length !== n)
    throw new Error("unexpected datum shape");
  return [...d.fields[0]!.fields];
};
const encode = (outer: number, fields: unknown[]) =>
  Data.to(new Constr(outer, [new Constr(0, fields)]) as never);

/** SupplyState fields: [minted, attested_reserve, mint_cap, attestation_epoch, attested_at, epoch]. */
export const supplyFields = (cbor: string) => fieldsOf(cbor, 1, 6) as bigint[];

// ------------------------------------------------------------------ reserve

export interface ReserveCtx {
  reserve: AppliedScript;
  reserveAddress: string;
  configRef: UTxO;
  signers: string[];
}

export async function buildAttest(
  lucid: LucidEvolution,
  c: ReserveCtx,
  supply: UTxO,
  reserveUnits: bigint,
  nowMs: number,
): Promise<Step> {
  const s = supplyFields(supply.datum!);
  const { lo, hi } = window(lucid, nowMs);
  if (BigInt(lo) < s[4]!) throw new Error("Attest: lower bound before the last attestation");
  const next = encode(1, [s[0], reserveUnits, s[2], s[3]! + 1n, BigInt(lo), s[5]! + 1n]);
  let b = lucid
    .newTx()
    .collectFrom([supply], Data.to(new Constr(2, [reserveUnits]) as never))
    .readFrom([c.configRef])
    .attach.SpendingValidator(c.reserve.script)
    .pay.ToContract(c.reserveAddress, { kind: "inline", value: next }, supply.assets)
    .validFrom(lo)
    .validTo(hi);
  for (const k of c.signers) b = b.addSignerKey(k);
  const { tx, derived } = await chained(lucid, b);
  return {
    name: "attest",
    tx,
    derived,
    record: { attestedReserve: reserveUnits.toString(), attestedAt: lo, tx: tx.toHash() },
  };
}

export async function buildMint(
  lucid: LucidEvolution,
  c: ReserveCtx,
  supply: UTxO,
  qty: bigint,
  holder: string,
  to: string,
  nowMs: number,
): Promise<Step> {
  const s = supplyFields(supply.datum!);
  const { lo, hi } = window(lucid, nowMs);
  if (s[0]! + qty > s[1]! || s[0]! + qty > s[2]!)
    throw new Error("Mint: exceeds the attested reserve or the mint cap");
  if (BigInt(hi) > s[4]! + 7n * BigInt(DAY))
    throw new Error("Mint: attestation is stale; attest first");
  const next = encode(1, [s[0]! + qty, s[1], s[2], s[3], s[4], s[5]! + 1n]);
  const tsraUnit = c.reserve.hash + TSRA;
  let b = lucid
    .newTx()
    .collectFrom([supply], Data.to(new Constr(0, [qty, holder]) as never))
    .readFrom([c.configRef])
    .attach.SpendingValidator(c.reserve.script)
    .mintAssets({ [tsraUnit]: qty }, Data.void())
    .pay.ToContract(c.reserveAddress, { kind: "inline", value: next }, supply.assets)
    .pay.ToAddress(to, { lovelace: 2_000_000n, [tsraUnit]: qty })
    .validFrom(lo)
    .validTo(hi);
  for (const k of c.signers) b = b.addSignerKey(k);
  const { tx, derived } = await chained(lucid, b);
  return {
    name: "mint",
    tx,
    derived,
    record: {
      qty: qty.toString(),
      to,
      mintedSupplyAfter: (s[0]! + qty).toString(),
      tx: tx.toHash(),
    },
  };
}

// -------------------------------------------------------------------- vault

/** VaultState indices (19 fields; see vault_state.ak). */
const V = {
  shortShares: 0,
  shortAssets: 1,
  longAssets: 3,
  vestShort: 8,
  vestLong: 9,
  vestFrom: 10,
  vestUntil: 11,
  epoch: 18,
  shortGen: 6,
} as const;

const vested = (u: bigint, from: bigint, until: bigint, t: bigint) =>
  t <= from ? 0n : t >= until ? u : (u * (t - from)) / (until - from);

/** vault_state.fold at t. */
export function fold(f: unknown[], t: bigint): unknown[] {
  const from = f[V.vestFrom] as bigint;
  const until = f[V.vestUntil] as bigint;
  const t1 = t < from ? from : t > until ? until : t;
  const vs = vested(f[V.vestShort] as bigint, from, until, t1);
  const vl = vested(f[V.vestLong] as bigint, from, until, t1);
  const g = [...f];
  g[V.shortAssets] = (f[V.shortAssets] as bigint) + vs;
  g[V.longAssets] = (f[V.longAssets] as bigint) + vl;
  g[V.vestShort] = (f[V.vestShort] as bigint) - vs;
  g[V.vestLong] = (f[V.vestLong] as bigint) - vl;
  g[V.vestFrom] = t1;
  return g;
}

export async function buildStakeShort(
  lucid: LucidEvolution,
  v: { vault: AppliedScript; reserveHash: string; configRef: UTxO },
  state: UTxO,
  amount: bigint,
  holder: string,
  to: string,
  nowMs: number,
): Promise<Step> {
  const f0 = fieldsOf(state.datum!, 0, 19);
  const { lo, hi } = window(lucid, nowMs);
  const sf = fold(f0, BigInt(lo));
  const shares0 = sf[V.shortShares] as bigint;
  const priceAssets =
    (sf[V.shortAssets] as bigint) +
    vested(
      sf[V.vestShort] as bigint,
      sf[V.vestFrom] as bigint,
      sf[V.vestUntil] as bigint,
      BigInt(hi),
    );
  const minted = shares0 === 0n ? amount : (amount * shares0) / priceAssets;
  if (shares0 === 0n ? amount < MIN_INITIAL_DEPOSIT : minted <= 0n)
    throw new Error("StakeShort: below the minimum deposit");
  if ((sf[V.shortGen] as bigint) !== 0n)
    throw new Error("StakeShort: generation > 0 not handled here");
  const s1 = [...sf];
  s1[V.shortShares] = shares0 + minted;
  s1[V.shortAssets] = (sf[V.shortAssets] as bigint) + amount;
  s1[V.epoch] = (f0[V.epoch] as bigint) + 1n;
  const tsraUnit = v.reserveHash + TSRA;
  const heldTsra =
    (sf[V.shortAssets] as bigint) +
    (sf[V.longAssets] as bigint) +
    (sf[V.vestShort] as bigint) +
    (sf[V.vestLong] as bigint);
  const nextAssets: Assets = {
    lovelace: state.assets.lovelace!,
    [v.vault.hash + STATE]: 1n,
    [tsraUnit]: heldTsra + amount,
  };
  const stsraUnit = v.vault.hash + STSRA;
  const { tx, derived } = await chained(
    lucid,
    lucid
      .newTx()
      .collectFrom([state], Data.to(new Constr(0, [amount, holder]) as never))
      .readFrom([v.configRef])
      .attach.SpendingValidator(v.vault.script)
      .mintAssets({ [stsraUnit]: minted }, Data.void())
      .pay.ToContract(state.address, { kind: "inline", value: encode(0, s1) }, nextAssets)
      .pay.ToAddress(to, { lovelace: 2_000_000n, [stsraUnit]: minted })
      .validFrom(lo)
      .validTo(hi),
  );
  return {
    name: "stake",
    tx,
    derived,
    record: { amount: amount.toString(), stsraMinted: minted.toString(), to, tx: tx.toHash() },
  };
}

// -------------------------------------------------------------------- queue

export async function buildFund(
  lucid: LucidEvolution,
  q: {
    queue: AppliedScript;
    adminReward: string;
    adminRef: UTxO;
    queueConfig: UTxO;
    reserveConfig: UTxO;
    payoutUnit: string;
    signers: string[];
  },
  shard: UTxO,
  amount: bigint,
  nowMs: number,
): Promise<Step> {
  const { lo, hi } = window(lucid, nowMs);
  const next: Assets = {
    ...shard.assets,
    [q.payoutUnit]: (shard.assets[q.payoutUnit] ?? 0n) + amount,
  };
  let b = lucid
    .newTx()
    .collectFrom([shard], Data.to(new Constr(1, []) as never))
    .readFrom([q.adminRef, q.queueConfig, q.reserveConfig])
    .attach.SpendingValidator(q.queue.script)
    .withdraw(q.adminReward, 0n, Data.to(new Constr(0, [q.queue.hash, new Constr(6, [])]) as never))
    .pay.ToContract(shard.address, { kind: "inline", value: shard.datum! }, next)
    .validFrom(lo)
    .validTo(hi);
  for (const k of q.signers) b = b.addSignerKey(k);
  const { tx, derived } = await chained(lucid, b);
  return {
    name: "fund",
    tx,
    derived,
    record: {
      amount: amount.toString(),
      shard: `${shard.txHash}#${String(shard.outputIndex)}`,
      tx: tx.toHash(),
    },
  };
}
