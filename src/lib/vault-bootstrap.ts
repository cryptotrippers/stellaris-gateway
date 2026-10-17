/**
 * Stage 4 — Step 1: bootstrap the on-chain vault ledger.
 *
 * A yield vault cannot accept a deposit, an accrual, or a redemption until its
 * single State UTxO exists: the aggregate ledger every later transaction
 * balances against. This module builds that one-time transaction.
 *
 * Phase 1 (AUDIT.md F-1): bootstrap also mints the vault's one-shot
 * state-thread token. It spends a wallet UTxO (the `seed`), and the seed is a
 * parameter of the validator — so the vault's address is only fixed once the
 * seed is chosen here. The returned `seed` must be pinned in
 * `src/lib/vault-instances.ts` before the rest of the app can address the vault.
 *
 * Browser-only — Lucid is dynamically imported so it never enters an SSR
 * bundle, and the wallet must be connected on the app's network.
 */

import { checkVaultPreconditions, initLucidWithWallet } from "./vault";
import { getReceiptPolicy, getYieldVaultScript, YIELD_VAULT_VERSION } from "./yield-vault";
import { feeBpsOk, MAX_FEE_BPS } from "./vault-fees";
import { encodeStateDatum } from "./yield-chain-decode";
import type { VaultSeed } from "./vault-instances";

export interface BootstrapParams {
  assetId: string;
  /** Operator payment key hashes (hex) forming the committee. */
  operators: string[];
  /** How many of those operators must sign an accrual or pause. */
  threshold: number;
  /** Lovelace to place on the state UTxO to satisfy Cardano's min-ADA rule. */
  lovelace?: bigint;
  /** Annual management fee in basis points (0–500). */
  feeBps?: number;
  /** Treasury payment key hash (28-byte hex) entitled to claim fee shares. */
  treasuryPkh?: string;
}

export interface BootstrapResult {
  txHash: string;
  address: string;
  scriptHash: string;
  assetId: string;
  vaultVersion: number;
  operators: string[];
  threshold: number;
  feeBps: number;
  treasuryPkh: string;
  lastFeeTime: number;
  /** Receipt minting policy id written into the vault's state datum. */
  receiptPolicy: string;
  /** The UTxO consumed to mint the state-thread token. Pin it in vault-instances.ts. */
  seed: VaultSeed;
  /** Lucid unit of the state-thread token now held by the State UTxO. */
  threadUnit: string;
}

const HEX28 = /^[0-9a-f]{56}$/;

/** Validate a committee before anyone signs anything. */
export function validateCommittee(
  operators: string[],
  threshold: number,
): { ok: true } | { ok: false; reason: string } {
  if (operators.length === 0) return { ok: false, reason: "Add at least one operator key hash." };
  const bad = operators.find((o) => !HEX28.test(o.trim().toLowerCase()));
  if (bad) {
    return {
      ok: false,
      reason: `"${bad.slice(0, 16)}…" is not a 28-byte payment key hash (56 hex characters).`,
    };
  }
  const unique = new Set(operators.map((o) => o.trim().toLowerCase()));
  if (unique.size !== operators.length) {
    return { ok: false, reason: "The same operator key hash is listed more than once." };
  }
  if (threshold < 1) return { ok: false, reason: "The signature threshold must be at least 1." };
  if (threshold > operators.length) {
    return {
      ok: false,
      reason: `Threshold ${threshold} is higher than the ${operators.length} operator(s) listed — the vault would be permanently unusable.`,
    };
  }
  return { ok: true };
}

/** The payment key hash of the currently connected wallet, for committee setup. */
export async function getConnectedOperatorKeyHash(): Promise<string> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  const { lucid, lucidMod } = await initLucidWithWallet();
  const address = await lucid.wallet().address();
  const cred = lucidMod.paymentCredentialOf(address);
  if (cred.type !== "Key") throw new Error("Connected address is not a key-hash address.");
  return cred.hash;
}

/**
 * Derive a bootstrapped yield vault's address without signing anything.
 * Throws `VaultNotBootstrappedError` when the asset has no pinned seed: since
 * Phase 1 an address cannot exist before its bootstrap seed is chosen.
 */
export async function deriveYieldVaultAddress(assetId: string) {
  const lucidMod = await import("@lucid-evolution/lucid");
  return getYieldVaultScript(lucidMod, assetId);
}

/**
 * Create the vault's State UTxO: zero shares, zero assets, epoch zero, the
 * operator committee and its threshold, unpaused.
 *
 * Each run spends a different seed and therefore creates a brand-new vault
 * instance at a new address — it can never add a second State to an existing
 * vault. Pin the returned seed to make the new instance the live one.
 */
export async function bootstrapYieldVault(params: BootstrapParams): Promise<BootstrapResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const operators = params.operators.map((o) => o.trim().toLowerCase());
  const committee = validateCommittee(operators, params.threshold);
  if (!committee.ok) throw new Error(committee.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  // AUDIT.md O-01: bootstrap intentionally does NOT check against a registry
  // address — it exists to create a state UTxO at whatever address this
  // build derives, including the re-bootstrap flow that deliberately targets
  // a new address after the registry's old one has drifted. Callers that
  // spend an *existing* state UTxO (deposit/withdraw/accrue) are the ones
  // that must verify against the registry; see assertYieldVaultAddress.
  // The seed: any wallet UTxO, chosen deterministically. Spending it is what
  // makes the thread-token mint one-shot.
  const walletUtxos = await lucid.wallet().getUtxos();
  const seedUtxo = [...walletUtxos].sort((a, b) =>
    `${a.txHash}#${String(a.outputIndex).padStart(5, "0")}`.localeCompare(
      `${b.txHash}#${String(b.outputIndex).padStart(5, "0")}`,
    ),
  )[0];
  if (!seedUtxo) throw new Error("The connected wallet has no UTxO to use as the vault seed.");
  const seed: VaultSeed = { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex };

  const script = getYieldVaultScript(lucidMod, params.assetId, seed);
  const receipt = getReceiptPolicy(lucidMod, params.assetId, seed);

  const feeBps = params.feeBps ?? 0;
  if (!feeBpsOk(feeBps)) {
    throw new Error(
      `The management fee must be a whole number of basis points between 0 and ${MAX_FEE_BPS} (${(MAX_FEE_BPS / 100).toFixed(2)}%/yr).`,
    );
  }
  const treasuryPkh = (params.treasuryPkh ?? "").trim().toLowerCase();
  if (feeBps > 0 && !HEX28.test(treasuryPkh)) {
    throw new Error(
      "A treasury payment key hash (56 hex characters) is required when the management fee is above zero.",
    );
  }
  if (treasuryPkh && !HEX28.test(treasuryPkh)) {
    throw new Error("The treasury payment key hash must be 56 hex characters.");
  }

  // The fee clock starts now: the validator prorates from `last_fee_time`, so
  // seeding it with the current time means no fee is owed for the past.
  const lastFeeTime = Date.now();

  // State { total_shares, total_assets, epoch, operators, threshold, paused,
  //         fee_bps, treasury, treasury_shares, last_fee_time,
  //         receipt_policy, entry_fee_bps, exit_fee_bps }
  // is constructor index 1 of YieldDatum. Entry and exit fees start at zero:
  // only a governance-executed `SetFee` can turn them on.
  const datum = encodeStateDatum(lucidMod, {
    totalShares: "0",
    totalAssets: "0",
    epoch: 0,
    operators,
    threshold: params.threshold,
    paused: false,
    feeBps,
    treasury: treasuryPkh,
    treasuryShares: "0",
    lastFeeTime: lastFeeTime.toString(),
    receiptPolicy: receipt.policyId,
    entryFeeBps: 0,
    exitFeeBps: 0,
  });

  const lovelace = params.lovelace ?? 5_000_000n;

  const { Data, Constr } = lucidMod as unknown as {
    Data: { to: (v: unknown) => string };
    Constr: new (index: number, fields: unknown[]) => unknown;
  };

  // The vault script is its own thread-token policy (same hash). Its mint
  // handler checks: seed consumed, exactly one token, no State spent, and the
  // State output is a valid empty ledger carrying the token.
  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [script.threadUnit]: 1n }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy({ type: "PlutusV3", script: script.cbor })
    .pay.ToContract(
      script.address,
      { kind: "inline", value: datum },
      { lovelace, [script.threadUnit]: 1n },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return {
    txHash,
    address: script.address,
    scriptHash: script.scriptHash,
    assetId: params.assetId,
    vaultVersion: Number(YIELD_VAULT_VERSION),
    operators,
    threshold: params.threshold,
    feeBps,
    treasuryPkh,
    lastFeeTime,
    receiptPolicy: receipt.policyId,
    seed,
    threadUnit: script.threadUnit,
  };
}
