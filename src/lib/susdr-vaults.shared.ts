/**
 * Shared helpers for the sUSDr vault registry.
 *
 * Lives outside `susdr-vaults.functions.ts` because server-function modules
 * must contain only imports, types and server-function declarations; runtime
 * siblings declared there are deleted when handler bodies are split out.
 * Mirrors `asset-vaults.shared.ts`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
export { publicSupabase, assertRole } from "./asset-vaults.shared";

export interface SusdrVaultRow {
  id: string;
  vault_version: number;
  network: string;
  usdr_policy_id: string;
  script_hash: string;
  susdr_policy_id: string;
  script_address: string;
  operator_key_hashes: string[];
  signature_threshold: number;
  fee_bps: number;
  treasury_key_hash: string | null;
  bootstrap_tx_hash: string | null;
  bootstrapped_at: string | null;
}

export interface SusdrAccrualRow {
  id: string;
  vault_id: string;
  network: string;
  tx_hash: string;
  epoch: number;
  amount_usdr: string;
  total_assets_after: string;
  total_shares_after: string;
  share_price_before: number | null;
  share_price_after: number | null;
  fee_shares_minted: string;
  block_height: number | null;
  block_time: string;
}

const HEX28 = /^[0-9a-f]{56}$/;

/** Lower-case, de-duplicate and sanity-check an operator committee. */
export function normaliseCommittee(operators: string[], threshold: number): string[] {
  const list = (operators ?? []).map((o) => o.trim().toLowerCase());
  if (list.length === 0) throw new Error("At least one operator key hash is required");
  if (list.some((o) => !HEX28.test(o))) {
    throw new Error("Operator key hashes must be 56 hex characters");
  }
  if (new Set(list).size !== list.length) {
    throw new Error("The same operator key hash is listed more than once");
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > list.length) {
    throw new Error("Threshold must be a whole number between 1 and the operator count");
  }
  return list;
}

export const SUSDR_VAULT_COLUMNS =
  "id, vault_version, network, usdr_policy_id, script_hash, susdr_policy_id, script_address, operator_key_hashes, signature_threshold, fee_bps, treasury_key_hash, bootstrap_tx_hash, bootstrapped_at";

export async function fetchVaultOr404(
  supabase: SupabaseClient<Database>,
  usdrPolicyId: string,
): Promise<SusdrVaultRow> {
  const { data, error } = await supabase
    .from("susdr_vaults")
    .select(SUSDR_VAULT_COLUMNS)
    .eq("usdr_policy_id", usdrPolicyId)
    .order("vault_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No sUSDr vault is registered for USDr policy ${usdrPolicyId}.`);
  return data as SusdrVaultRow;
}
