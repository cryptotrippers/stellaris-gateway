/**
 * Open deposit-asset registry (Wing B — Cardano RWA aggregator).
 *
 * The aggregator is deliberately issuer-neutral: any Cardano-native value —
 * ADA today, USDM / iUSD / RealFi's USDr when their vault interfaces exist —
 * can be listed here without an exclusive partnership. A row is a *declaration*
 * of the ledger unit and its provenance, never a claim that a vault accepts it
 * yet; that is what `status` says.
 *
 * Runtime helpers live here (not in `deposit-assets.functions.ts`) because
 * server-function modules may only declare imports, types and server functions.
 */

export type DepositAssetStatus = "live" | "test" | "planned";

export interface DepositAsset {
  id: string;
  symbol: string;
  display_name: string;
  /** Empty string for ADA; 56 hex chars for a native token. */
  policy_id: string;
  /** Empty string for ADA; hex-encoded asset name for a native token. */
  asset_name_hex: string;
  decimals: number;
  network: string;
  status: DepositAssetStatus;
  issuer_name: string;
  docs_url: string | null;
  cip113_metadata_url: string | null;
  sort_order: number;
}

export const DEPOSIT_ASSET_COLS =
  "id, symbol, display_name, policy_id, asset_name_hex, decimals, network, status, issuer_name, docs_url, cip113_metadata_url, sort_order";

/** Lucid unit string: `"lovelace"` for ADA, `policyId + assetNameHex` otherwise. */
export function depositAssetUnit(asset: Pick<DepositAsset, "policy_id" | "asset_name_hex">): string {
  if (!asset.policy_id) return "lovelace";
  return `${asset.policy_id}${asset.asset_name_hex}`;
}

/** True when this row denominates plain ADA rather than a native token. */
export function isAdaAsset(asset: Pick<DepositAsset, "policy_id">): boolean {
  return asset.policy_id === "";
}

/** Format a base-unit amount using the asset's declared decimals. */
export function formatDepositAmount(
  base: bigint | number | string,
  asset: Pick<DepositAsset, "decimals" | "symbol">,
  maximumFractionDigits = 2,
): string {
  const value = Number(base) / 10 ** asset.decimals;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${asset.symbol}`;
}

export const DEPOSIT_STATUS_COPY: Record<DepositAssetStatus, { label: string; hint: string }> = {
  live: { label: "Accepted", hint: "Vaults on this network accept deposits in this asset today." },
  test: {
    label: "Test only",
    hint: "A stand-in used to prove the interface before the real issuer's token exists.",
  },
  planned: {
    label: "Interface published",
    hint: "The ledger unit is recorded so an issuer can plug in without any change to the app.",
  },
};
