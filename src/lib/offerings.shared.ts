/**
 * Offering registry — shared types and formatting.
 *
 * A row here is a pointer to an on-chain offering, never the source of truth
 * about it. Counters, price and status are read from the chain; the row only
 * records where to look and what was registered.
 */

import type { OfferingDatum, OfferingStatus } from "./offering-chain";

export interface OfferingRow {
  id: string;
  asset_id: string;
  network: string;
  vault_version: number;
  script_hash: string;
  script_address: string;
  fraction_policy_id: string;
  fraction_asset_name_hex: string;
  deposit_asset_id: string | null;
  total_fractions: number;
  price_per_fraction: number;
  mint_fee_bps: number;
  redeem_fee_bps: number;
  status: OfferingStatus;
  issuer_name: string;
  treasury_address: string | null;
  bootstrap_tx_hash: string | null;
  bootstrapped_at: string | null;
}

export const OFFERING_COLS =
  "id, asset_id, network, vault_version, script_hash, script_address, fraction_policy_id, " +
  "fraction_asset_name_hex, deposit_asset_id, total_fractions, price_per_fraction, mint_fee_bps, " +
  "redeem_fee_bps, status, issuer_name, treasury_address, bootstrap_tx_hash, bootstrapped_at";

export interface FractionHolder {
  address: string;
  fractions: string;
}

/** Live chain state for an offering, read through Blockfrost. */
export interface OfferingChainState {
  address: string;
  /** Null when the offering has been registered but not opened on chain. */
  datum: OfferingDatum | null;
  /** Units the offering UTxO actually holds in its denomination. */
  held: string;
  /** Where the numbers came from and when, so nothing is taken on trust. */
  source: "blockfrost";
  readAt: number;
  /** Set when the address carries more than one offering state. */
  warning: string | null;
}

export const OFFERING_STATUS_COPY: Record<OfferingStatus, { label: string; hint: string }> = {
  open: { label: "Open", hint: "Fractions of this asset are on sale now." },
  closed: {
    label: "Funded",
    hint: "All fractions are placed. Holders can still sell or transfer them at any time.",
  },
  redeeming: {
    label: "Paying out",
    hint: "Holders can hand fractions back for their share of what the asset has paid in.",
  },
};

/** Percentage of the offering that has been taken up, 0–100. */
export function soldPercent(datum: OfferingDatum): number {
  const total = Number(datum.totalFractions);
  if (!total) return 0;
  return Math.min(100, (Number(datum.minted) / total) * 100);
}
