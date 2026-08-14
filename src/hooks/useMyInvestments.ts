import { useQueries } from "@tanstack/react-query";
import { useWallet } from "@/lib/wallet-store";
import { EXPECTED_WALLET_NETWORK_ID } from "@/lib/network";
import { loadMyVaultView, type VaultView } from "@/lib/yield-position";

export interface MyInvestment {
  assetId: string;
  address: string;
  shares: bigint;
  /** Lovelace currently redeemable for those shares at the live share price. */
  redeemableLovelace: bigint;
  /** Lovelace actually sitting in the depositor's Position UTxOs. */
  principalLovelace: bigint;
  sharePrice: number;
  utxoCount: number;
}

/**
 * The connected wallet's real, on-chain positions in every shared yield vault.
 *
 * The portfolio used to read `vault_positions` from the database, which is only
 * written by off-chain bookkeeping and is empty for wallets that deposited
 * directly through the contract — so investments looked like zero everywhere.
 * This reads the Position UTxOs themselves, which is the source of truth.
 */
export function useMyInvestments(assetIds: string[]) {
  const wallet = useWallet();
  const ready = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;
  const ids = [...new Set(assetIds)].sort();

  const results = useQueries({
    queries: ids.map((assetId) => ({
      queryKey: ["my-investment", assetId, wallet.address],
      queryFn: () => loadMyVaultView(assetId),
      enabled: ready,
      // A vault that was never bootstrapped throws; that is not an error here.
      retry: 0,
      staleTime: 30_000,
      refetchInterval: ready ? 60_000 : (false as const),
    })),
  });

  const investments: MyInvestment[] = [];
  results.forEach((r, i) => {
    const view = r.data as VaultView | undefined;
    if (!view || view.positions.length === 0) return;
    investments.push({
      assetId: ids[i]!,
      address: view.address,
      shares: view.positions.reduce((a, p) => a + p.shares, 0n),
      redeemableLovelace: view.positions.reduce((a, p) => a + p.redeemable, 0n),
      principalLovelace: view.positions.reduce((a, p) => a + p.lovelace, 0n),
      sharePrice: view.sharePrice,
      utxoCount: view.positions.length,
    });
  });

  const totalLovelace = investments.reduce((a, i) => a + i.redeemableLovelace, 0n);
  const principalLovelace = investments.reduce((a, i) => a + i.principalLovelace, 0n);

  return {
    ready,
    investments,
    totalAda: Number(totalLovelace) / 1e6,
    principalAda: Number(principalLovelace) / 1e6,
    /** Value gained over deposited principal, from on-chain accruals only. */
    gainAda: Number(totalLovelace - principalLovelace) / 1e6,
    isLoading: ready && results.some((r) => r.isLoading),
    isFetching: results.some((r) => r.isFetching),
  };
}
