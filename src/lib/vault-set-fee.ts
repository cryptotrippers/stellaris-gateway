/**
 * Stage 5 — the `SetFee` transaction builder.
 *
 * A governance fee change is a real Cardano transaction, not a database write.
 * It spends the vault's single State UTxO, settles the fee accrued under the
 * OLD rate (minting the treasury its shares), writes the new rate, and leaves
 * the vault's lovelace, epoch, pause flag and depositor shares untouched. The
 * validator re-derives all of that; this module builds a transaction that
 * satisfies it and gathers the M-of-N operator signatures.
 *
 * Mirrors `vault-accrual.ts` deliberately: same state selection, same
 * fee-clock anchoring, same both-ends validity window (V-05 — the `SetFee`
 * branch does `expect Some(hi) = upper_bound_time(tx)` and the script exits if
 * either bound is missing).
 *
 * Browser-only: Lucid is dynamically imported and a CIP-30 wallet on the app's
 * network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { assertYieldVaultAddress, getYieldVaultScript, YIELD_VAULT_VERSION } from "./yield-vault";
import { getRefInputIfPublished } from "./ref-scripts";
import {
  encodeStateDatum,
  readStateDatum,
  selectCanonicalState,
  type VaultStateDatum,
} from "./yield-chain-decode";
import { settleFee, feeBpsOk, MAX_FEE_BPS } from "./vault-fees";

/** YieldRedeemer constructor indices — mirrors yield_vault.ak. */
const REDEEMER_SET_FEE = 5;

/** The validator refuses a fee anchor reaching back further than 90 days. */
const MAX_SETTLE_WINDOW_MS = 7_776_000_000;

export interface SetFeeDraft {
  /** Unsigned (or partially signed) transaction CBOR. */
  txCbor: string;
  witnesses: Array<{ keyHash: string; witness: string }>;
  assetId: string;
  address: string;
  feeBpsBefore: number;
  feeBpsAfter: number;
  /** Lovelace of management fee owed under the OLD rate, settled here. */
  feeAssets: string;
  /** Shares minted to the treasury to settle that fee. */
  feeSharesMinted: string;
  totalSharesBefore: string;
  totalSharesAfter: string;
  totalAssets: string;
  epoch: number;
  /** POSIX ms the fee clock is advanced to; also the tx validity lower bound. */
  settledAt: number;
  requiredSigners: string[];
  threshold: number;
  committee: string[];
}

/**
 * Build the fee-change transaction and partially sign it with the connected
 * wallet. `signers` must contain at least the vault's threshold of committee
 * members — the validator counts `extra_signatories`.
 */
export async function buildSetFee(params: {
  assetId: string;
  feeBps: number;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<SetFeeDraft> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  if (!feeBpsOk(params.feeBps)) {
    throw new Error(`The fee must be a whole number between 0 and ${MAX_FEE_BPS} basis points.`);
  }

  const { lucid, lucidMod } = await initLucidWithWallet();
  const script = getYieldVaultScript(lucidMod, params.assetId);
  assertYieldVaultAddress(script, params.registryAddress);

  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  const selfHash = cred.hash;

  // --- locate the live State UTxO ---------------------------------------
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
    throw new Error("This vault has no state UTxO yet — bootstrap it before changing the fee.");
  }

  if (state.feeBps === params.feeBps) {
    throw new Error(
      `This vault's fee is already ${(params.feeBps / 100).toFixed(2)}% / yr — the validator rejects a no-op change.`,
    );
  }

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

  // --- fee settlement under the OLD rate ---------------------------------
  const settledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  const lastFeeTime = BigInt(state.lastFeeTime);
  if (BigInt(settledAt) < lastFeeTime) {
    throw new Error(
      "This vault's fee clock is ahead of the current time; wait a moment and rebuild.",
    );
  }
  if (BigInt(settledAt) - lastFeeTime > BigInt(MAX_SETTLE_WINDOW_MS)) {
    throw new Error(
      "This vault has gone more than 90 days without a fee settlement; run an accrual first so the fee clock is current.",
    );
  }
  const fee = settleFee(state, BigInt(settledAt));

  const totalShares = BigInt(state.totalShares);
  const totalSharesAfter = totalShares + fee.feeShares;

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };

  const nextDatum = encodeStateDatum(lucidMod, {
    totalShares: totalSharesAfter.toString(),
    // SetFee moves no money: total_assets and the UTxO's lovelace stand still.
    totalAssets: state.totalAssets,
    epoch: state.epoch,
    operators: committee,
    threshold: state.threshold,
    paused: state.paused,
    feeBps: params.feeBps,
    treasury: state.treasury,
    treasuryShares: fee.treasurySharesAfter.toString(),
    lastFeeTime: settledAt.toString(),
    receiptPolicy: state.receiptPolicy,
  });
  const redeemer = Data.to(new Constr(REDEEMER_SET_FEE, [BigInt(params.feeBps)]));

  const currentLovelace = stateUtxo.assets["lovelace"] ?? 0n;

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
  // V-05: both validity bounds are mandatory — the lower bound anchors the fee
  // clock, the upper bound must be finite and >= `settledAt`.
  builder = builder
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextDatum },
      { lovelace: currentLovelace },
    )
    .validFrom(settledAt)
    .validTo(settledAt + 15 * 60_000);
  for (const s of signers) builder = builder.addSignerKey(s);

  const completed = await builder.complete();
  const witness = await completed.partialSign.withWallet();

  return {
    txCbor: completed.toCBOR(),
    witnesses: [{ keyHash: selfHash, witness }],
    assetId: params.assetId,
    address: script.address,
    feeBpsBefore: state.feeBps,
    feeBpsAfter: params.feeBps,
    feeAssets: fee.feeAssets.toString(),
    feeSharesMinted: fee.feeShares.toString(),
    totalSharesBefore: totalShares.toString(),
    totalSharesAfter: totalSharesAfter.toString(),
    totalAssets: state.totalAssets,
    epoch: state.epoch,
    settledAt,
    requiredSigners: signers,
    threshold: state.threshold,
    committee,
  };
}

/** Add the connected wallet's signature to an existing draft. */
export async function coSignSetFee(draft: SetFeeDraft): Promise<SetFeeDraft> {
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
export async function submitSetFee(draft: SetFeeDraft): Promise<string> {
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
