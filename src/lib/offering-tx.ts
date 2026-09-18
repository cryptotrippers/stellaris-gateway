/**
 * Fractional ownership — the on-chain paths.
 *
 * One offering UTxO holds the counters and the money; ownership itself lives
 * in the buyer's own wallet as a native token. Everything here builds a
 * transaction the validator in `contracts/fraction-vault/` will accept, and
 * refuses early — with a readable reason — when it cannot.
 *
 * Browser-only: Lucid is dynamically imported and a CIP-30 wallet on the app's
 * network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import {
  deriveOffering,
  getOfferingScripts,
  lucidUnitOf,
  type AppliedOffering,
  type DepositUnit,
} from "./fraction-vault";
import {
  MAX_OFFERING_FEE_BPS,
  MIN_RIDER_LOVELACE,
  encodeOfferingDatum,
  quoteBuy,
  quoteRedeem,
  readOfferingDatum,
  statusIndex,
  type OfferingDatum,
  type OfferingStatus,
} from "./offering-chain";

/** FractionRedeemer constructor indices — mirrors fraction_vault.ak. */
const R_BUY = 0;
const R_REDEEM = 1;
const R_DISTRIBUTE = 2;
const R_SET_STATUS = 3;
const R_SET_FEES = 4;
const R_CLAIM_FEE = 5;

const HEX28 = /^[0-9a-f]{56}$/;

type LucidBits = Awaited<ReturnType<typeof initLucidWithWallet>>;

interface Session {
  lucid: LucidBits["lucid"];
  lucidMod: LucidBits["lucidMod"];
  scripts: AppliedOffering;
  walletAddress: string;
  selfHash: string;
}

async function connect(
  assetId: string,
  unit: DepositUnit,
  registryAddress?: string | null,
): Promise<Session> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  const { lucid, lucidMod } = await initLucidWithWallet();
  const scripts = getOfferingScripts(lucidMod, assetId, unit);
  if (registryAddress && registryAddress !== scripts.address) {
    throw new Error(
      `This build derives a different offering address than the one on record. ` +
        `Recorded ${registryAddress.slice(0, 24)}…, derived ${scripts.address.slice(0, 24)}…. ` +
        `Do not sign — the contracts were rebuilt without re-registering the offering.`,
    );
  }
  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  return { lucid, lucidMod, scripts, walletAddress, selfHash: cred.hash };
}

type LucidUtxo = { txHash: string; outputIndex: number; datum?: string | null; assets: Record<string, bigint> };

export interface OfferingView {
  address: string;
  policyId: string;
  fractionUnit: string;
  datum: OfferingDatum;
  /** Units the script UTxO actually holds in the deposit denomination. */
  held: bigint;
  lovelace: bigint;
  /** Fractions the connected wallet holds in its own balance. */
  myFractions: bigint;
}

function unitHeld(utxo: LucidUtxo, unitKey: string): bigint {
  return (utxo.assets[unitKey] as bigint | undefined) ?? 0n;
}

async function resolveOffering(
  session: Session,
): Promise<{ utxo: LucidUtxo; datum: OfferingDatum; held: bigint; lovelace: bigint }> {
  const utxos = (await session.lucid.utxosAt(session.scripts.address)) as unknown as LucidUtxo[];
  const found = utxos
    .map((u) => ({ utxo: u, datum: readOfferingDatum(u.datum ?? null) }))
    .filter((c): c is { utxo: LucidUtxo; datum: OfferingDatum } => c.datum !== null);

  if (found.length === 0) {
    throw new Error("This offering has not been opened on chain yet.");
  }
  if (found.length > 1) {
    // The validator spends exactly one state per transaction, so a second one
    // is unspendable noise; refuse rather than guess which is the live ledger.
    throw new Error(
      "More than one offering state was found at this address. An operator must resolve it before anyone transacts.",
    );
  }
  const chosen = found[0]!;
  const unitKey = lucidUnitOf(session.scripts.unit);
  return {
    utxo: chosen.utxo,
    datum: chosen.datum,
    held: unitHeld(chosen.utxo, unitKey),
    lovelace: unitHeld(chosen.utxo, "lovelace"),
  };
}

/** Read an offering and the connected wallet's holding of its fractions. */
export async function loadOffering(
  assetId: string,
  unit: DepositUnit,
  registryAddress?: string | null,
): Promise<OfferingView> {
  const session = await connect(assetId, unit, registryAddress);
  const { datum, held, lovelace } = await resolveOffering(session);
  const wallet = await session.lucid.wallet().getUtxos();
  const myFractions = (wallet as unknown as LucidUtxo[]).reduce(
    (acc, u) => acc + unitHeld(u, session.scripts.fractionUnit),
    0n,
  );
  return {
    address: session.scripts.address,
    policyId: session.scripts.policyId,
    fractionUnit: session.scripts.fractionUnit,
    datum,
    held,
    lovelace,
    myFractions,
  };
}

/** Read an offering without a wallet connected is not possible — Lucid needs
 *  one to query — so chain reads for public pages go through Blockfrost in
 *  `offering-read.functions.ts` instead. */

function dataMod(lucidMod: Session["lucidMod"]) {
  return lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
}

/** Value map for the script output: the rider in lovelace plus the unit. */
function scriptValue(unit: DepositUnit, lovelace: bigint, unitAmount: bigint) {
  if (unit.policyId === "") return { lovelace: unitAmount };
  return { lovelace, [lucidUnitOf(unit)]: unitAmount };
}

// ---------------------------------------------------------------------------
// Open an offering
// ---------------------------------------------------------------------------

export interface OpenOfferingParams {
  assetId: string;
  unit: DepositUnit;
  totalFractions: bigint;
  /** Price of one fraction, in base units of the denomination. */
  price: bigint;
  operators: string[];
  threshold: number;
  issuerPkh: string;
  treasuryPkh: string;
  mintFeeBps?: number;
  redeemFeeBps?: number;
  /** Lovelace rider placed on the offering UTxO. */
  riderLovelace?: bigint;
}

export interface OpenOfferingResult {
  txHash: string;
  address: string;
  scriptHash: string;
  policyId: string;
  fractionUnit: string;
  assetNameHex: string;
  datum: OfferingDatum;
}

/**
 * Create the offering's one and only state UTxO. No script runs here — this
 * is an ordinary payment into the script address — so everything the offering
 * will forever be bound by is decided in this transaction.
 */
export async function openOffering(params: OpenOfferingParams): Promise<OpenOfferingResult> {
  const operators = params.operators.map((o) => o.trim().toLowerCase());
  if (operators.length === 0) throw new Error("Add at least one operator key hash.");
  const badOperator = operators.find((o) => !HEX28.test(o));
  if (badOperator) {
    throw new Error(`"${badOperator.slice(0, 16)}…" is not a 28-byte payment key hash.`);
  }
  if (new Set(operators).size !== operators.length) {
    throw new Error("The committee lists the same operator twice.");
  }
  if (params.threshold < 1 || params.threshold > operators.length) {
    throw new Error("The signature threshold must be between 1 and the number of operators.");
  }
  const issuer = params.issuerPkh.trim().toLowerCase();
  const treasury = params.treasuryPkh.trim().toLowerCase();
  if (!HEX28.test(issuer)) throw new Error("The issuer key hash must be 56 hex characters.");
  if (!HEX28.test(treasury)) throw new Error("The treasury key hash must be 56 hex characters.");
  if (params.totalFractions <= 0n) throw new Error("An offering needs at least one fraction.");
  if (params.price <= 0n) throw new Error("Set a price above zero for one fraction.");
  const mintFeeBps = params.mintFeeBps ?? 0;
  const redeemFeeBps = params.redeemFeeBps ?? 0;
  for (const bps of [mintFeeBps, redeemFeeBps]) {
    if (bps < 0 || bps > MAX_OFFERING_FEE_BPS) {
      throw new Error(`Fees are capped at ${MAX_OFFERING_FEE_BPS / 100}%.`);
    }
  }

  const session = await connect(params.assetId, params.unit);
  const existing = (await session.lucid.utxosAt(session.scripts.address)) as unknown as LucidUtxo[];
  if (existing.some((u) => readOfferingDatum(u.datum ?? null))) {
    throw new Error("This offering already exists on chain — it cannot be opened twice.");
  }

  const rider = params.riderLovelace ?? MIN_RIDER_LOVELACE;
  if (rider < MIN_RIDER_LOVELACE) {
    throw new Error(`The offering UTxO needs at least ${Number(MIN_RIDER_LOVELACE) / 1e6} ADA.`);
  }

  const datum: OfferingDatum = {
    totalFractions: params.totalFractions.toString(),
    minted: "0",
    outstanding: "0",
    price: params.price.toString(),
    pool: "0",
    fees: "0",
    issuer,
    treasury,
    operators,
    threshold: params.threshold,
    status: "open",
    mintFeeBps,
    redeemFeeBps,
    fractionPolicy: session.scripts.policyId,
  };

  const completed = await session.lucid
    .newTx()
    .pay.ToContract(
      session.scripts.address,
      { kind: "inline", value: encodeOfferingDatum(session.lucidMod, datum) },
      // Pool and fees both start at zero, so the UTxO holds only the rider.
      scriptValue(params.unit, rider, params.unit.policyId === "" ? rider : 0n),
    )
    .complete();
  const txHash = await (await completed.sign.withWallet().complete()).submit();

  return {
    txHash,
    address: session.scripts.address,
    scriptHash: session.scripts.scriptHash,
    policyId: session.scripts.policyId,
    fractionUnit: session.scripts.fractionUnit,
    assetNameHex: session.scripts.assetNameHex,
    datum,
  };
}

// ---------------------------------------------------------------------------
// Buy fractions
// ---------------------------------------------------------------------------

export interface BuyResult {
  txHash: string;
  address: string;
  fractionUnit: string;
  /** Fractions minted straight into the buyer's wallet. */
  fractions: string;
  cost: string;
  fee: string;
  toPool: string;
}

/** Buy `qty` whole fractions, minting them into the connected wallet. */
export async function buyFractions(params: {
  assetId: string;
  unit: DepositUnit;
  qty: bigint;
  registryAddress?: string | null;
}): Promise<BuyResult> {
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);

  if (datum.status !== "open") {
    throw new Error("This offering is closed — fractions are no longer being sold.");
  }
  if (params.qty <= 0n) throw new Error("Enter how many fractions to buy.");
  const remaining = BigInt(datum.totalFractions) - BigInt(datum.minted);
  if (params.qty > remaining) {
    throw new Error(`Only ${remaining.toString()} fractions are left in this offering.`);
  }
  const quote = quoteBuy(datum, params.qty);
  if (quote.cost <= 0n) throw new Error("That purchase comes to nothing — check the quantity.");

  const next: OfferingDatum = {
    ...datum,
    minted: (BigInt(datum.minted) + params.qty).toString(),
    outstanding: (BigInt(datum.outstanding) + params.qty).toString(),
    pool: (BigInt(datum.pool) + quote.toPool).toString(),
    fees: (BigInt(datum.fees) + quote.fee).toString(),
  };

  const { Data, Constr } = dataMod(session.lucidMod);
  const completed = await session.lucid
    .newTx()
    .collectFrom([utxo as never], Data.to(new Constr(R_BUY, [params.qty])))
    .attach.SpendingValidator({ type: "PlutusV3", script: session.scripts.cbor })
    // The fractions land in the buyer's wallet as change — an ordinary
    // Cardano native token they can send or sell without this contract.
    .mintAssets({ [session.scripts.fractionUnit]: params.qty }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy({ type: "PlutusV3", script: session.scripts.policyCbor })
    .pay.ToContract(
      session.scripts.address,
      { kind: "inline", value: encodeOfferingDatum(session.lucidMod, next) },
      scriptValue(params.unit, lovelace, held + quote.cost),
    )
    .complete();

  const txHash = await (await completed.sign.withWallet().complete()).submit();
  return {
    txHash,
    address: session.scripts.address,
    fractionUnit: session.scripts.fractionUnit,
    fractions: params.qty.toString(),
    cost: quote.cost.toString(),
    fee: quote.fee.toString(),
    toPool: quote.toPool.toString(),
  };
}

// ---------------------------------------------------------------------------
// Redeem fractions
// ---------------------------------------------------------------------------

export interface RedeemResult {
  txHash: string;
  burned: string;
  gross: string;
  fee: string;
  paid: string;
}

/** Burn `qty` fractions and take the pro-rata slice of the pool. */
export async function redeemFractions(params: {
  assetId: string;
  unit: DepositUnit;
  qty: bigint;
  registryAddress?: string | null;
}): Promise<RedeemResult> {
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);

  if (datum.status !== "redeeming") {
    throw new Error(
      "This offering is not in redemption. Fractions can be sold or transferred at any time, but burning them for a payout only opens when the committee moves the offering into redemption.",
    );
  }
  if (params.qty <= 0n) throw new Error("Enter how many fractions to redeem.");
  if (params.qty > BigInt(datum.outstanding)) {
    throw new Error("That is more fractions than are in circulation.");
  }
  const quote = quoteRedeem(datum, params.qty);
  if (quote.gross <= 0n) throw new Error("There is nothing in the pool to redeem against yet.");
  if (quote.net <= 0n) throw new Error("After the redemption fee this pays out nothing.");

  const nextHeld = held - quote.net;
  if (params.unit.policyId === "" && nextHeld < MIN_RIDER_LOVELACE) {
    throw new Error("This redemption would leave the offering below its min-ADA floor.");
  }

  const next: OfferingDatum = {
    ...datum,
    outstanding: (BigInt(datum.outstanding) - params.qty).toString(),
    pool: (BigInt(datum.pool) - quote.gross).toString(),
    fees: (BigInt(datum.fees) + quote.fee).toString(),
  };

  const { Data, Constr } = dataMod(session.lucidMod);
  const completed = await session.lucid
    .newTx()
    .collectFrom([utxo as never], Data.to(new Constr(R_REDEEM, [params.qty])))
    .attach.SpendingValidator({ type: "PlutusV3", script: session.scripts.cbor })
    .mintAssets({ [session.scripts.fractionUnit]: -params.qty }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy({ type: "PlutusV3", script: session.scripts.policyCbor })
    .pay.ToContract(
      session.scripts.address,
      { kind: "inline", value: encodeOfferingDatum(session.lucidMod, next) },
      scriptValue(params.unit, lovelace, nextHeld),
    )
    .complete();

  const txHash = await (await completed.sign.withWallet().complete()).submit();
  return {
    txHash,
    burned: params.qty.toString(),
    gross: quote.gross.toString(),
    fee: quote.fee.toString(),
    paid: quote.net.toString(),
  };
}

// ---------------------------------------------------------------------------
// Distribute income
// ---------------------------------------------------------------------------

/** Pay income into the offering; every holder's claim rises pro rata. */
export async function distributeIncome(params: {
  assetId: string;
  unit: DepositUnit;
  amount: bigint;
  registryAddress?: string | null;
}): Promise<{ txHash: string; amount: string }> {
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);

  if (params.amount <= 0n) throw new Error("Enter an amount to distribute.");
  if (BigInt(datum.outstanding) <= 0n) {
    throw new Error("No fractions are outstanding, so there is nobody to distribute to yet.");
  }

  const next: OfferingDatum = {
    ...datum,
    pool: (BigInt(datum.pool) + params.amount).toString(),
  };

  const { Data, Constr } = dataMod(session.lucidMod);
  const completed = await session.lucid
    .newTx()
    .collectFrom([utxo as never], Data.to(new Constr(R_DISTRIBUTE, [params.amount])))
    .attach.SpendingValidator({ type: "PlutusV3", script: session.scripts.cbor })
    .pay.ToContract(
      session.scripts.address,
      { kind: "inline", value: encodeOfferingDatum(session.lucidMod, next) },
      scriptValue(params.unit, lovelace, held + params.amount),
    )
    .complete();
  const txHash = await (await completed.sign.withWallet().complete()).submit();
  return { txHash, amount: params.amount.toString() };
}

// ---------------------------------------------------------------------------
// Committee actions
// ---------------------------------------------------------------------------

async function committeeTx(
  session: Session,
  utxo: LucidUtxo,
  datum: OfferingDatum,
  redeemer: string,
  next: OfferingDatum,
  value: Record<string, bigint>,
  extraOutputs?: (b: unknown) => unknown,
): Promise<string> {
  let builder = session.lucid
    .newTx()
    .collectFrom([utxo as never], redeemer)
    .attach.SpendingValidator({ type: "PlutusV3", script: session.scripts.cbor })
    .pay.ToContract(
      session.scripts.address,
      { kind: "inline", value: encodeOfferingDatum(session.lucidMod, next) },
      value,
    );
  if (extraOutputs) builder = extraOutputs(builder) as typeof builder;
  for (const op of datum.operators) builder = builder.addSignerKey(op);
  const completed = await builder.complete();
  return (await completed.sign.withWallet().complete()).submit();
}

/** Move the offering's lifecycle: open -> closed -> redeeming. */
export async function setOfferingStatus(params: {
  assetId: string;
  unit: DepositUnit;
  status: OfferingStatus;
  registryAddress?: string | null;
}): Promise<{ txHash: string; status: OfferingStatus }> {
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);
  if (datum.status === params.status) {
    throw new Error(`This offering is already ${params.status}.`);
  }
  const { Data, Constr } = dataMod(session.lucidMod);
  const txHash = await committeeTx(
    session,
    utxo,
    datum,
    Data.to(new Constr(R_SET_STATUS, [new Constr(statusIndex(params.status), [])])),
    { ...datum, status: params.status },
    scriptValue(params.unit, lovelace, held),
  );
  return { txHash, status: params.status };
}

/** Change the purchase and redemption fee rates, within the hard caps. */
export async function setOfferingFees(params: {
  assetId: string;
  unit: DepositUnit;
  mintFeeBps: number;
  redeemFeeBps: number;
  registryAddress?: string | null;
}): Promise<{ txHash: string }> {
  for (const bps of [params.mintFeeBps, params.redeemFeeBps]) {
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_OFFERING_FEE_BPS) {
      throw new Error(`Fees must be whole basis points between 0 and ${MAX_OFFERING_FEE_BPS}.`);
    }
  }
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);
  if (datum.mintFeeBps === params.mintFeeBps && datum.redeemFeeBps === params.redeemFeeBps) {
    throw new Error("Those are already the current rates.");
  }
  const { Data, Constr } = dataMod(session.lucidMod);
  const txHash = await committeeTx(
    session,
    utxo,
    datum,
    Data.to(
      new Constr(R_SET_FEES, [BigInt(params.mintFeeBps), BigInt(params.redeemFeeBps)]),
    ),
    { ...datum, mintFeeBps: params.mintFeeBps, redeemFeeBps: params.redeemFeeBps },
    scriptValue(params.unit, lovelace, held),
  );
  return { txHash };
}

/** Pay accrued platform fees out to the offering's treasury key hash. */
export async function claimOfferingFees(params: {
  assetId: string;
  unit: DepositUnit;
  /** Leave undefined to claim everything accrued. */
  amount?: bigint;
  /** Treasury address to pay; its payment key hash must match the datum. */
  treasuryAddress: string;
  registryAddress?: string | null;
}): Promise<{ txHash: string; amount: string }> {
  const session = await connect(params.assetId, params.unit, params.registryAddress);
  const { utxo, datum, held, lovelace } = await resolveOffering(session);

  const accrued = BigInt(datum.fees);
  const amount = params.amount ?? accrued;
  if (amount <= 0n) throw new Error("No fees have accrued yet.");
  if (amount > accrued) throw new Error("That is more than the offering has accrued.");

  const cred = session.lucidMod.paymentCredentialOf(params.treasuryAddress);
  if (cred.type !== "Key" || cred.hash.toLowerCase() !== datum.treasury) {
    throw new Error("That address is not the treasury this offering pays out to.");
  }

  const nextHeld = held - amount;
  if (params.unit.policyId === "" && nextHeld < MIN_RIDER_LOVELACE) {
    throw new Error("Claiming that much would leave the offering below its min-ADA floor.");
  }

  const { Data, Constr } = dataMod(session.lucidMod);
  const payout =
    params.unit.policyId === ""
      ? { lovelace: amount }
      : { lovelace: MIN_RIDER_LOVELACE, [lucidUnitOf(params.unit)]: amount };

  const txHash = await committeeTx(
    session,
    utxo,
    datum,
    Data.to(new Constr(R_CLAIM_FEE, [amount])),
    { ...datum, fees: (accrued - amount).toString() },
    scriptValue(params.unit, lovelace, nextHeld),
    (b) => (b as { pay: { ToAddress: (a: string, v: unknown) => unknown } }).pay.ToAddress(
      params.treasuryAddress,
      payout,
    ),
  );
  return { txHash, amount: amount.toString() };
}

export { deriveOffering };
