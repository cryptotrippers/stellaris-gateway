/**
 * Public reads for the open deposit-asset registry.
 *
 * Reads are public by design — the whole point of Wing B is that the set of
 * accepted denominations is inspectable by any issuer or integrator without an
 * account. Writes are admin-only and enforced by row-level rules.
 */

import { createServerFn } from "@tanstack/react-start";
import { publicSupabase } from "./asset-vaults.shared";
import { DEPOSIT_ASSET_COLS, type DepositAsset } from "./deposit-assets.shared";

export type { DepositAsset } from "./deposit-assets.shared";

/** Every registered deposit asset, ordered for display. Public. */
export const listDepositAssets = createServerFn({ method: "GET" }).handler(
  async (): Promise<DepositAsset[]> => {
    const supabase = publicSupabase();
    const { data, error } = await supabase
      .from("deposit_assets")
      .select(DEPOSIT_ASSET_COLS)
      .order("sort_order", { ascending: true })
      .order("symbol", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as DepositAsset[];
  },
);
