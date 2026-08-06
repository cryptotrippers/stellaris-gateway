import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_VAULT_ASSET_ID } from "@/lib/vault";

/**
 * Every marketplace asset id. Each one derives its own vault script address
 * via `(VAULT_VERSION, assetId)`, so this is also the list of live vaults.
 */
export function useVaultAssetIds() {
  const query = useQuery({
    queryKey: ["vault-asset-ids"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase.from("assets").select("id").order("id");
      if (error) throw error;
      return (data ?? []).map(r => r.id as string);
    },
  });

  const ids = query.data ?? [];
  return {
    assetIds: ids.length > 0 ? ids : [DEFAULT_VAULT_ASSET_ID],
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}
