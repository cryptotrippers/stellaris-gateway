import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SCRIPT_BUILD_ID, scriptScopedKey } from "@/lib/script-identity";

export interface DerivedVaultAddress {
  address: string;
  scriptHash: string;
  receiptPolicy: string | null;
}

export interface UseDerivedVaultAddress {
  /** Address this build derives for the asset, once Lucid has loaded. */
  derived: DerivedVaultAddress | null;
  /** The address callers should read chain state from — derived wins. */
  effectiveAddress: string | null;
  /** True when the registry still points at a superseded script. */
  isStale: boolean;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Derive an asset's yield-vault address from the validators in this build and
 * compare it with whatever the registry has stored.
 *
 * Derivation is cached under the script build id, so a contract change gives a
 * brand new cache entry rather than reusing the previous address. When drift is
 * detected, every cached query that mentions the superseded address is dropped
 * and the registry read is invalidated, so the UI converges on the live address
 * without a manual reload.
 */
export function useDerivedVaultAddress(
  assetId: string | null | undefined,
  registryAddress?: string | null,
): UseDerivedVaultAddress {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: scriptScopedKey("derived-vault-address", assetId ?? ""),
    enabled: !!assetId && typeof window !== "undefined",
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 0,
    queryFn: async (): Promise<DerivedVaultAddress> => {
      const [{ deriveYieldVaultAddress }, lucidMod, { getReceiptPolicy }] = await Promise.all([
        import("@/lib/vault-bootstrap"),
        import("@lucid-evolution/lucid"),
        import("@/lib/yield-vault"),
      ]);
      const script = await deriveYieldVaultAddress(assetId!);
      let receiptPolicy: string | null = null;
      try {
        receiptPolicy = getReceiptPolicy(lucidMod, assetId!).policyId;
      } catch {
        receiptPolicy = null;
      }
      return { address: script.address, scriptHash: script.scriptHash, receiptPolicy };
    },
  });

  const derived = query.data ?? null;
  const isStale = !!(derived && registryAddress && registryAddress !== derived.address);

  useEffect(() => {
    if (!isStale || !registryAddress) return;
    console.warn(
      `[script-cache] registry address ${registryAddress} is superseded by ${derived?.address} ` +
        `(build ${SCRIPT_BUILD_ID}); dropping cached reads for it.`,
    );
    queryClient.removeQueries({
      predicate: (q) => q.queryKey.some((part) => part === registryAddress),
    });
    void queryClient.invalidateQueries({ queryKey: ["asset-vault", assetId] });
    void queryClient.invalidateQueries({ queryKey: ["asset-vaults"] });
  }, [isStale, registryAddress, derived?.address, assetId, queryClient]);

  return {
    derived,
    effectiveAddress: derived?.address ?? registryAddress ?? null,
    isStale,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
  };
}
