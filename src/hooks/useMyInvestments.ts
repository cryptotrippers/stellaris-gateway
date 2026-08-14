import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffectiveAddress } from "@/lib/wallet-store";
import { paymentKeyHashOf } from "@/lib/address";
import { listAssetVaults, type AssetVaultRow } from "@/lib/asset-vaults.functions";
import { getVaultChainState, type VaultChainState } from "@/lib/yield-chain.functions";

export interface MyInvestment {
  assetId: string;
  address: string;
  shares: bigint;
  /** Lovelace redeemable for those shares at the live share price. */
  redeemableLovelace: bigint;
  /** Lovelace actually sitting in the depositor's Position UTxOs. */
  principalLovelace: bigint;
  sharePrice: number;
  utxoCount: number;
}

function redeemable(state: VaultChainState["state"], shares: bigint): bigint {
  if (!state) return 0n;
  const total = BigInt(state.totalShares);
  const assets = BigInt(state.totalAssets);
  if (total <= 0n) return 0n;
  if (shares >= total) return assets;
  return (shares * assets) / total;
}

/**
 * The connected (or viewed) wallet's real, on-chain positions in every
 * registered shared vault.
 *
 * Read server-side through Blockfrost rather than through the browser wallet:
 * the portfolio must show the same numbers whether or not Lucid and the CIP-30
 * API can be initialised, and it previously read an empty database table, so
 * investments appeared as zero on every page.
 */
export function useMyInvestments() {
  const eff = useEffectiveAddress();
  const myHash = paymentKeyHashOf(eff.address);

  const vaultsQ = useQuery<AssetVaultRow[]>({
    queryKey: ["asset-vaults-all"],
    queryFn: () => listAssetVaults(),
    staleTime: 5 * 60_000,
  });
  const vaults = (vaultsQ.data ?? []).filter((v) => !!v.script_address);

  const results = useQueries({
    queries: vaults.map((v) => ({
      queryKey: ["vault-chain-state", v.script_address],
      queryFn: () => getVaultChainState({ data: { address: v.script_address as string } }),
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: 0,
    })),
  });

  const investments: MyInvestment[] = [];
  results.forEach((r, i) => {
    const view = r.data as VaultChainState | undefined;
    const vault = vaults[i];
    if (!view || !vault || !myHash || !view.found) return;
    const mine = view.positions.filter((p) => p.owner.toLowerCase() === myHash);
    if (mine.length === 0) return;
    const shares = mine.reduce((a, p) => a + BigInt(p.shares), 0n);
    investments.push({
      assetId: vault.asset_id,
      address: view.address,
      shares,
      redeemableLovelace: redeemable(view.state, shares),
      principalLovelace: mine.reduce((a, p) => a + BigInt(p.lovelace), 0n),
      sharePrice: view.sharePrice ?? 1,
      utxoCount: mine.length,
    });
  });

  const totalLovelace = investments.reduce((a, i) => a + i.redeemableLovelace, 0n);
  const principalLovelace = investments.reduce((a, i) => a + i.principalLovelace, 0n);

  return {
    ready: !!myHash,
    investments,
    totalAda: Number(totalLovelace) / 1e6,
    principalAda: Number(principalLovelace) / 1e6,
    /** Value gained over deposited principal, from on-chain accruals only. */
    gainAda: Number(totalLovelace - principalLovelace) / 1e6,
    isLoading: vaultsQ.isLoading || results.some((r) => r.isLoading),
    isFetching: vaultsQ.isFetching || results.some((r) => r.isFetching),
  };
}
