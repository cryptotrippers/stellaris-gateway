/**
 * Phase-1 on-chain vault helpers.
 *
 * Lucid Evolution is dynamically imported inside each function so it never
 * ships into an SSR bundle. All calls must run in the browser after the user
 * has connected a CIP-30 wallet on Preprod.
 */

import { getWalletState } from "./wallet-store";

export const VAULT_SCRIPT_ADDRESS = import.meta.env.VITE_VAULT_SCRIPT_ADDRESS as
  | string
  | undefined;

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

/**
 * Lock `amountAda` in the vault script UTxO with an inline datum that pins
 * the current wallet's payment key hash as the owner.
 */
export async function depositAdaToVault(amountAda: number): Promise<DepositResult> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);
  if (!(amountAda > 0)) throw new Error("Enter a positive ADA amount.");
  if (amountAda < 2) throw new Error("Cardano UTxOs require at least ~1.5 ADA. Deposit at least 2 ADA.");

  const wallet = getWalletState();
  const walletKey = PROVIDER_KEY[wallet.provider as keyof typeof PROVIDER_KEY];
  const cardano = (window as unknown as { cardano?: Record<string, { enable: () => Promise<unknown> } | undefined> }).cardano;
  const walletEntry = cardano?.[walletKey];
  if (!walletEntry) throw new Error(`${wallet.provider} is no longer available in the browser.`);
  const walletApi = await walletEntry.enable();

  const { Lucid, Blockfrost, Data, paymentCredentialOf } = await import("@lucid-evolution/lucid");

  const lucid = await Lucid(
    new Blockfrost(BLOCKFROST_URL, BLOCKFROST_PROJECT_ID!),
    "Preprod",
  );
  lucid.selectWallet.fromAPI(walletApi as Parameters<typeof lucid.selectWallet.fromAPI>[0]);

  const ownerAddress = await lucid.wallet().address();
  const paymentCred = paymentCredentialOf(ownerAddress);
  if (paymentCred.type !== "Key") {
    throw new Error("Connected address isn't a normal key-hash address; Phase 1 vault only supports key-hash owners.");
  }

  const VaultDatumSchema = Data.Object({ owner: Data.Bytes() });
  const datumCbor = Data.to({ owner: paymentCred.hash }, VaultDatumSchema);

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
