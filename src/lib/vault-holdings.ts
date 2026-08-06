/**
 * Read on-chain vault UTxOs owned by either the connected signer wallet or a
 * pasted read-only viewer address (payment or stake). All work happens in the
 * browser via Lucid + Blockfrost.
 */

import {
  checkVaultPreconditions,
  decodeVaultError,
  getVaultScript,
  initLucidReadOnly,
  initLucidWithWallet,
} from "./vault";
import { getWalletState } from "./wallet-store";
import { getAddressesForStakeAddress } from "./blockfrost.functions";

export interface VaultHolding {
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  ada: number;
  ownerPkh: string;
  /** Marketplace asset whose derived vault script holds this UTxO. */
  assetId: string;
}

/** Per-asset rollup so the UI can show which vault each balance sits in. */
export interface VaultAssetTotal {
  assetId: string;
  /** Applied script address for this asset's vault. */
  address: string;
  totalAda: number;
  utxoCount: number;
}

export interface VaultHoldings {
  address: string;
  ownerPkh: string;
  holdings: VaultHolding[];
  byAsset: VaultAssetTotal[];
  totalAda: number;
  mode: "signer" | "viewer";
}

/**
 * Signer flow — uses the connected CIP-30 wallet. Requires wallet preconditions.
 */
async function fetchAsSigner(assetIds: string[]): Promise<VaultHoldings> {
  const pre = checkVaultPreconditions();
  if (!pre.ok) throw new Error(pre.reason);

  const { lucid, lucidMod } = await initLucidWithWallet();
  const { paymentCredentialOf } = lucidMod;

  const address = await lucid.wallet().address();
  const cred = paymentCredentialOf(address);
  if (cred.type !== "Key") throw new Error("Wallet isn't a key-hash address.");
  const ownerPkh = cred.hash;

  const { holdings, byAsset } = await collectHoldings(lucid, lucidMod, new Set([ownerPkh]), assetIds);
  const totalAda = holdings.reduce((n, h) => n + h.ada, 0);
  return { address, ownerPkh, holdings, byAsset, totalAda, mode: "signer" };
}

/**
 * Viewer flow — no wallet signing. Given a payment or stake address, derives
 * the owning payment-key hashes and filters vault UTxOs by datum.owner.
 */
async function fetchAsViewer(address: string, kind: "payment" | "stake"): Promise<VaultHoldings> {
  const { lucid, lucidMod } = await initLucidReadOnly();
  const { paymentCredentialOf } = lucidMod;

  const paymentAddresses: string[] =
    kind === "payment"
      ? [address]
      : (await getAddressesForStakeAddress({ data: { stakeAddress: address } })).addresses;

  if (paymentAddresses.length === 0) {
    throw new Error("No payment addresses found for that stake address yet.");
  }

  const pkhs = new Set<string>();
  for (const a of paymentAddresses) {
    try {
      const cred = paymentCredentialOf(a);
      if (cred.type === "Key") pkhs.add(cred.hash);
    } catch { /* skip anything Lucid can't parse */ }
  }
  if (pkhs.size === 0) throw new Error("Address didn't resolve to any key-hash owners.");

  const holdings = await collectHoldings(lucid, lucidMod, pkhs);
  const totalAda = holdings.reduce((n, h) => n + h.ada, 0);
  return {
    address,
    ownerPkh: holdings[0]?.ownerPkh ?? [...pkhs][0],
    holdings,
    totalAda,
    mode: "viewer",
  };
}

type LucidBundle = Awaited<ReturnType<typeof initLucidReadOnly>>;

async function collectHoldings(
  lucid: LucidBundle["lucid"],
  lucidMod: LucidBundle["lucidMod"],
  ownerPkhs: Set<string>,
): Promise<VaultHolding[]> {
  const { Data } = lucidMod;
  const script = await getVaultScript(lucid, lucidMod);
  const utxos = await lucid.utxosAt(script.address);
  const VaultDatumSchema = Data.Object({ owner: Data.Bytes() });
  type VaultDatum = { owner: string };

  const holdings: VaultHolding[] = [];
  for (const u of utxos) {
    if (!u.datum) continue;
    try {
      const d = Data.from<VaultDatum>(u.datum, VaultDatumSchema as unknown as VaultDatum);
      if (!ownerPkhs.has(d.owner)) continue;
      const lovelace = u.assets.lovelace ?? 0n;
      holdings.push({
        txHash: u.txHash,
        outputIndex: u.outputIndex,
        lovelace,
        ada: Number(lovelace) / 1_000_000,
        ownerPkh: d.owner,
      });
    } catch {
      // Non-vault datum shape — skip.
    }
  }
  return holdings;
}

/**
 * Entry point used by `useVaultHoldings`. Chooses signer or viewer flow
 * based on the current wallet-store state.
 */
export async function fetchMyVaultHoldings(): Promise<VaultHoldings> {
  const w = getWalletState();
  try {
    if (w.connected) return await fetchAsSigner();
    if (w.viewerAddress && w.viewerKind) {
      return await fetchAsViewer(w.viewerAddress, w.viewerKind);
    }
    throw new Error("Connect a wallet or paste an address to view holdings.");
  } catch (e) {
    throw new Error(decodeVaultError(e));
  }
}
