/**
 * fraction_vault v2 — transaction builders (E07, SPEC-v2.md §7).
 *
 * Each builder reads the chain through the Lucid instance it is given, works
 * out the ONE next State the validators accept (`offering-v2-chain.ts`),
 * refuses early with a readable reason when they would not, and returns:
 *
 *   * `tx`     — the completed, unsigned transaction;
 *   * `intent` — what it is allowed to do, for the S1 intent guard.
 *
 * Builders never sign. In the app, single-signer actions go through
 * `signGuarded` (see `submitV2`); committee actions are drafts that each
 * member co-signs with `partialSignGuarded`. The emulator tests sign with
 * private keys after checking the same intent.
 *
 * Layout rules the validators impose (SPEC-v2 §11.4, §11.6):
 *   * the State is ALWAYS output 0;
 *   * in `Settle`, outputs 1..N pay each pledge's owner in the order the pledges
 *     sit among the transaction's inputs (ledger order: tx hash, then index);
 *   * a cancel or refund payout carries the pledge's own output reference as
 *     its inline datum, at the output index named in the redeemer.
 *
 * Plain shared module: Lucid types only at the top level.
 */
import type { LucidEvolution, TxBuilder, TxSignBuilder, UTxO } from "@lucid-evolution/lucid";
import {
  KEEPER_BATCH,
  V2Refused,
  V2_MIN_RIDER,
  accounted,
  checkOpening,
  encodeOfferingAction,
  encodeOutRef,
  encodePledge,
  encodePledgeAction,
  encodePledgeMint,
  encodeState,
  nextState,
  readPledge,
  readState,
  settledState,
  type OfferingAction,
  type PlutusAddress,
  type V2Pledge,
  type V2State,
} from "./offering-v2-chain";
import type { V2Scripts } from "./fraction-vault-v2";
import type { TxIntent } from "./tx-intent-guard.shared";

/** The bits of the Lucid module the builders use (passed in, never imported). */
export interface LucidModTx {
  Data: { to: (v: unknown) => string };
  Constr: new (index: number, fields: unknown[]) => unknown;
  unixTimeToSlot: (network: never, unixTime: number) => number;
  slotToUnixTime: (network: never, slot: number) => number;
  getAddressDetails: (address: string) => {
    paymentCredential?: { type: "Key" | "Script"; hash: string };
    stakeCredential?: { type: "Key" | "Script"; hash: string };
  };
  credentialToAddress: (
    network: never,
    payment: { type: "Key" | "Script"; hash: string },
    stake?: { type: "Key" | "Script"; hash: string },
  ) => string;
}

export interface V2Context {
  lucid: LucidEvolution;
  mod: LucidModTx;
  scripts: V2Scripts;
  /** Reference-script UTxOs. A Settle batch needs them to fit the size limit. */
  refs?: { offering?: UTxO; pledge?: UTxO; fraction?: UTxO };
}

export interface Built {
  tx: TxSignBuilder;
  intent: TxIntent;
  /** The State this transaction leaves behind, if it spends the State. */
  next?: V2State;
}

const VOID = (mod: LucidModTx) => mod.Data.to(new mod.Constr(0, []));

/**
 * Lovelace rider on the State. Its datum is about 400 bytes, so the ledger's
 * min-ADA is above 3 ADA; 5 ADA leaves room for a larger committee. The rider
 * is fixed at opening and kept by every spend (F-6 `keeps_lovelace`).
 */
export const STATE_RIDER = 5_000_000n;
const v3 = (script: string) => ({ type: "PlutusV3" as const, script });

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

export interface LiveState {
  utxo: UTxO;
  state: V2State;
}

/**
 * The genuine State: the UTxO under the offering script carrying its thread
 * token (F-1). Refuses if none, or (impossibly) more than one, exists, or if
 * the datum is unreadable, or the State names a fraction policy other than
 * this offering's own (SPEC-v2 §11.1).
 */
export async function findState(ctx: V2Context): Promise<LiveState> {
  const { offering, fraction } = ctx.scripts;
  const utxos = await ctx.lucid.utxosAtWithUnit(
    { type: "Script", hash: offering.hash },
    offering.threadUnit,
  );
  const mine = utxos.filter((u) => (u.assets[offering.threadUnit] ?? 0n) === 1n);
  if (mine.length === 0) throw new V2Refused("This offering has not been opened on chain.");
  if (mine.length > 1) {
    throw new V2Refused("More than one UTxO claims this offering's thread token. Refusing.");
  }
  const utxo = mine[0]!;
  const state = readState(utxo.datum);
  if (!state) throw new V2Refused("The offering State's datum cannot be read.");
  if (state.terms.fractionPolicy.toLowerCase() !== fraction.policyId) {
    throw new V2Refused("This offering names a fraction policy other than its own. Do not use it.");
  }
  return { utxo, state };
}

export interface LivePledge {
  utxo: UTxO;
  pledge: V2Pledge;
  /** Carries the pledge marker: a genuine pledge. */
  marked: boolean;
}

/** Pledges for this offering at the shared pledge address. */
export async function findPledges(ctx: V2Context): Promise<LivePledge[]> {
  const { pledge, offering } = ctx.scripts;
  const utxos = await ctx.lucid.utxosAt({ type: "Script", hash: pledge.hash });
  const out: LivePledge[] = [];
  for (const utxo of utxos) {
    const p = readPledge(utxo.datum);
    if (!p || p.offering.toLowerCase() !== offering.hash) continue;
    out.push({ utxo, pledge: p, marked: (utxo.assets[pledge.markerUnit] ?? 0n) === 1n });
  }
  return out;
}

/** Ledger order of inputs: transaction id, then output index. */
export function ledgerOrder<T extends { txHash: string; outputIndex: number }>(xs: T[]): T[] {
  return [...xs].sort((a, b) =>
    a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// Values and addresses
// ---------------------------------------------------------------------------

function stateValue(ctx: V2Context, s: V2State, rider: bigint): Record<string, bigint> {
  const { scripts } = ctx;
  const units = accounted(s.book);
  const v: Record<string, bigint> = { [scripts.offering.threadUnit]: 1n };
  if (scripts.depositUnit === "lovelace") {
    v.lovelace = V2_MIN_RIDER + units;
  } else {
    v.lovelace = rider;
    if (units !== 0n) v[scripts.depositUnit] = units;
  }
  return v;
}

/** Deposit-unit payment as an asset map with a min-ADA rider. */
function unitPayment(ctx: V2Context, amount: bigint): Record<string, bigint> {
  return ctx.scripts.depositUnit === "lovelace"
    ? { lovelace: amount }
    : { lovelace: V2_MIN_RIDER, [ctx.scripts.depositUnit]: amount };
}

/** Plutus view of a bech32 key address. */
export function plutusAddressOf(mod: LucidModTx, bech32: string): PlutusAddress {
  const d = mod.getAddressDetails(bech32);
  if (!d.paymentCredential || d.paymentCredential.type !== "Key") {
    throw new V2Refused("Pledges and payouts go to key addresses only.");
  }
  const s = d.stakeCredential;
  return {
    payment: { type: "key", hash: d.paymentCredential.hash },
    stake: s ? { type: s.type === "Key" ? "key" : "script", hash: s.hash } : null,
  };
}

/** Bech32 of a Plutus address, on this context's network. */
export function bech32Of(ctx: V2Context, a: PlutusAddress): string {
  const cred = (c: { type: string; hash: string }) => ({
    type: (c.type === "key" ? "Key" : "Script") as "Key" | "Script",
    hash: c.hash,
  });
  return ctx.mod.credentialToAddress(
    ctx.scripts.network as never,
    cred(a.payment),
    a.stake ? cred(a.stake) : undefined,
  );
}

/** A POSIX-ms time rounded down to the start of its slot (what scripts see). */
export function slotAligned(ctx: V2Context, ms: number): number {
  const net = ctx.scripts.network as never;
  return ctx.mod.slotToUnixTime(net, ctx.mod.unixTimeToSlot(net, ms));
}

function withSpendScript(ctx: V2Context, b: TxBuilder, which: "offering" | "pledge"): TxBuilder {
  const ref = ctx.refs?.[which];
  return ref ? b.readFrom([ref]) : b.attach.SpendingValidator(v3(ctx.scripts[which].cbor));
}

function withMintScript(
  ctx: V2Context,
  b: TxBuilder,
  which: "pledge" | "fraction" | "offering",
): TxBuilder {
  const ref = ctx.refs?.[which];
  if (ref) return b.readFrom([ref]);
  const cbor = which === "fraction" ? ctx.scripts.fraction.cbor : ctx.scripts[which].cbor;
  return b.attach.MintingPolicy(v3(cbor));
}

function payState(ctx: V2Context, b: TxBuilder, live: LiveState, next: V2State): TxBuilder {
  return b.pay.ToContract(
    live.utxo.address,
    { kind: "inline", value: encodeState(ctx.mod, next) },
    stateValue(ctx, next, live.utxo.assets.lovelace ?? V2_MIN_RIDER),
  );
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Open an offering: consume `seedUtxo` (the one `ctx.scripts` was derived
 * with), mint the thread token and pay the empty `Raising` State. Needs the
 * issuer and the committee threshold as signers.
 */
export async function buildOpen(
  ctx: V2Context,
  seedUtxo: UTxO,
  state: V2State,
  signers: string[],
  nowMs: number,
  rider: bigint = STATE_RIDER,
): Promise<Built> {
  const { scripts, mod } = ctx;
  if (scripts.depositUnit === "lovelace") {
    // SPEC-v2 §11.9: an ADA-unit State must hold exactly 2 ADA plus its
    // balance, which at opening is below the ledger's min-ADA for its datum.
    throw new V2Refused(
      "v2 offerings take a native-token deposit unit (TSRA on Preprod), not ADA.",
    );
  }
  if (
    seedUtxo.txHash !== scripts.seed.txHash ||
    seedUtxo.outputIndex !== scripts.seed.outputIndex
  ) {
    throw new V2Refused("The seed UTxO is not the one these scripts were derived from.");
  }
  if (state.terms.fractionPolicy.toLowerCase() !== scripts.fraction.policyId) {
    throw new V2Refused("The State must name this offering's own fraction policy.");
  }
  if (
    state.terms.unitPolicy !== scripts.unit.policyId ||
    state.terms.unitName !== scripts.unit.assetNameHex
  ) {
    throw new V2Refused("The State's deposit unit must match the offering's unit.");
  }
  checkOpening(state, BigInt(nowMs));
  if (rider < V2_MIN_RIDER) throw new V2Refused("The State needs at least a 2 ADA rider.");
  const deadline = Number(state.terms.deadline);
  let b = ctx.lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [scripts.offering.threadUnit]: 1n }, VOID(mod));
  b = withMintScript(ctx, b, "offering");
  b = b.pay
    .ToContract(
      scripts.offering.address,
      { kind: "inline", value: encodeState(mod, state) },
      stateValue(ctx, state, rider),
    )
    .validFrom(nowMs)
    .validTo(Math.min(deadline, nowMs + 3_600_000));
  for (const k of signers) b = b.addSignerKey(k);
  const tx = await b.complete();
  return {
    tx,
    next: state,
    intent: {
      action: "offering_v2.open",
      pay: [scripts.offering.address],
      mint: { [scripts.offering.threadUnit]: 1n },
      spend: { lovelace: rider },
      extraSigners: signers,
    },
  };
}

// ---------------------------------------------------------------------------
// Pledge, cancel, refund (investor side)
// ---------------------------------------------------------------------------

/**
 * Pledge `qty` fractions for `ownerAddress`, depositing exactly `qty × price`.
 * The State is read as a reference input; the transaction must end by the
 * deadline and records its own (slot-aligned) start time as `created`.
 */
export async function buildPledge(
  ctx: V2Context,
  ownerAddress: string,
  qty: bigint,
  nowMs: number,
): Promise<Built> {
  const { scripts, mod } = ctx;
  const live = await findState(ctx);
  const s = live.state;
  if (s.status !== "raising") throw new V2Refused("This raise is not taking pledges.");
  if (qty <= 0n) throw new V2Refused("Pledge at least one fraction.");
  const left = s.terms.totalFractions - s.book.settled;
  if (qty > left) throw new V2Refused(`Only ${left} fractions are left in this raise.`);
  const from = slotAligned(ctx, nowMs);
  const deadline = Number(s.terms.deadline);
  if (from >= deadline) throw new V2Refused("The pledge deadline has passed.");
  const to = Math.min(deadline, from + 1_800_000);
  const cost = qty * s.terms.price;
  const datum: V2Pledge = {
    offering: scripts.offering.hash,
    owner: plutusAddressOf(mod, ownerAddress),
    qty,
    created: BigInt(from),
  };
  const value: Record<string, bigint> = {
    ...unitPayment(ctx, cost),
    [scripts.pledge.markerUnit]: 1n,
  };
  if (scripts.depositUnit === "lovelace") value.lovelace = V2_MIN_RIDER + cost;
  let b = ctx.lucid
    .newTx()
    .readFrom([live.utxo])
    .mintAssets({ [scripts.pledge.markerUnit]: 1n }, encodePledgeMint(mod, "mint"));
  b = withMintScript(ctx, b, "pledge");
  const tx = await b.pay
    .ToContract(scripts.pledge.address, { kind: "inline", value: encodePledge(mod, datum) }, value)
    .validFrom(from)
    .validTo(to)
    .complete();
  const spend =
    scripts.depositUnit === "lovelace"
      ? { lovelace: V2_MIN_RIDER + cost }
      : { lovelace: V2_MIN_RIDER, assets: { [scripts.depositUnit]: cost } };
  return {
    tx,
    intent: {
      action: "offering_v2.pledge",
      pay: [scripts.pledge.address],
      mint: { [scripts.pledge.markerUnit]: 1n },
      spend,
    },
  };
}

/** Payout to a pledge's owner, tagged with the pledge's output reference. */
function returnPayout(
  ctx: V2Context,
  p: LivePledge,
): { address: string; datum: string; value: Record<string, bigint> } {
  const value: Record<string, bigint> = {};
  for (const [u, q] of Object.entries(p.utxo.assets)) {
    if (u === ctx.scripts.pledge.markerUnit) continue;
    value[u] = q;
  }
  return {
    address: bech32Of(ctx, p.pledge.owner),
    datum: encodeOutRef(ctx.mod, p.utxo),
    value,
  };
}

/**
 * The owner cancels their own pledge while the raise is open and before the
 * deadline. Everything goes back to them.
 */
export async function buildCancelPledge(
  ctx: V2Context,
  p: LivePledge,
  nowMs: number,
): Promise<Built> {
  const live = await findState(ctx);
  if (!p.marked) throw new V2Refused("This is not a marked pledge; refund it instead.");
  if (live.state.status !== "raising")
    throw new V2Refused("The raise has ended; refund the pledge instead.");
  const deadline = Number(live.state.terms.deadline);
  if (nowMs >= deadline) throw new V2Refused("Pledges can be cancelled only before the deadline.");
  const owner = p.pledge.owner.payment.hash;
  const pay = returnPayout(ctx, p);
  let b = ctx.lucid
    .newTx()
    .readFrom([live.utxo])
    .collectFrom([p.utxo], encodePledgeAction(ctx.mod, { kind: "cancelPledge", outIx: 0 }));
  b = withSpendScript(ctx, b, "pledge");
  b = b.mintAssets({ [ctx.scripts.pledge.markerUnit]: -1n }, encodePledgeMint(ctx.mod, "burn"));
  b = withMintScript(ctx, b, "pledge");
  const tx = await b.pay
    .ToAddressWithData(pay.address, { kind: "inline", value: pay.datum }, pay.value)
    .addSignerKey(owner)
    .validFrom(slotAligned(ctx, nowMs))
    .validTo(Math.min(deadline, nowMs + 1_800_000))
    .complete();
  return {
    tx,
    intent: {
      action: "offering_v2.cancelPledge",
      pay: [pay.address],
      mint: { [ctx.scripts.pledge.markerUnit]: -1n },
    },
  };
}

/**
 * Anyone returns pledges to their owners: marked pledges once the raise is no
 * longer `Raising` (or the settle window has ended), unmarked UTxOs at any
 * time. Payout i goes to output i, tagged with its pledge.
 */
export async function buildRefundPledges(
  ctx: V2Context,
  pledges: LivePledge[],
  nowMs: number,
): Promise<Built> {
  if (pledges.length === 0) throw new V2Refused("Choose at least one pledge to refund.");
  const marked = pledges.filter((p) => p.marked);
  let live: LiveState | null = null;
  if (marked.length > 0) {
    live = await findState(ctx);
    const t = live.state.terms;
    const windowOver = BigInt(slotAligned(ctx, nowMs)) > t.deadline + t.settleWindow;
    if (live.state.status === "raising" && !windowOver) {
      throw new V2Refused("The raise is still open; only the owner can cancel a pledge now.");
    }
  }
  let b = ctx.lucid.newTx();
  if (live) b = b.readFrom([live.utxo]);
  const payees: string[] = [];
  pledges.forEach((p, i) => {
    b = b.collectFrom([p.utxo], encodePledgeAction(ctx.mod, { kind: "refundPledge", outIx: i }));
  });
  b = withSpendScript(ctx, b, "pledge");
  if (marked.length > 0) {
    b = b.mintAssets(
      { [ctx.scripts.pledge.markerUnit]: -BigInt(marked.length) },
      encodePledgeMint(ctx.mod, "burn"),
    );
    b = withMintScript(ctx, b, "pledge");
  }
  for (const p of pledges) {
    const pay = returnPayout(ctx, p);
    payees.push(pay.address);
    b = b.pay.ToAddressWithData(pay.address, { kind: "inline", value: pay.datum }, pay.value);
  }
  const tx = await b
    .validFrom(slotAligned(ctx, nowMs))
    .validTo(nowMs + 1_800_000)
    .complete();
  return {
    tx,
    intent: {
      action: "offering_v2.refundPledges",
      pay: [...new Set(payees)],
      mint: marked.length ? { [ctx.scripts.pledge.markerUnit]: -BigInt(marked.length) } : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Settle (keeper)
// ---------------------------------------------------------------------------

/**
 * Settle up to KEEPER_BATCH marked pledges: they are spent in ledger order,
 * the State (output 0) books them, and output i+1 pays pledge i's owner its
 * fractions and rider. `signers` are the keeper key, or committee keys.
 */
export async function buildSettle(
  ctx: V2Context,
  pledges: LivePledge[],
  signers: string[],
  nowMs: number,
  eligibilityRefs: UTxO[] = [],
): Promise<Built> {
  const { scripts, mod } = ctx;
  if (pledges.length > KEEPER_BATCH) {
    throw new V2Refused(`Settle at most ${KEEPER_BATCH} pledges per transaction.`);
  }
  if (pledges.some((p) => !p.marked)) throw new V2Refused("Only marked pledges can be settled.");
  const live = await findState(ctx);
  const s = live.state;
  const end = s.terms.deadline + s.terms.settleWindow;
  if (BigInt(nowMs) >= end) throw new V2Refused("The settle window has ended.");
  const ordered = ledgerOrder(
    pledges.map((p) => ({ ...p, txHash: p.utxo.txHash, outputIndex: p.utxo.outputIndex })),
  );
  const next = settledState(
    s,
    ordered.map((p) => p.pledge.qty),
  );
  const q = ordered.reduce((a, p) => a + p.pledge.qty, 0n);

  let b = ctx.lucid
    .newTx()
    .collectFrom([live.utxo], encodeOfferingAction(mod, { kind: "settle" }))
    .collectFrom(
      ordered.map((p) => p.utxo),
      encodePledgeAction(mod, { kind: "settlePledge" }),
    );
  b = withSpendScript(ctx, b, "offering");
  b = withSpendScript(ctx, b, "pledge");
  b = b
    .mintAssets({ [scripts.fraction.unit]: q }, VOID(mod))
    .mintAssets(
      { [scripts.pledge.markerUnit]: -BigInt(ordered.length) },
      encodePledgeMint(mod, "burn"),
    );
  b = withMintScript(ctx, b, "fraction");
  b = withMintScript(ctx, b, "pledge");
  if (eligibilityRefs.length) b = b.readFrom(eligibilityRefs);
  b = payState(ctx, b, live, next);
  const payees: string[] = [];
  for (const p of ordered) {
    const to = bech32Of(ctx, p.pledge.owner);
    payees.push(to);
    const rider =
      scripts.depositUnit === "lovelace" ? V2_MIN_RIDER : (p.utxo.assets.lovelace ?? V2_MIN_RIDER);
    b = b.pay.ToAddress(to, { lovelace: rider, [scripts.fraction.unit]: p.pledge.qty });
  }
  for (const k of signers) b = b.addSignerKey(k);
  const tx = await b
    .validFrom(slotAligned(ctx, nowMs))
    .validTo(Math.min(Number(end), nowMs + 1_800_000))
    .complete();
  return {
    tx,
    next,
    intent: {
      action: "offering_v2.settle",
      pay: [live.utxo.address, ...new Set(payees)],
      mint: { [scripts.fraction.unit]: q, [scripts.pledge.markerUnit]: -BigInt(ordered.length) },
      extraSigners: signers,
    },
  };
}

// ---------------------------------------------------------------------------
// Every other State action
// ---------------------------------------------------------------------------

export interface ActionOptions {
  /** Keys that will sign (committee members for committee actions). */
  signers?: string[];
  /** Where a payout goes: the SPV for Release, the treasury for ClaimFee, the holder otherwise. */
  payTo?: string;
  nowMs: number;
}

const COMMITTEE: ReadonlySet<OfferingAction["kind"]> = new Set([
  "closeRaise",
  "cancelRaise",
  "release",
  "commitPeriod",
  "setFees",
  "claimFee",
  "rotate",
  "beginWindDown",
]);

/**
 * Build any State action other than Settle. Payouts (Release, ClaimFee,
 * RefundFraction, Redeem) go to `opts.payTo`; BeginWindDown takes the final
 * pool from the signing wallet.
 */
export async function buildAction(
  ctx: V2Context,
  action: OfferingAction,
  opts: ActionOptions,
): Promise<Built> {
  const { scripts, mod } = ctx;
  if (action.kind === "settle") throw new V2Refused("Use buildSettle for Settle.");
  const live = await findState(ctx);
  const s = live.state;
  const from = slotAligned(ctx, opts.nowMs);
  const next = nextState(s, action, BigInt(from));
  const signers = opts.signers ?? [];
  if (COMMITTEE.has(action.kind)) {
    const distinct = new Set(signers.filter((k) => s.committee.includes(k.toLowerCase())));
    if (distinct.size < s.threshold) {
      throw new V2Refused(
        `This needs ${s.threshold} committee signatures; ${distinct.size} are lined up.`,
      );
    }
  }

  let b = ctx.lucid.newTx().collectFrom([live.utxo], encodeOfferingAction(mod, action));
  b = withSpendScript(ctx, b, "offering");
  b = payState(ctx, b, live, next);

  const pay: string[] = [live.utxo.address];
  let mint: Record<string, bigint> | undefined;
  const outflow = accounted(s.book) - accounted(next.book);

  const payout = (amount: bigint) => {
    if (!opts.payTo) throw new V2Refused("Say where the payout goes.");
    pay.push(opts.payTo);
    b = b.pay.ToAddress(opts.payTo, unitPayment(ctx, amount));
  };

  switch (action.kind) {
    case "release": {
      if (!opts.payTo) throw new V2Refused("Give the SPV payout address.");
      const d = mod.getAddressDetails(opts.payTo).paymentCredential;
      const want = s.terms.spvPayout;
      if (!d || d.hash !== want.hash || (d.type === "Key") !== (want.type === "key")) {
        throw new V2Refused("That address is not the SPV payout this offering is bound to.");
      }
      payout(action.amount);
      break;
    }
    case "claimFee": {
      if (!opts.payTo) throw new V2Refused("Give the treasury address.");
      const d = mod.getAddressDetails(opts.payTo).paymentCredential;
      if (!d || d.type !== "Key" || d.hash !== s.terms.treasury) {
        throw new V2Refused("That address is not this offering's treasury.");
      }
      payout(action.amount);
      break;
    }
    case "refundFraction":
    case "redeem": {
      const burn = -action.qty;
      mint = { [scripts.fraction.unit]: burn };
      b = b.mintAssets(mint, VOID(mod));
      b = withMintScript(ctx, b, "fraction");
      if (outflow > 0n) payout(outflow);
      break;
    }
    default:
      break;
  }
  for (const k of signers) b = b.addSignerKey(k);
  b = b.validFrom(from).validTo(opts.nowMs + 1_800_000);
  const tx = await b.complete();

  // What may leave the signing wallet besides the fee: the final pool it pays
  // in, the fractions it burns, or the min-ADA rider that travels with a
  // token payout to the SPV or the treasury.
  const spend =
    action.kind === "beginWindDown" && action.finalPool > 0n
      ? { assets: { [scripts.depositUnit]: action.finalPool } }
      : action.kind === "refundFraction" || action.kind === "redeem"
        ? { assets: { [scripts.fraction.unit]: action.qty } }
        : action.kind === "release" || action.kind === "claimFee"
          ? { lovelace: V2_MIN_RIDER }
          : undefined;
  return {
    tx,
    next,
    intent: {
      action: `offering_v2.${action.kind}`,
      pay: [...new Set(pay)],
      mint,
      spend,
      extraSigners: signers,
    },
  };
}

/**
 * Publish the three scripts as reference scripts at `home` (one output each).
 * Returns the transaction; the caller records the three output references.
 */
export async function buildPublishRefs(ctx: V2Context, home: string): Promise<Built> {
  const { scripts } = ctx;
  const tx = await ctx.lucid
    .newTx()
    .pay.ToAddressWithData(home, undefined, { lovelace: 40_000_000n }, v3(scripts.offering.cbor))
    .pay.ToAddressWithData(home, undefined, { lovelace: 25_000_000n }, v3(scripts.pledge.cbor))
    .pay.ToAddressWithData(home, undefined, { lovelace: 10_000_000n }, v3(scripts.fraction.cbor))
    .complete();
  return {
    tx,
    intent: {
      action: "offering_v2.publishRefs",
      pay: [home],
      spend: { lovelace: 75_000_000n },
      allowScriptRefs: true,
    },
  };
}
