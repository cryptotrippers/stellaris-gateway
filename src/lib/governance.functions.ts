import { createServerFn } from "@tanstack/react-start";

/**
 * Protocol-wide TVL as the sum of amount_ada across all vault_positions.
 * vault_positions is RLS-scoped per user, so aggregation runs server-side
 * with the service role.
 */
export const getProtocolStats = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("vault_positions")
    .select("amount_ada");
  if (error) throw new Error(error.message);
  const totalAda = (data ?? []).reduce((sum, row) => sum + Number(row.amount_ada ?? 0), 0);
  const activeVaults = new Set((data ?? []).map((r: { vault_id?: string }) => r.vault_id)).size;
  return { totalAda, activeVaults };
});
