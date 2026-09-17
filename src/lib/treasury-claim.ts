/**
 * Stage 7 — the treasury claim transaction builder (`ClaimFee`).
 *
 * Revenue only leaves a vault one way: the committee spends the State UTxO
 * with `ClaimFee { shares }`, burns that many treasury shares, and pays their
 * redeemable value to the treasury key recorded in the datum. The validator
 * enforces M-of-N signatures, the share cap, the payout cap, and that no fee
 * rate, epoch, pause flag, receipt or depositor share moves in the same
 * transaction. This module only builds a transaction that satisfies it.
 *
 * Browser-only: Lucid is dynamically imported and a CIP-30 wallet on the app's
 * network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { assertYieldVaultAddress, getYieldVaultScript, YIELD_VAULT_VERSION } from "./yield-vault";
import { getRefInputIfPublished } from "./ref-scripts";
import { LUCID_NETWORK } from "./network";
import {
  encodeStateDatum,
  readStateDatum,
  selectCanonicalState,
  type VaultStateDatum,
} from "./yield-chain-decode";
import { redeemValue } from "./yield-position";

/** YieldRedeemer constructor index — mirrors yield_vault.ak. */
const REDEEMER_CLAIM_FEE = 6;

/** The State UTxO must keep enough ADA to stay above the ledger's min-ADA. */
const STATE_MIN_LOVELACE = 2_000_000n;

export interface TreasuryClaimDraft {
  txCbor: string;
  witnesses: Array<{ keyHash: string; witness: string }>;
  assetId: string;
  address: string;
  /** Treasury payment address the claim pays out to. */
  treasuryAddress: string;
  /** Treasury shares burned by this claim. */
  sharesClaimed: string;
  /** Lovelace paid to the treasury. */
  paidLovelace: string;
  treasurySharesBefore: string;
  treasurySharesAfter: string;
  totalSharesAfter: string;
  totalAssetsAfter: string;
  requiredSigners: string[];
  threshold: number;
  committee: string[];
}

/**
 * Build the claim and partially sign it with the connected wallet.
 * `shares` defaults to the vault's entire unclaimed treasury balance.
 */
export async function buildTreasuryClaim(params: {
  assetId: string;
  /** Treasury shares to cash out. Defaults to all of them. */
  shares?: bigint;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<TreasuryClaimDraft> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

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
  if (!chosen) throw new Error("This vault has no state UTxO yet — there is nothing to claim.");
  const stateUtxo = chosen.utxo;
  const state = chosen.state;

  const treasuryShares = BigInt(state.treasuryShares);
  if (treasuryShares <= 0n) {
    throw new Error("This vault has no unclaimed fee shares yet.");
  }
  const shares = params.shares ?? treasuryShares;
  if (shares <= 0n) throw new Error("Enter a positive number of treasury shares to claim.");
  if (shares > treasuryShares) {
    throw new Error("That is more than the treasury's unclaimed fee shares.");
  }

  // --- committee ---------------------------------------------------------
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

  // --- payout ------------------------------------------------------------
  // The validator allows `paid <= redeem_value(shares)`, and the State output
  // must stay above min-ADA.
  const entitled = redeemValue(state, shares);
  if (entitled <= 0n) throw new Error("These treasury shares currently redeem to zero lovelace.");
  const stateLovelace = stateUtxo.assets["lovelace"] ?? 0n;
  const available = stateLovelace - STATE_MIN_LOVELACE;
  if (available <= 0n) {
    throw new Error("The vault cannot pay this claim without breaking its min-ADA floor.");
  }
  const paid = entitled < available ? entitled : available;

  const { Data, Constr, credentialToAddress } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
    credentialToAddress: (
      network: typeof LUCID_NETWORK,
      payment: { type: "Key"; hash: string },
    ) => string;
  };
  const treasuryAddress = credentialToAddress(LUCID_NETWORK, {
    type: "Key",
    hash: state.treasury,
  });

  const nextDatum = encodeStateDatum(lucidMod, {
    ...state,
    // A claim burns treasury shares and pays out their value. Nothing else in
    // the datum may move — the validator checks each field.
    totalShares: (BigInt(state.totalShares) - shares).toString(),
    totalAssets: (BigInt(state.totalAssets) - paid).toString(),
    treasuryShares: (treasuryShares - shares).toString(),
  });
  const redeemer = Data.to(new Constr(REDEEMER_CLAIM_FEE, [shares]));

  const ref = await getRefInputIfPublished(
    params.assetId,
    Number(YIELD_VAULT_VERSION),
    "yield_vault",
    script.cbor,
    script.scriptHash,
  );

  // V-05: every committee branch is built with BOTH validity bounds finite, so
  // a future validator change that reads the upper bound cannot crash the
  // script. ~15 minutes leaves room to collect signatures and submit.
  const from = Math.floor((Date.now() - 60_000) / 1000) * 1000;

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
      { lovelace: stateLovelace - paid },
    )
    .pay.ToAddress(treasuryAddress, { lovelace: paid })
    .validFrom(from)
    .validTo(from + 15 * 60_000);
  for (const s of signers) builder = builder.addSignerKey(s);

  const completed = await builder.complete();
  const witness = await completed.partialSign.withWallet();

  return {
    txCbor: completed.toCBOR(),
    witnesses: [{ keyHash: selfHash, witness }],
    assetId: params.assetId,
    address: script.address,
    treasuryAddress,
    sharesClaimed: shares.toString(),
    paidLovelace: paid.toString(),
    treasurySharesBefore: treasuryShares.toString(),
    treasurySharesAfter: (treasuryShares - shares).toString(),
    totalSharesAfter: (BigInt(state.totalShares) - shares).toString(),
    totalAssetsAfter: (BigInt(state.totalAssets) - paid).toString(),
    requiredSigners: signers,
    threshold: state.threshold,
    committee,
  };
}

/** Add the connected wallet's signature to an existing claim draft. */
export async function coSignTreasuryClaim(
  draft: TreasuryClaimDraft,
): Promise<TreasuryClaimDraft> {
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
export async function submitTreasuryClaim(draft: TreasuryClaimDraft): Promise<string> {
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
