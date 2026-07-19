/**
 * Phase-1 on-chain vault helpers (Step 4 — parameterized + versioned).
 *
 * The Aiken validator now takes a single Int parameter (`_version`). The
 * blueprint in `contracts/vault/plutus.json` stores the *unapplied* script
 * — a pure hash of the logic. We derive the *applied* script hash and
 * bech32 address in the browser by calling Lucid's `applyParamsToScript`
 * with `VAULT_VERSION`. Bumping `VAULT_VERSION` mints a fresh vault
 * instance without editing Aiken source.
 *
 * Lucid Evolution is dynamically imported inside each function so it never
 * ships into an SSR bundle. All calls must run in the browser after the
 * user has connected a CIP-30 wallet on Preprod.
 */

import { getWalletState } from "./wallet-store";
import {
  APP_NETWORK,
  LUCID_NETWORK,
  assertWalletMatchesAppNetwork,
} from "./network";
import { getBlockfrostClientConfig } from "./blockfrost.functions";

/** Cached Blockfrost client config fetched from the server function. */
let blockfrostConfigPromise: Promise<{ projectId: string; url: string }> | null = null;
async function getBlockfrostConfig() {
  if (!blockfrostConfigPromise) {
    blockfrostConfigPromise = getBlockfrostClientConfig().catch(e => {
      blockfrostConfigPromise = null;
      throw e;
    });
  }
  return blockfrostConfigPromise;
}

// ---------------------------------------------------------------------------
// Blueprint (unapplied) — pinned from contracts/vault/plutus.json.
// scripts/verify-vault-hash.mjs fails the build if these drift.
// ---------------------------------------------------------------------------

/** Bumping this value produces a fresh vault instance on-chain. */
export const VAULT_VERSION = 1n;

/** Hash of the *unapplied* parameterized validator from plutus.json. */
export const VAULT_BLUEPRINT_HASH =
  "ae8cfbb91361a3c5a544ad3fd3212da939b043efae1969ea6606745f";

/** Compiled CBOR of the *unapplied* parameterized validator (PlutusV3). */
export const VAULT_BLUEPRINT_CBOR =
  "590149010100229800aba2aba1aab9faab9eaab9dab9a9bad002488888896600264653001300800198041804800cc0200092225980099b8748008c020dd500144ca60026018003300c300d0019b874800122259800980098061baa0078acc004c034dd5003c566002600260186ea800a264b3001323322330020020012259800800c528456600266e3cdd71809800801c528c4cc008008c05000500f20243758602260246024602460246024602460246024601e6ea801cdd7180818071baa001899198008009bac301130123012300f375400e44b30010018a508acc004c966002600a60206ea8006266e3cdd7180998089baa001375c602660226ea8012294100f180918081baa301230103754602400314a313300200230130014038808a294100c180798069baa0028b20168b201c8b201618049baa0028b200e180400098021baa0088a4d1365640081";

/** Whether the vault is available on the network the app is pointed at. */
export function isVaultDeployedOnNetwork(): boolean {
  return APP_NETWORK === "preprod";
}

const PROVIDER_KEY: Record<string, string> = {
  Lace: "lace",
  Eternl: "eternl",
  Nami: "nami",
  Typhon: "typhon",
  Flint: "flint",
  Yoroi: "yoroi",
  GeroWallet: "gerowallet",
};

export interface DepositResult {
  txHash: string;
  amountAda: number;
  scriptAddress: string;
}

export interface WithdrawResult {
  txHash: string;
  amountAda: number;
  utxoCount: number;
}

/** Preconditions the browser can enforce without touching Lucid. */
export function checkVaultPreconditions(): { ok: true } | { ok: false; reason: string } {
  if (!isVaultDeployedOnNetwork()) {
    return { ok: false, reason: `Vault validator isn't deployed on ${APP_NETWORK}. Switch the app to Preprod (VITE_BLOCKFROST_NETWORK=preprod) to use the vault.` };
  }
  if (!BLOCKFROST_PROJECT_ID) {
    return { ok: false, reason: `VITE_BLOCKFROST_PROJECT_ID missing — needed to query wallet UTxOs on ${APP_NETWORK}.` };
  }
  const w = getWalletState();
  if (!w.connected) return { ok: false, reason: "Connect a Cardano wallet first." };
  const netCheck = assertWalletMatchesAppNetwork(w.networkId);
  if (!netCheck.ok) return netCheck;
  if (!w.provider || !(w.provider in PROVIDER_KEY)) {
    return { ok: false, reason: "This wallet provider isn't supported for on-chain deposits yet." };
  }
  return { ok: true };
}

export async function initLucidWithWallet() {
  const wallet = getWalletState();
  const walletKey = PROVIDER_KEY[wallet.provider as keyof typeof PROVIDER_KEY];
  const cardano = (window as unknown as { cardano?: Record<string, { enable: () => Promise<unknown> } | undefined> }).cardano;
  const walletEntry = cardano?.[walletKey];
  if (!walletEntry) throw new Error(`${wallet.provider} is no longer available in the browser.`);
  const walletApi = await walletEntry.enable();

  const lucidMod = await import("@lucid-evolution/lucid");
  const lucid = await lucidMod.Lucid(
    new lucidMod.Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID!),
    LUCID_NETWORK,
  );
  lucid.selectWallet.fromAPI(walletApi as Parameters<typeof lucid.selectWallet.fromAPI>[0]);
  return { lucid, lucidMod };
}

// ---------------------------------------------------------------------------
// Applied script — derived at runtime by applying VAULT_VERSION.
// ---------------------------------------------------------------------------

type LucidMod = Awaited<ReturnType<typeof initLucidWithWallet>>["lucidMod"];
type LucidInstance = Awaited<ReturnType<typeof initLucidWithWallet>>["lucid"];

export interface AppliedVault {
  /** CBOR of the fully-applied validator (ready to attach to a tx). */
  cbor: string;
  /** Applied script hash (bech32 payment credential of the vault address). */
  scriptHash: string;
  /** Bech32 vault address for the active network. */
  address: string;
  /** Plutus language version — always V3 for this blueprint. */
  type: "PlutusV3";
}

let appliedCache: AppliedVault | null = null;
let loggedOnce = false;

/**
 * Apply `VAULT_VERSION` to the blueprint CBOR and return the applied script
 * + its address on the active network. Cached for the session.
 */
export async function getVaultScript(
  lucid: LucidInstance,
  lucidMod: LucidMod,
): Promise<AppliedVault> {
  if (appliedCache) return appliedCache;

  const { applyParamsToScript, validatorToAddress, validatorToScriptHash, Data } = lucidMod as unknown as {
    applyParamsToScript: (cbor: string, params: unknown[]) => string;
    validatorToAddress: (network: typeof LUCID_NETWORK, validator: { type: "PlutusV3"; script: string }) => string;
    validatorToScriptHash: (validator: { type: "PlutusV3"; script: string }) => string;
    Data: LucidMod["Data"];
  };

  // Encode Int parameter as a plain bigint — Lucid serialises to Plutus Data.
  const appliedCbor = applyParamsToScript(VAULT_BLUEPRINT_CBOR, [VAULT_VERSION]);
  const validator = { type: "PlutusV3" as const, script: appliedCbor };
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress(LUCID_NETWORK, validator);

  appliedCache = { cbor: appliedCbor, scriptHash, address, type: "PlutusV3" };

  if (!loggedOnce) {
    loggedOnce = true;
    // eslint-disable-next-line no-console
    console.info(
      `[vault] applied version=${VAULT_VERSION} → hash=${scriptHash} address=${address}`,
    );
  }
  // Silence unused-var lints in strict builds.
  void Data;
  return appliedCache;
}

/**
 * Lock `amountAda` in the vault script UTxO with an inline datum that pins
 * the current wallet's payment key hash as the owner.
 */
export async function depositAdaToVault(amountAda: number): Promise<DepositResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  if (!(amountAda > 0)) throw new Error("Enter a positive ADA amount.");
  if (amountAda < 2) throw new Error("Cardano UTxOs require at least ~1.5 ADA. Deposit at least 2 ADA.");

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { Data, paymentCredentialOf } = lucidMod;
  const script = await getVaultScript(lucid, lucidMod);

  const ownerAddress = await lucid.wallet().address();
  const paymentCred = paymentCredentialOf(ownerAddress);
  if (paymentCred.type !== "Key") {
    throw new Error("Connected address isn't a normal key-hash address; Phase 1 vault only supports key-hash owners.");
  }

  const VaultDatumSchema = Data.Object({ owner: Data.Bytes() });
  type VaultDatum = { owner: string };
  const datumCbor = Data.to<VaultDatum>({ owner: paymentCred.hash }, VaultDatumSchema as unknown as VaultDatum);

  const lovelace = BigInt(Math.round(amountAda * 1_000_000));

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      script.address,
      { kind: "inline", value: datumCbor },
      { lovelace },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return { txHash, amountAda, scriptAddress: script.address };
}

// ---- Withdraw --------------------------------------------------------

/**
 * Turn a raw CIP-30 / Lucid / Blockfrost error into something a human can act on.
 * Cardano nodes return validation failures as deeply-nested Haskell-ish blobs;
 * this walks the payload for well-known tags and produces a short cause.
 */
export function decodeVaultError(err: unknown, ctx: { ownerHash?: string } = {}): string {
  const raw =
    err instanceof Error ? err.message :
    typeof err === "string" ? err :
    (() => { try { return JSON.stringify(err); } catch { return String(err); } })();

  if (!raw) return "Unknown error.";
  const s = raw.toLowerCase();

  if (s.includes("user declined") || s.includes("user rejected") || /\bcode":?\s*-?2\b/.test(s)) {
    return "You declined the signature in your wallet.";
  }

  const scriptFailed =
    s.includes("scriptexecutionfailure") ||
    s.includes("validationtagmismatch") ||
    s.includes("script failed") ||
    s.includes("scriptserror") ||
    s.includes("plutusfailure");
  if (scriptFailed) {
    return (
      "Vault validator rejected the tx. The Aiken script requires the datum's owner PKH to appear in tx.extra_signatories AND at least one output paying that same PKH — most likely you're trying to withdraw a UTxO deposited by a different wallet, or the wallet didn't attach the required signer." +
      (ctx.ownerHash ? ` (this wallet's PKH: ${ctx.ownerHash.slice(0, 12)}…)` : "")
    );
  }

  if (s.includes("missingrequiredsigners") || s.includes("missingvkeywitnessesutxow") || s.includes("missing required signers")) {
    return "Transaction was built but your wallet didn't include the required signature. Try again — some wallets need to re-open the sign popup after switching networks.";
  }

  if (s.includes("insufficientcollateral") || s.includes("nocollateralinputs") || s.includes("collateralcontainsnonada")) {
    return "Your wallet has no eligible collateral UTxO. Plutus spends need a pure-ADA UTxO of ~5 tADA set aside as collateral — top up from the faucet.";
  }
  if (s.includes("valuenotconservedutxo") || s.includes("insufficient") && s.includes("fee")) {
    return "Not enough ADA in the wallet to cover fees + collateral. Fund the wallet from the Preprod faucet and retry.";
  }
  if (s.includes("outsidevalidityintervalutxo") || s.includes("outsideforecast")) {
    return "Transaction validity window drifted. Refresh the page and rebuild — the wallet cached stale slot info.";
  }
  if (s.includes("badinputsutxo") || s.includes("input not found") || s.includes("utxo not found")) {
    return "One of the vault UTxOs was already spent or hasn't confirmed yet. Wait ~20s for the previous tx and retry.";
  }
  if (s.includes("ppviewhashesdontmatch")) {
    return "Wallet used stale Plutus protocol params (usually a stuck Nami/Eternl cache). Reload the wallet extension and retry.";
  }

  if (s.includes("blockfrost") && s.includes("403")) return "Blockfrost rejected the request (bad project ID or wrong network).";
  if (s.includes("blockfrost") && s.includes("429")) return "Blockfrost rate limit hit. Wait a few seconds and retry.";

  const trimmed = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
  return `On-chain submission failed: ${trimmed}`;
}

/**
 * Spend every vault UTxO owned by the connected wallet back to the wallet.
 * The Aiken validator enforces:
 *   1. `tx.extra_signatories` contains the datum owner PKH.
 *   2. At least one output pays that same PKH.
 * The redeemer is the typed constructor `VaultRedeemer::Withdraw` (index 0).
 */
export async function withdrawAdaFromVault(): Promise<WithdrawResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { Data, paymentCredentialOf } = lucidMod;
  const script = await getVaultScript(lucid, lucidMod);

  const ownerAddress = await lucid.wallet().address();
  const paymentCred = paymentCredentialOf(ownerAddress);
  if (paymentCred.type !== "Key") {
    throw new Error("Connected address isn't a normal key-hash address.");
  }
  const ownerHash = paymentCred.hash;

  const allUtxos = await lucid.utxosAt(script.address);
  const VaultDatumSchema = Data.Object({ owner: Data.Bytes() });
  type VaultDatum = { owner: string };

  let matched = 0;
  let mismatched = 0;
  const mine = allUtxos.filter(u => {
    if (!u.datum) return false;
    try {
      const d = Data.from<VaultDatum>(u.datum, VaultDatumSchema as unknown as VaultDatum);
      if (d.owner === ownerHash) { matched++; return true; }
      mismatched++;
      return false;
    } catch {
      return false;
    }
  });
  if (mine.length === 0) {
    if (mismatched > 0) {
      throw new Error(
        `Found ${mismatched} vault UTxO${mismatched === 1 ? "" : "s"} at the script address, but none are owned by this wallet (PKH ${ownerHash.slice(0, 12)}…). Connect the wallet that made the deposit and try again.`,
      );
    }
    throw new Error("No vault UTxOs found for this wallet. Make a deposit first, or wait for the previous tx to confirm (~20s on Preprod).");
  }

  const totalLovelace = mine.reduce((n, u) => n + (u.assets.lovelace ?? 0n), 0n);

  // Typed redeemer: VaultRedeemer::Withdraw (zero-arity constructor, index 0).
  const withdrawRedeemer = Data.to(new lucidMod.Constr(0, []));

  try {
    const tx = await lucid
      .newTx()
      .collectFrom(mine, withdrawRedeemer)
      .attach.SpendingValidator({ type: "PlutusV3", script: script.cbor })
      .addSignerKey(ownerHash)
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, amountAda: Number(totalLovelace) / 1_000_000, utxoCount: matched };
  } catch (e) {
    throw new Error(decodeVaultError(e, { ownerHash }));
  }
}
