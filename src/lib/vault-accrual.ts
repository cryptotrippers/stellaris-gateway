/**
 * Stage 4 — Step 2: the accrual transaction builder.
 *
 * An accrual is the only way a share price ever moves. It spends the vault's
 * single State UTxO, adds real lovelace to it, bumps the epoch, leaves the
 * share supply untouched, and must carry M-of-N operator signatures. The
 * validator enforces every one of those rules; this module just builds a
 * transaction that satisfies them and collects the signatures.
 *
 * Browser-only: Lucid is dynamically imported, and a CIP-30 wallet on the
 * app's network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { assertYieldVaultAddress, getYieldVaultScript, YIELD_VAULT_VERSION } from "./yield-vault";
import { getRefInputIfPublished } from "./ref-scripts";
import { encodeStateDatum, readStateDatum, type VaultStateDatum } from "./yield-chain-decode";
import { settleFee } from "./vault-fees";

/** YieldRedeemer constructor indices — mirrors yield_vault.ak. */
const REDEEMER_ACCRUE = 2;

export interface AccrualDraft {
  /** Unsigned (or partially signed) transaction CBOR. */
  txCbor: string;
  /** Witnesses gathered so far, keyed by the operator key hash that made them. */
  witnesses: Array<{ keyHash: string; witness: string }>;
  assetId: string;
  address: string;
  amountLovelace: string;
  epochBefore: number;
  epochAfter: number;
  totalAssetsBefore: string;
  totalAssetsAfter: string;
  totalShares: string;
  sharePriceBefore: number;
  sharePriceAfter: number;
  /** Operators whose signatures the transaction requires. */
  requiredSigners: string[];
  threshold: number;
  committee: string[];
  /** Management fee settled by this accrual, in basis points per year. */
  feeBps: number;
  /** Lovelace of management fee owed at settlement time. */
  feeAssets: string;
  /** Shares minted to the treasury to settle that fee. */
  feeSharesMinted: string;
  /** Total share supply after the fee mint. */
  totalSharesAfter: string;
  /** POSIX ms the fee clock is advanced to; also the tx validity lower bound. */
  settledAt: number;
}

function price(assets: bigint, shares: bigint): number {
  if (shares <= 0n) return 1;
  return Number(assets) / Number(shares);
}

/**
 * Build the accrual transaction and partially sign it with the connected
 * wallet. `signers` is the operator set that will sign; it must contain at
 * least `threshold` committee members, because the validator counts
 * `extra_signatories` and the transaction is invalid without all of them.
 */
export async function buildAccrual(params: {
  assetId: string;
  amountLovelace: bigint;
  /** Operator key hashes that will sign. Defaults to the connected wallet. */
  signers?: string[];
  /** Registry's recorded vault address, if known. Verified against the script this build derives. */
  registryAddress?: string | null;
}): Promise<AccrualDraft> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  if (params.amountLovelace <= 0n) throw new Error("The accrual amount must be positive.");

  const { lucid, lucidMod } = await initLucidWithWallet();
  const script = getYieldVaultScript(lucidMod, params.assetId);
  assertYieldVaultAddress(script, params.registryAddress);

  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  const selfHash = cred.hash;

  // --- locate the live State UTxO ---------------------------------------
  // A vault bootstrapped twice leaves a second, never-used State at the same
  // address; the validator only ever spends one State per tx, so pick the live
  // ledger deterministically (same rule every reader/builder uses).
  const utxos = await lucid.utxosAt(script.address);
  const candidates: Array<{ utxo: (typeof utxos)[number]; state: VaultStateDatum }> = [];
  for (const u of utxos) {
    const decoded = readStateDatum(u.datum ?? null);
    if (decoded) candidates.push({ utxo: u, state: decoded });
  }
  const chosen = selectCanonicalState(candidates, (c) => ({
    txHash: c.utxo.txHash,
    outputIndex: c.utxo.outputIndex,
    state: c.state,
  }));
  const stateUtxo = chosen?.utxo ?? null;
  const state = chosen?.state ?? null;
  if (!stateUtxo || !state) {
    throw new Error("This vault has no state UTxO yet — bootstrap it before accruing yield.");
  }

  if (state.paused) throw new Error("The vault is paused; unpause it before accruing yield.");

  const committee = state.operators.map((o) => o.toLowerCase());
  const signers = (params.signers?.length ? params.signers : [selfHash]).map((s) =>
    s.trim().toLowerCase(),
  );
  const outsiders = signers.filter((s) => !committee.includes(s));
  if (outsiders.length > 0) {
    throw new Error(`${outsiders[0]!.slice(0, 12)}… is not on this vault's operator committee.`);
  }
  if (new Set(signers).size < state.threshold) {
    throw new Error(
      `This vault needs ${state.threshold} operator signature(s); ${new Set(signers).size} selected.`,
    );
  }
  if (!signers.includes(selfHash)) {
    throw new Error("The connected wallet must be one of the signing operators.");
  }

  // --- fee settlement ----------------------------------------------------
  // The validator anchors fee proration to the transaction's validity lower
  // bound, so we choose that instant explicitly. It is aligned to a whole
  // second (slots are one second on Cardano, so the on-chain POSIX time round
  // trips exactly) and set slightly in the past so the tx is valid on arrival.
  const settledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  const lastFeeTime = BigInt(state.lastFeeTime);
  if (BigInt(settledAt) < lastFeeTime) {
    throw new Error(
      "This vault's fee clock is ahead of the current time; wait a moment and rebuild the accrual.",
    );
  }
  const fee = settleFee(state, BigInt(settledAt));

  // --- next state --------------------------------------------------------
  const totalAssetsBefore = BigInt(state.totalAssets);
  const totalShares = BigInt(state.totalShares);
  const totalAssetsAfter = totalAssetsBefore + params.amountLovelace;
  const totalSharesAfter = totalShares + fee.feeShares;

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };

  const nextDatum = encodeStateDatum(lucidMod, {
    totalShares: totalSharesAfter.toString(),
    totalAssets: totalAssetsAfter.toString(),
    epoch: state.epoch + 1,
    operators: committee,
    threshold: state.threshold,
    paused: state.paused,
    feeBps: state.feeBps,
    treasury: state.treasury,
    treasuryShares: fee.treasurySharesAfter.toString(),
    lastFeeTime: settledAt.toString(),
    receiptPolicy: state.receiptPolicy,
  });
  const redeemer = Data.to(new Constr(REDEEMER_ACCRUE, [params.amountLovelace]));

  const currentLovelace = stateUtxo.assets["lovelace"] ?? 0n;

  // Per-asset opt-in: once this vault's yield_vault script is published as a
  // reference script, point at it instead of carrying its CBOR. Assets with
  // nothing published keep embedding the script exactly as before.
  const ref = await getRefInputIfPublished(
    params.assetId,
    Number(YIELD_VAULT_VERSION),
    "yield_vault",
    script.cbor,
    script.scriptHash,
  );

  let builder = lucid.newTx();
  if (ref) builder = builder.readFrom([ref as never]);
  builder = builder.collectFrom([stateUtxo], redeemer);
  if (!ref) {
    builder = builder.attach.SpendingValidator({ type: "PlutusV3", script: script.cbor });
  }
  builder = builder
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextDatum },
      { lovelace: currentLovelace + params.amountLovelace },
    )
    // Required: the fee branch rejects an accrual without a finite lower bound.
    .validFrom(settledAt);
  for (const s of signers) builder = builder.addSignerKey(s);

  const completed = await builder.complete();
  const witness = await completed.partialSign.withWallet();

  return {
    txCbor: completed.toCBOR(),
    witnesses: [{ keyHash: selfHash, witness }],
    assetId: params.assetId,
    address: script.address,
    amountLovelace: params.amountLovelace.toString(),
    epochBefore: state.epoch,
    epochAfter: state.epoch + 1,
    totalAssetsBefore: totalAssetsBefore.toString(),
    totalAssetsAfter: totalAssetsAfter.toString(),
    totalShares: totalShares.toString(),
    sharePriceBefore: price(totalAssetsBefore, totalShares),
    sharePriceAfter: price(totalAssetsAfter, totalSharesAfter),
    feeBps: state.feeBps,
    feeAssets: fee.feeAssets.toString(),
    feeSharesMinted: fee.feeShares.toString(),
    totalSharesAfter: totalSharesAfter.toString(),
    settledAt,
    requiredSigners: signers,
    threshold: state.threshold,
    committee,
  };
}

/**
 * Add the connected wallet's signature to an existing draft. Used when a
 * second operator opens the console and co-signs the same transaction body.
 */
export async function coSignAccrual(
  draft: AccrualDraft,
): Promise<AccrualDraft> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const address = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(address);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  const keyHash = cred.hash;

  if (!draft.requiredSigners.includes(keyHash)) {
    throw new Error("This wallet is not one of the operators this transaction requires.");
  }
  if (draft.witnesses.some((w) => w.keyHash === keyHash)) {
    throw new Error("This wallet has already signed.");
  }

  const witness = await lucid.fromTx(draft.txCbor).partialSign.withWallet();
  return { ...draft, witnesses: [...draft.witnesses, { keyHash, witness }] };
}

/** Assemble every collected witness and submit. Returns the transaction hash. */
export async function submitAccrual(draft: AccrualDraft): Promise<string> {
  if (draft.witnesses.length < draft.requiredSigners.length) {
    const missing = draft.requiredSigners.filter(
      (s) => !draft.witnesses.some((w) => w.keyHash === s),
    );
    throw new Error(
      `Still waiting on ${missing.length} operator signature(s): ${missing
        .map((m) => `${m.slice(0, 12)}…`)
        .join(", ")}`,
    );
  }
  const { lucid } = await initLucidWithWallet();
  const signed = await lucid
    .fromTx(draft.txCbor)
    .assemble(draft.witnesses.map((w) => w.witness))
    .complete();
  return signed.submit();
}
