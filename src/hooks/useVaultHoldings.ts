import { useQuery } from "@tanstack/react-query";
import { useEffectiveAddress, useWallet } from "@/lib/wallet-store";
import { fetchMyVaultHoldings, type VaultHoldings } from "@/lib/vault-holdings";
import { EXPECTED_WALLET_NETWORK_ID } from "@/lib/network";

export const VAULT_HOLDINGS_KEY = (address: string | null) =>
  ["vault-holdings", address ?? "disconnected"] as const;

export function useVaultHoldings() {
  const wallet = useWallet();
  const eff = useEffectiveAddress();

  // Signer: must be on the expected network. Viewer: enable when the pasted
  // address matches the app's network (prefix has already been parsed).
  const signerReady = eff.mode === "signer" && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;
  const viewerReady = eff.mode === "viewer" && eff.networkId === EXPECTED_WALLET_NETWORK_ID;
  const enabled = signerReady || viewerReady;
  const address = eff.address;

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
    mode: query.data?.mode ?? eff.mode,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error as Error | null,
    refetch: query.refetch,
    enabled,
  };
}
