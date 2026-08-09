/**
 * Shared helpers for the asset ↔ vault registry.
 *
 * Lives outside `asset-vaults.functions.ts` because server-function modules
 * must contain only imports, types and server-function declarations; runtime
 * siblings declared there are deleted when handler bodies are split out.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export interface AssetVaultRow {
  id: string;
  asset_id: string;
  vault_version: number;
  network: string;
  script_hash: string;
  script_address: string;
  operator_key_hashes: string[];
  signature_threshold: number;
  bootstrap_tx_hash: string | null;
  bootstrapped_at: string | null;
  reporting_cadence: string | null;
}

/**
 * Publishable-key Supabase client for public reads inside server functions.
 * Opaque `sb_` keys are not JWTs, so the default bearer header is stripped.
 */
export function publicSupabase(): SupabaseClient<Database> {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) {
          h.delete("Authorization");
        }
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/** Throw a clear error unless the caller holds `role`. Checked server-side. */
export async function assertRole(
  supabase: SupabaseClient<Database>,
  userId: string,
  role: "admin" | "operator",
): Promise<void> {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: role,
  } as never);
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`This action requires the ${role} role.`);
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
    throw new Error("Duplicate operator key hash");
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > list.length) {
    throw new Error("Signature threshold must be between 1 and the number of operators");
  }
  return list;
}

// ---------------------------------------------------------------------------
// Management fee schedule (shared so governance execution reuses the same
// validation and insert as the operator-facing server function).
// ---------------------------------------------------------------------------

export interface VaultFeeScheduleRow {
  id: string;
  asset_id: string;
  vault_version: number;
  network: string;
  fee_bps: number;
  treasury_address: string;
  treasury_pkh: string | null;
  set_tx_hash: string | null;
  proposal_id: string | null;
  created_at: string;
}

export const FEE_COLS =
  "id, asset_id, vault_version, network, fee_bps, treasury_address, treasury_pkh, set_tx_hash, proposal_id, created_at";

export interface FeeScheduleInput {
  assetId: string;
  vaultVersion: number;
  network?: string;
  feeBps: number;
  treasuryAddress: string;
  treasuryPkh?: string | null;
  setTxHash?: string | null;
  proposalId?: string | null;
}

const TX_HASH = /^[0-9a-f]{64}$/;

/** Validate and normalise fee terms before they are mirrored into the table. */
export function normaliseFeeSchedule(data: FeeScheduleInput) {
  if (!data?.assetId) throw new Error("assetId is required");
  if (!Number.isInteger(data.feeBps) || data.feeBps < 0 || data.feeBps > 500) {
    throw new Error("feeBps must be a whole number between 0 and 500");
  }
  if (!data.treasuryAddress) throw new Error("A treasury address is required");
  if (data.setTxHash && !TX_HASH.test(data.setTxHash)) {
    throw new Error("Invalid transaction hash");
  }
  if (data.treasuryPkh && !HEX28.test(data.treasuryPkh)) {
    throw new Error("Invalid treasury key hash");
  }
  return {
    asset_id: data.assetId,
    vault_version: data.vaultVersion,
    network: data.network === "mainnet" ? "mainnet" : "preprod",
    fee_bps: data.feeBps,
    treasury_address: data.treasuryAddress,
    treasury_pkh: data.treasuryPkh ?? null,
    set_tx_hash: data.setTxHash ?? null,
    proposal_id: data.proposalId ?? null,
  };
}

/** Insert a fee schedule row as the caller (row-level rules still apply). */
export async function insertFeeSchedule(
  supabase: SupabaseClient<Database>,
  data: FeeScheduleInput,
): Promise<VaultFeeScheduleRow> {
  const { data: row, error } = await supabase
    .from("vault_fee_schedules")
    .insert(normaliseFeeSchedule(data) as never)
    .select(FEE_COLS)
    .single();
  if (error) throw new Error(error.message);
  return row as unknown as VaultFeeScheduleRow;
}
