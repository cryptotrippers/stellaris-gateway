import type { MarketAsset } from "@/components/marketplace/marketplace-query";

export type PassportAsset = MarketAsset;

/** Public vault registration for an asset (from the asset vault registry). */
export type PassportVault = {
  script_address: string;
  script_hash: string;
  bootstrap_tx_hash: string | null;
  bootstrapped_at: string | null;
  signature_threshold: number;
  operator_key_hashes: string[];
  reporting_cadence: string | null;
} | null;

/** Public funding request linked to this asset, if any. */
export type PassportRequest = {
  id: string;
  category: string;
  asset_slug: string;
  created_at: string;
  status: string;
  evidence_urls: string[];
  reporting_cadence: string | null;
  proposed_fee_bps: number;
  proposal_id: string | null;
} | null;

export type PassportChecklist = { item_key: string; status: string; verified_at: string | null }[];

export type PassportReturns = { apyPct: number | null; accrualCount: number } | null;
