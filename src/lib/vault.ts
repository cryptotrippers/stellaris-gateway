/**
 * Versioned on-chain vault helpers (Stage 3 — shared multi-depositor vaults).
 *
 * The Aiken validator is parameterized by `(version, asset_id)`. The blueprint
 * in `contracts/vault/plutus.json` is the *unapplied* script. We derive the
 * applied script hash and bech32 address in the browser with Lucid's
 * `applyParamsToScript`. Bumping `VAULT_VERSION` mints a fresh vault instance
 * without editing the Aiken source.
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

/**
 * Version + default asset live in `vault-params.ts` so server-only code can
 * read them without pulling in Lucid or the wallet store. Re-exported here to
 * keep every existing import path working.
 *
 * Stage 3: the validator is parameterized by `(version, asset_id)`, so every
 * marketplace asset gets its own script hash + address. The validator now
 * also enforces owner-preserving datum continuity for partial withdrawals.
 */
export { VAULT_VERSION, DEFAULT_VAULT_ASSET_ID } from "./vault-params";
import { VAULT_VERSION } from "./vault-params";

/** Hash of the *unapplied* Stage 3 validator from plutus.json. */
export const VAULT_BLUEPRINT_HASH =
  "b582793a5e9bb3993ed68876ee017165808efb672e0d333e83975194";

/** Compiled CBOR of the *unapplied* Stage 3 validator (PlutusV3). */
export const VAULT_BLUEPRINT_CBOR =
  "5902ca0101002229800aba2aba1aba0aab9faab9eaab9dab9a9bad0039bae00248888888896600264653001300a00198051805800cdc3a4005300a0024888966002600460146ea800e2653001300f00198079808000cdc3a40009112cc004c004c038dd50044566002601e6ea80222b30013001300e3754005133225980099199119801001000912cc00400629422b30013371e6eb8c05c00400e2946266004004603000280910151bac301530163016301630163016301630163016301237540106eb8c050c044dd5001456600264660020026eb0c008c048dd5004112cc00400629422b30013259800980318099baa001899b8f375c602e60286ea8004dd7180b980a1baa0058a504048602c60266ea8c058c04cdd5180b000c528c4cc008008c05c00501120288992cc004c010c044dd5000c4c8c8cc004004dd61802180a1baa00a2259800800c528c5660026464b3001300e3016375400315980099b8f375c6034602e6ea8004016264b30013370e9002180b9baa0018992cc004c02cc060dd5000c4c8c966002603e00513371e6eb8c078c06cdd50019bae301e301b37540191640706eb8c074004c064dd5000c59017180d980c1baa0018a504058600e602e6ea800a29450154528a02a3019301637546032602c6ea8004c060006266004004603200314a080990161bae30153012375400314a08080c966002600860226ea8006264b3001300a3012375400313374a90001980a980b18099baa0014bd704530103d87a80004044602a60246ea8c054c048dd5180a980b18091baa30153012375400314c103d87a8000404064660020026eb0c054c048dd5004112cc0040062980103d87a80008992cc004cdd7980b980a1baa001008899ba548000cc0580052f5c113300300330180024048602c00280a2294100f4528201e3012300f37540044602660286028003164035164041164034300b3754007164024300a00130053754015149a26cac8019";


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

  const { lucid, lucidMod } = await initLucidReadOnly();
  lucid.selectWallet.fromAPI(walletApi as Parameters<typeof lucid.selectWallet.fromAPI>[0]);
  return { lucid, lucidMod };
}

/**
 * Init a Lucid instance backed by Blockfrost only (no wallet). Used by the
 * read-only "view by address" flow to query script UTxOs and derive PKHs
 * without prompting the user to sign anything.
 */
export async function initLucidReadOnly() {
  const bf = await getBlockfrostConfig();
  const lucidMod = await import("@lucid-evolution/lucid");
  const lucid = await lucidMod.Lucid(
    new lucidMod.Blockfrost(bf.url, bf.projectId),
    LUCID_NETWORK,
  );
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
  /** Marketplace asset this vault instance is bound to. */
  assetId: string;
  /** Plutus language version — always V3 for this blueprint. */
  type: "PlutusV3";
}

const appliedCache = new Map<string, AppliedVault>();
const logged = new Set<string>();

/**
 * Apply `(VAULT_VERSION, assetId)` to the blueprint CBOR and return the applied
 * script + its address on the active network. Each asset id derives a distinct
 * script hash, so vaults are isolated per asset. Cached per asset for the session.
 */
export async function getVaultScript(
  lucid: LucidInstance,
  lucidMod: LucidMod,
  assetId: string = DEFAULT_VAULT_ASSET_ID,
): Promise<AppliedVault> {
  const cached = appliedCache.get(assetId);
  if (cached) return cached;

  const { applyParamsToScript, validatorToAddress, validatorToScriptHash, fromText } = lucidMod as unknown as {
    applyParamsToScript: (cbor: string, params: unknown[]) => string;
    validatorToAddress: (network: typeof LUCID_NETWORK, validator: { type: "PlutusV3"; script: string }) => string;
    validatorToScriptHash: (validator: { type: "PlutusV3"; script: string }) => string;
    fromText: (s: string) => string;
  };

  // Params: Int version + ByteArray asset id (UTF-8 → hex).
  const appliedCbor = applyParamsToScript(VAULT_BLUEPRINT_CBOR, [
    VAULT_VERSION,
    fromText(assetId),
  ]);
  const validator = { type: "PlutusV3" as const, script: appliedCbor };
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress(LUCID_NETWORK, validator);

  const applied: AppliedVault = { cbor: appliedCbor, scriptHash, address, assetId, type: "PlutusV3" };
  appliedCache.set(assetId, applied);

  if (!logged.has(assetId)) {
    logged.add(assetId);
    // eslint-disable-next-line no-console
    console.info(
      `[vault] applied version=${VAULT_VERSION} asset=${assetId} → hash=${scriptHash} address=${address}`,
    );
  }
  return applied;
}


/**
 * Lock `amountAda` in the vault script UTxO with an inline datum that pins
 * the current wallet's payment key hash as the owner.
 */
export async function depositAdaToVault(
  amountAda: number,
  assetId: string = DEFAULT_VAULT_ASSET_ID,
): Promise<DepositResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  if (!(amountAda > 0)) throw new Error("Enter a positive ADA amount.");
  if (amountAda < 2) throw new Error("Cardano UTxOs require at least ~1.5 ADA. Deposit at least 2 ADA.");

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { Data, paymentCredentialOf } = lucidMod;
  const script = await getVaultScript(lucid, lucidMod, assetId);


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

  if (
    s.includes("remoteapishutdownerror") ||
    s.includes("cardano-wallet-api") ||
    s.includes("object can no longer be used")
  ) {
    return "Your Lace wallet session expired while preparing the transaction. Disconnect Lace in the app, unlock it, reconnect on Preprod, refresh this page, and retry. Do not approve the same request again. No new on-chain transaction was confirmed by this error.";
  }

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
  if (s.includes("all inputs are spent") || s.includes("transaction has probably already been included")) {
    return "These vault UTxOs have already been spent. The withdrawal was probably accepted on the first submission; refresh your holdings and check your wallet transaction history. Do not sign it again.";
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
export async function withdrawAdaFromVault(
  assetId: string = DEFAULT_VAULT_ASSET_ID,
): Promise<WithdrawResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { Data, paymentCredentialOf } = lucidMod;
  const script = await getVaultScript(lucid, lucidMod, assetId);


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
