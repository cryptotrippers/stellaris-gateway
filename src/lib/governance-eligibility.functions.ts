/**
 * Eligible voting weight.
 *
 * vault_positions is RLS-scoped per user, so the denominator behind quorum
 * has to be aggregated server-side. Only totals are returned — never a
 * per-user breakdown.
 */

import { createServerFn } from "@tanstack/react-start";

export interface EligibleWeights {
  total: number;
  byAsset: Record<string, number>;
}

export const getEligibleWeights = createServerFn({ method: "GET" }).handler(
  async (): Promise<EligibleWeights> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("vault_positions")
      .select("vault_id, amount_ada");
    if (error) throw new Error(error.message);
    const byAsset: Record<string, number> = {};
    let total = 0;
    for (const row of data ?? []) {
      const amount = Number(row.amount_ada) || 0;
      byAsset[row.vault_id] = (byAsset[row.vault_id] ?? 0) + amount;
      total += amount;
    }
    return { total, byAsset };
  },
);
