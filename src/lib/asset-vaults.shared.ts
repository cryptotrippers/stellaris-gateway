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
