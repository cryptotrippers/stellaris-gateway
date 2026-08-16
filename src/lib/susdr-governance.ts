/**
 * Operator-console transaction builders for the sUSDr vault: `Accrue`,
 * `SetPaused`, `RotateCommittee`, `SetFee`, `ClaimFee`.
 *
 * stellaris-gateway itself only ever built a TS transaction builder for
 * `Accrue` (`vault-accrual.ts`) — the other four operator redeemers exist in
 * `yield_vault.ak` but were never wired up off-chain there either. This
 * module is new: it generalizes `vault-accrual.ts`'s multi-sig
 * draft/co-sign/submit pattern (build a tx, partially sign with the
 * connected wallet, let other operators co-sign the same tx body, assemble
 * and submit once the M-of-N threshold is met) across all five operator
 * actions instead of duplicating that flow five times.
 *
 * Browser-only: Lucid is dynamically imported, and a CIP-30 wallet on the
 * app's network must be connected.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { LUCID_NETWORK } from "./network";
import { assertSusdrVaultAddress, getSusdrVaultScript, type AppliedSusdrVault } from "./susdr-vault";
import {
  encodeStateDatum,
  readStateDatum,
  selectCanonicalState,
  type SusdrStateDatum,
} from "./susdr-chain-decode";
import { settleFee } from "./vault-fees";
import { USDR_ASSET_NAME } from "./susdr-params";

/** SusdrRedeemer constructor indices — mirrors susdr_vault.ak. */
const REDEEMER_ACCRUE = 2;
const REDEEMER_SET_PAUSED = 3;
const REDEEMER_ROTATE_COMMITTEE = 4;
const REDEEMER_SET_FEE = 5;
const REDEEMER_CLAIM_FEE = 6;

const UTXO_MIN_LOVELACE = 2_000_000n;

export interface GovernanceDraft {
  /** Unsigned (or partially signed) transaction CBOR. */
  txCbor: string;
  witnesses: Array<{ keyHash: string; witness: string }>;
  usdrPolicyId: string;
  address: string;
  action:
    | { kind: "Accrue"; amountUsdr: string }
    | { kind: "SetPaused"; paused: boolean }
    | { kind: "RotateCommittee"; operators: string[]; threshold: number }
    | { kind: "SetFee"; feeBps: number }
    | { kind: "ClaimFee"; shares: string; paidUsdr: string };
  stateBefore: SusdrStateDatum;
  stateAfter: SusdrStateDatum;
  requiredSigners: string[];
  threshold: number;
  committee: string[];
}

function price(assets: bigint, shares: bigint): number {
  if (shares <= 0n) return 1;
  return Number(assets) / Number(shares);
}

async function resolveState(
  lucid: Awaited<ReturnType<typeof initLucidWithWallet>>["lucid"],
  script: AppliedSusdrVault,
) {
  const utxos = await lucid.utxosAt(script.address);
  const candidates: Array<{ utxo: (typeof utxos)[number]; state: SusdrStateDatum }> = [];
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
    throw new Error("This vault has no state UTxO yet — bootstrap it before running operator actions.");
  }
  return { stateUtxo, state };
}

function checkSigners(state: SusdrStateDatum, selfHash: string, signers?: string[]): string[] {
  const committee = state.operators.map((o) => o.toLowerCase());
  const normalized = (signers?.length ? signers : [selfHash]).map((s) => s.trim().toLowerCase());
  const outsiders = normalized.filter((s) => !committee.includes(s));
  if (outsiders.length > 0) {
    throw new Error(`${outsiders[0]!.slice(0, 12)}… is not on this vault's operator committee.`);
  }
  if (new Set(normalized).size < state.threshold) {
    throw new Error(
      `This vault needs ${state.threshold} operator signature(s); ${new Set(normalized).size} selected.`,
    );
  }
  if (!normalized.includes(selfHash)) {
    throw new Error("The connected wallet must be one of the signing operators.");
  }
  return normalized;
}

interface RedeemerFields {
  constr: number;
  fields: unknown[];
}

/**
 * Shared builder for the four state-only operator actions
 * (`SetPaused`/`RotateCommittee`/`SetFee`/`ClaimFee`) plus `Accrue`. Spends
 * the State UTxO, writes `nextState`, attaches the redeemer, and — for
 * `Accrue`/`SetFee`, which the validator anchors fee proration to — sets a
 * finite validity lower bound.
 */
async function buildOperatorTx(params: {
  usdrPolicyId: string;
  registryAddress?: string | null;
  signers?: string[];
  redeemer: RedeemerFields;
  nextState: (state: SusdrStateDatum, lucidMod: unknown) => SusdrStateDatum;
  needsValidFrom?: boolean;
  /** Lucid's fluent tx-builder type is awkward to name explicitly, so this is `unknown` in and out, cast at the call site — matches the rest of this codebase's Lucid call sites. */
  extraOutputs?: (builder: unknown, lucidMod: unknown, state: SusdrStateDatum) => unknown;
}): Promise<{
  stateUtxo: unknown;
  state: SusdrStateDatum;
  nextStateDatumObj: SusdrStateDatum;
  txCbor: string;
  witness: string;
  selfHash: string;
  signers: string[];
  script: AppliedSusdrVault;
}> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const script = getSusdrVaultScript(lucidMod, params.usdrPolicyId);
  assertSusdrVaultAddress(script, params.registryAddress);

  const walletAddress = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(walletAddress);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  const selfHash = cred.hash;

  const { stateUtxo, state } = await resolveState(lucid, script);
  const signers = checkSigners(state, selfHash, params.signers);

  const nextStateDatumObj = params.nextState(state, lucidMod);

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };
  const redeemer = Data.to(new Constr(params.redeemer.constr, params.redeemer.fields));
  const nextDatum = encodeStateDatum(lucidMod, nextStateDatumObj);
  const usdrUnit = `${script.usdrPolicyId}${script.usdrAssetNameHex}`;
  const currentUsdr = (stateUtxo.assets[usdrUnit] as bigint | undefined) ?? 0n;
  const currentLovelace = (stateUtxo.assets["lovelace"] as bigint | undefined) ?? 0n;
  const nextUsdr = currentUsdr + (BigInt(nextStateDatumObj.totalAssets) - BigInt(state.totalAssets));

  let builder = lucid
    .newTx()
    .collectFrom([stateUtxo as never], redeemer)
    .attach.SpendingValidator({ type: "PlutusV3", script: script.cbor })
    .pay.ToContract(
      script.address,
      { kind: "inline", value: nextDatum },
      { lovelace: currentLovelace, [usdrUnit]: nextUsdr },
    );

  if (params.extraOutputs) builder = params.extraOutputs(builder, lucidMod, state) as typeof builder;
  if (params.needsValidFrom) {
    // Required: the fee branch rejects an Accrue/SetFee without a finite
    // lower bound. Aligned to a whole second and set slightly in the past so
    // the tx is valid on arrival.
    const settledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
    if (BigInt(settledAt) < BigInt(state.lastFeeTime)) {
      throw new Error("This vault's fee clock is ahead of the current time; wait a moment and rebuild.");
    }
    builder = builder.validFrom(settledAt);
  }
  for (const s of signers) builder = builder.addSignerKey(s);

  const completed = await builder.complete();
  const witness = await completed.partialSign.withWallet();

  return {
    stateUtxo,
    state,
    nextStateDatumObj,
    txCbor: completed.toCBOR(),
    witness,
    selfHash,
    signers,
    script,
  };
}

/** Add the connected wallet's signature to an existing draft. */
export async function coSignGovernance(draft: GovernanceDraft): Promise<GovernanceDraft> {
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
export async function submitGovernance(draft: GovernanceDraft): Promise<string> {
  if (draft.witnesses.length < draft.requiredSigners.length) {
    const missing = draft.requiredSigners.filter((s) => !draft.witnesses.some((w) => w.keyHash === s));
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

// ---------------------------------------------------------------------------
// Accrue
// ---------------------------------------------------------------------------

export async function buildAccrue(params: {
  usdrPolicyId: string;
  amountUsdr: bigint;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<GovernanceDraft> {
  if (params.amountUsdr <= 0n) throw new Error("The accrual amount must be positive.");

  const result = await buildOperatorTx({
    usdrPolicyId: params.usdrPolicyId,
    registryAddress: params.registryAddress,
    signers: params.signers,
    redeemer: { constr: REDEEMER_ACCRUE, fields: [params.amountUsdr] },
    needsValidFrom: true,
    nextState: (state) => {
      if (state.paused) throw new Error("The vault is paused; unpause it before accruing yield.");
      const settledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
      const fee = settleFee(state, BigInt(settledAt));
      return {
        ...state,
        totalShares: (BigInt(state.totalShares) + fee.feeShares).toString(),
        totalAssets: (BigInt(state.totalAssets) + params.amountUsdr).toString(),
        epoch: state.epoch + 1,
        treasuryShares: fee.treasurySharesAfter.toString(),
        lastFeeTime: settledAt.toString(),
      };
    },
  });

  return {
    txCbor: result.txCbor,
    witnesses: [{ keyHash: result.selfHash, witness: result.witness }],
    usdrPolicyId: params.usdrPolicyId,
    address: result.script.address,
    action: { kind: "Accrue", amountUsdr: params.amountUsdr.toString() },
    stateBefore: result.state,
    stateAfter: result.nextStateDatumObj,
    requiredSigners: result.signers,
    threshold: result.state.threshold,
    committee: result.state.operators,
  };
}

// ---------------------------------------------------------------------------
// SetPaused
// ---------------------------------------------------------------------------

export async function buildSetPaused(params: {
  usdrPolicyId: string;
  paused: boolean;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<GovernanceDraft> {
  const result = await buildOperatorTx({
    usdrPolicyId: params.usdrPolicyId,
    registryAddress: params.registryAddress,
    signers: params.signers,
    redeemer: { constr: REDEEMER_SET_PAUSED, fields: [params.paused] },
    nextState: (state) => {
      if (state.paused === params.paused) {
        throw new Error(`The vault is already ${params.paused ? "paused" : "unpaused"}.`);
      }
      return { ...state, paused: params.paused };
    },
  });

  return {
    txCbor: result.txCbor,
    witnesses: [{ keyHash: result.selfHash, witness: result.witness }],
    usdrPolicyId: params.usdrPolicyId,
    address: result.script.address,
    action: { kind: "SetPaused", paused: params.paused },
    stateBefore: result.state,
    stateAfter: result.nextStateDatumObj,
    requiredSigners: result.signers,
    threshold: result.state.threshold,
    committee: result.state.operators,
  };
}

// ---------------------------------------------------------------------------
// RotateCommittee
// ---------------------------------------------------------------------------

export async function buildRotateCommittee(params: {
  usdrPolicyId: string;
  newOperators: string[];
  newThreshold: number;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<GovernanceDraft> {
  const newOperators = params.newOperators.map((o) => o.trim().toLowerCase());
  if (newOperators.length === 0) throw new Error("The incoming committee must have at least one operator.");
  if (params.newThreshold < 1 || params.newThreshold > newOperators.length) {
    throw new Error("The incoming threshold must be between 1 and the number of incoming operators.");
  }
  if (new Set(newOperators).size !== newOperators.length) {
    throw new Error("The incoming committee lists the same operator key hash more than once.");
  }

  const result = await buildOperatorTx({
    usdrPolicyId: params.usdrPolicyId,
    registryAddress: params.registryAddress,
    signers: params.signers,
    redeemer: { constr: REDEEMER_ROTATE_COMMITTEE, fields: [newOperators, BigInt(params.newThreshold)] },
    nextState: (state) => {
      const same =
        state.operators.length === newOperators.length &&
        state.operators.every((o, i) => o.toLowerCase() === newOperators[i]) &&
        state.threshold === params.newThreshold;
      if (same) throw new Error("The incoming committee is identical to the current one.");
      return { ...state, operators: newOperators, threshold: params.newThreshold };
    },
  });

  return {
    txCbor: result.txCbor,
    witnesses: [{ keyHash: result.selfHash, witness: result.witness }],
    usdrPolicyId: params.usdrPolicyId,
    address: result.script.address,
    action: { kind: "RotateCommittee", operators: newOperators, threshold: params.newThreshold },
    stateBefore: result.state,
    stateAfter: result.nextStateDatumObj,
    requiredSigners: result.signers,
    threshold: result.state.threshold,
    committee: result.state.operators,
  };
}

// ---------------------------------------------------------------------------
// SetFee
// ---------------------------------------------------------------------------

export async function buildSetFee(params: {
  usdrPolicyId: string;
  feeBps: number;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<GovernanceDraft> {
  const result = await buildOperatorTx({
    usdrPolicyId: params.usdrPolicyId,
    registryAddress: params.registryAddress,
    signers: params.signers,
    redeemer: { constr: REDEEMER_SET_FEE, fields: [BigInt(params.feeBps)] },
    needsValidFrom: true,
    nextState: (state) => {
      if (params.feeBps === state.feeBps) throw new Error("That is already the current fee rate.");
      if (params.feeBps < 0 || params.feeBps > 500) {
        throw new Error("The management fee must be between 0 and 500 basis points (5.00%/yr).");
      }
      const settledAt = Math.floor((Date.now() - 60_000) / 1000) * 1000;
      const fee = settleFee(state, BigInt(settledAt));
      return {
        ...state,
        totalShares: fee.totalSharesAfter.toString(),
        feeBps: params.feeBps,
        treasuryShares: fee.treasurySharesAfter.toString(),
        lastFeeTime: settledAt.toString(),
      };
    },
  });

  return {
    txCbor: result.txCbor,
    witnesses: [{ keyHash: result.selfHash, witness: result.witness }],
    usdrPolicyId: params.usdrPolicyId,
    address: result.script.address,
    action: { kind: "SetFee", feeBps: params.feeBps },
    stateBefore: result.state,
    stateAfter: result.nextStateDatumObj,
    requiredSigners: result.signers,
    threshold: result.state.threshold,
    committee: result.state.operators,
  };
}

// ---------------------------------------------------------------------------
// ClaimFee
// ---------------------------------------------------------------------------

export async function buildClaimFee(params: {
  usdrPolicyId: string;
  shares: bigint;
  signers?: string[];
  registryAddress?: string | null;
}): Promise<GovernanceDraft> {
  if (params.shares <= 0n) throw new Error("Enter a positive number of shares to claim.");

  let paidUsdr = 0n;
  const result = await buildOperatorTx({
    usdrPolicyId: params.usdrPolicyId,
    registryAddress: params.registryAddress,
    signers: params.signers,
    redeemer: { constr: REDEEMER_CLAIM_FEE, fields: [params.shares] },
    nextState: (state) => {
      if (params.shares > BigInt(state.treasuryShares)) {
        throw new Error("Cannot claim more shares than the treasury has accrued.");
      }
      const totalShares = BigInt(state.totalShares);
      const totalAssets = BigInt(state.totalAssets);
      const entitled = params.shares >= totalShares ? totalAssets : (params.shares * totalAssets) / totalShares;
      if (entitled <= 0n) throw new Error("These fee shares currently redeem to zero USDr.");
      paidUsdr = entitled;
      return {
        ...state,
        totalShares: (totalShares - params.shares).toString(),
        totalAssets: (totalAssets - entitled).toString(),
        treasuryShares: (BigInt(state.treasuryShares) - params.shares).toString(),
      };
    },
    extraOutputs: (builder, lucidMod, state) => {
      const { credentialToAddress, fromText } = lucidMod as unknown as {
        credentialToAddress: (network: unknown, cred: { type: "Key"; hash: string }) => string;
        fromText: (s: string) => string;
      };
      // NOTE: derived without a stake credential. The validator only checks
      // that SOME output's payment credential equals `treasury` — it does
      // not care about a stake part — but this address derivation itself is
      // unverified beyond `aiken check`/`aiken build`; confirm it resolves
      // to a spendable Preprod address during the Phase 3 walkthrough.
      const treasuryAddress = credentialToAddress(LUCID_NETWORK, { type: "Key", hash: state.treasury });
      const usdrUnit = `${params.usdrPolicyId}${fromText(USDR_ASSET_NAME)}`;
      const b = builder as { pay: { ToAddress: (addr: string, value: Record<string, bigint>) => unknown } };
      return b.pay.ToAddress(treasuryAddress, {
        lovelace: UTXO_MIN_LOVELACE,
        [usdrUnit]: paidUsdr,
      });
    },
  });

  return {
    txCbor: result.txCbor,
    witnesses: [{ keyHash: result.selfHash, witness: result.witness }],
    usdrPolicyId: params.usdrPolicyId,
    address: result.script.address,
    action: { kind: "ClaimFee", shares: params.shares.toString(), paidUsdr: paidUsdr.toString() },
    stateBefore: result.state,
    stateAfter: result.nextStateDatumObj,
    requiredSigners: result.signers,
    threshold: result.state.threshold,
    committee: result.state.operators,
  };
}
