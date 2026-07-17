import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@/lib/wallet-store";
import { fetchMyVaultHoldings, type VaultHoldings } from "@/lib/vault-holdings";

export const VAULT_HOLDINGS_KEY = (address: string | null) =>
  ["vault-holdings", address ?? "disconnected"] as const;

export function useVaultHoldings() {
  const wallet = useWallet();
  const enabled = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;
  const address = wallet.address ?? null;

  const query = useQuery<VaultHoldings>({
    queryKey: VAULT_HOLDINGS_KEY(address),
    queryFn: fetchMyVaultHoldings,
    enabled,
    staleTime: 20_000,
    refetchInterval: enabled ? 30_000 : false,
    retry: 1,
  });

  return {
    holdings: query.data?.holdings ?? [],
    totalAda: query.data?.totalAda ?? 0,
    address: query.data?.address ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    refetch: query.refetch,
    enabled,
  };
}
