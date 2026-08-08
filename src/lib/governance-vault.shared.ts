/**
 * Shared helpers for vault governance. Kept out of the `.functions.ts` module
 * so that file stays a thin server-function wrapper.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const PROPOSAL_KINDS = ["accrue", "pause", "unpause", "set_committee", "signal"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export type ProposalParams = Record<string, string | number | boolean | string[] | null>;

export interface ProposalRow {
  id: string;
  sip_number: string;
  title: string;
  status: string;
  kind: ProposalKind;
  asset_id: string | null;
  body: string | null;
  params: ProposalParams;
  votes_for_pct: number;
  starts_at: string | null;
  ends_at: string | null;
  executed_tx_hash: string | null;
  executed_at: string | null;
  executed_epoch: number | null;
  created_at: string;
}

export const PROPOSAL_COLUMNS =
  "id, sip_number, title, status, kind, asset_id, body, params, votes_for_pct, starts_at, ends_at, executed_tx_hash, executed_at, executed_epoch, created_at";

/** Next SIP number, derived from existing rows. */
export function nextSipNumber(rows: Array<{ sip_number: string | null }>): string {
  let max = 0;
  for (const r of rows) {
    const m = /SIP-(\d+)/i.exec(r.sip_number ?? "");
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `SIP-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Validate the parameters a proposal carries for its kind. An accrual must
 * name the exact lovelace amount it authorises, because execution is later
 * matched against the on-chain delta.
 */
export function validateProposalParams(
  kind: ProposalKind,
  assetId: string | null,
  params: Record<string, unknown>,
): ProposalParams {
  if (kind === "signal") return {};

  if (!assetId) throw new Error("This proposal type must name the asset it concerns.");

  if (kind === "accrue") {
    const raw = params?.["amount_lovelace"];
    const amount = typeof raw === "string" || typeof raw === "number" ? BigInt(raw) : null;
    if (amount === null || amount <= 0n) {
      throw new Error("An accrual proposal must specify a positive lovelace amount.");
    }
    return { amount_lovelace: amount.toString() };
  }

  if (kind === "pause" || kind === "unpause") return {};

  if (kind === "set_committee") {
    const ops = params?.["operators"];
    const threshold = Number(params?.["threshold"]);
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new Error("A committee proposal must list the proposed operator key hashes.");
    }
    const list = ops.map((o) => String(o).trim().toLowerCase());
    if (list.some((o) => !/^[0-9a-f]{56}$/.test(o))) {
      throw new Error("Operator key hashes must be 56 hex characters.");
    }
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > list.length) {
      throw new Error("The threshold must be between 1 and the number of operators.");
    }
    return { operators: list, threshold };
  }

  return {};
}

/** Human label for a proposal kind. */
export function proposalKindLabel(kind: ProposalKind): string {
  switch (kind) {
    case "accrue":
      return "Accrue yield";
    case "pause":
      return "Pause vault";
    case "unpause":
      return "Unpause vault";
    case "set_committee":
      return "Change operator committee";
    default:
      return "Signal";
  }
}

/** Throw unless the caller holds `role`. */
export async function requireRole(
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
