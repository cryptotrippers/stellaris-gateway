/**
 * Phase-1 on-chain vault helpers.
 *
 * Lucid Evolution is dynamically imported inside each function so it never
 * ships into an SSR bundle. All calls must run in the browser after the user
 * has connected a CIP-30 wallet on Preprod.
 */

import { getWalletState } from "./wallet-store";

// Preprod script address for the per-user vault validator.
// Derived from contracts/vault/plutus.json via `aiken address` — safe to commit
// (script addresses are public on-chain identifiers, not secrets).
export const VAULT_SCRIPT_ADDRESS: string | undefined =
  "addr_test1wplwxwujdq6t6lvc8j5agv7wurxpjx8dt094779t09whq4chqhwe6";

const BLOCKFROST_PROJECT_ID = import.meta.env.VITE_BLOCKFROST_PROJECT_ID as
  | string
  | undefined;

const BLOCKFROST_URL = "https://cardano-preprod.blockfrost.io/api/v0";

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
  if (!VAULT_SCRIPT_ADDRESS) {
    return { ok: false, reason: "Vault not deployed yet. Compile the Aiken validator locally and set VITE_VAULT_SCRIPT_ADDRESS." };
  }
  if (!VAULT_SCRIPT_ADDRESS.startsWith("addr_test1")) {
    return { ok: false, reason: "VITE_VAULT_SCRIPT_ADDRESS is not a Preprod address (must start with addr_test1)." };
  }
  if (!BLOCKFROST_PROJECT_ID) {
    return { ok: false, reason: "VITE_BLOCKFROST_PROJECT_ID missing — needed to query wallet UTxOs on Preprod." };
  }
  const w = getWalletState();
  if (!w.connected) return { ok: false, reason: "Connect a Cardano wallet first." };
  if (w.networkId !== 0) return { ok: false, reason: "Switch your wallet to the Preprod testnet." };
  if (!w.provider || !(w.provider in PROVIDER_KEY)) {
    return { ok: false, reason: "This wallet provider isn't supported for on-chain deposits yet." };
  }
  return { ok: true };
}

async function initLucidWithWallet() {
  const wallet = getWalletState();
  const walletKey = PROVIDER_KEY[wallet.provider as keyof typeof PROVIDER_KEY];
  const cardano = (window as unknown as { cardano?: Record<string, { enable: () => Promise<unknown> } | undefined> }).cardano;
  const walletEntry = cardano?.[walletKey];
  if (!walletEntry) throw new Error(`${wallet.provider} is no longer available in the browser.`);
  const walletApi = await walletEntry.enable();

  const lucidMod = await import("@lucid-evolution/lucid");
  const lucid = await lucidMod.Lucid(
    new lucidMod.Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID!),
    "Preprod",
  );
  lucid.selectWallet.fromAPI(walletApi as Parameters<typeof lucid.selectWallet.fromAPI>[0]);
  return { lucid, lucidMod };
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
      VAULT_SCRIPT_ADDRESS!,
      { kind: "inline", value: datumCbor },
      { lovelace },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();

  return { txHash, amountAda, scriptAddress: VAULT_SCRIPT_ADDRESS! };
}

// ---- Withdraw --------------------------------------------------------

async function bfGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BLOCKFROST_URL}${path}`, {
    headers: { project_id: BLOCKFROST_PROJECT_ID! },
  });
  if (!res.ok) throw new Error(`Blockfrost ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  return res.json() as Promise<T>;
}

/** Compiled validator CBOR from Blockfrost, cached per session. */
let scriptCache: { hash: string; type: "PlutusV1" | "PlutusV2" | "PlutusV3"; cbor: string } | null = null;

async function fetchVaultScript(scriptHash: string) {
  if (scriptCache?.hash === scriptHash) return scriptCache;
  const meta = await bfGet<{ type: string }>(`/scripts/${scriptHash}`);
  const { cbor } = await bfGet<{ cbor: string }>(`/scripts/${scriptHash}/cbor`);
  const t = meta.type.toLowerCase();
  const type = t === "plutusv3" ? "PlutusV3" : t === "plutusv2" ? "PlutusV2" : "PlutusV1";
  scriptCache = { hash: scriptHash, type, cbor };
  return scriptCache;
}

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

  // Wallet user actions
  if (s.includes("user declined") || s.includes("user rejected") || /\bcode":?\s*-?2\b/.test(s)) {
    return "You declined the signature in your wallet.";
  }

  // Validator-level failures — the vault script failed on-chain.
  //   The Aiken source runs one check: `list.has(tx.extra_signatories, d.owner)`.
  //   If that returns False, ledger emits ScriptFailure / ValidationTagMismatch.
  const scriptFailed =
    s.includes("scriptexecutionfailure") ||
    s.includes("validationtagmismatch") ||
    s.includes("script failed") ||
    s.includes("scriptserror") ||
    s.includes("plutusfailure");
  if (scriptFailed) {
    // Missing owner signature is the only way this specific validator returns False.
    return (
      "Vault validator rejected the tx. The Aiken script requires the datum's owner PKH to appear in tx.extra_signatories — most likely you're trying to withdraw a UTxO that was deposited by a different wallet, or the wallet didn't attach the required signer." +
      (ctx.ownerHash ? ` (this wallet's PKH: ${ctx.ownerHash.slice(0, 12)}…)` : "")
    );
  }

  // Ledger-level missing signer — script accepted, but no signature was attached.
  if (s.includes("missingrequiredsigners") || s.includes("missingvkeywitnessesutxow") || s.includes("missing required signers")) {
    return "Transaction was built but your wallet didn't include the required signature. Try again — some wallets need to re-open the sign popup after switching networks.";
  }

  // Fee / collateral / UTxO problems.
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

  // Blockfrost transport
  if (s.includes("blockfrost") && s.includes("403")) return "Blockfrost rejected the request (bad project ID or wrong network).";
  if (s.includes("blockfrost") && s.includes("429")) return "Blockfrost rate limit hit. Wait a few seconds and retry.";

  // Fall back to the raw message, trimmed.
  const trimmed = raw.length > 400 ? raw.slice(0, 400) + "…" : raw;
  return `On-chain submission failed: ${trimmed}`;
}

/**
 * Spend every vault UTxO owned by the connected wallet back to the wallet.
 * The Aiken validator only checks `tx.extra_signatories.contains(owner)`,
 * so the redeemer is a placeholder (`Data.void()`).
 */
export async function withdrawAdaFromVault(): Promise<WithdrawResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { Data, paymentCredentialOf } = lucidMod;

  const ownerAddress = await lucid.wallet().address();
  const paymentCred = paymentCredentialOf(ownerAddress);
  if (paymentCred.type !== "Key") {
    throw new Error("Connected address isn't a normal key-hash address.");
  }
  const ownerHash = paymentCred.hash;

  const scriptCred = paymentCredentialOf(VAULT_SCRIPT_ADDRESS!);
  if (scriptCred.type !== "Script") throw new Error("Vault address isn't a script address.");

  // Discover UTxOs at the script and filter by inline datum owner == this wallet.
  const allUtxos = await lucid.utxosAt(VAULT_SCRIPT_ADDRESS!);
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

  const script = await fetchVaultScript(scriptCred.hash);
  const totalLovelace = mine.reduce((n, u) => n + (u.assets.lovelace ?? 0n), 0n);

  try {
    const tx = await lucid
      .newTx()
      .collectFrom(mine, Data.void())
      .attach.SpendingValidator({ type: script.type, script: script.cbor })
      .addSignerKey(ownerHash)
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash, amountAda: Number(totalLovelace) / 1_000_000, utxoCount: matched };
  } catch (e) {
    throw new Error(decodeVaultError(e, { ownerHash }));
  }
}
