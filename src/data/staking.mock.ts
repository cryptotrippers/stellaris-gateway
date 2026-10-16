/**
 * Illustrative staking tiers for the testnet preview. No live chain calls —
 * swap this module for a real source when the staking contract ships.
 */
export type StakeTierId = "flex7" | "lock30";

export interface StakeTier {
  id: StakeTierId;
  label: string;
  cooldownDays: number;
  /** Illustrative annual rate, percent. */
  aprPct: number;
  summary: string;
}

export const STAKE_TIERS: StakeTier[] = [
  {
    id: "flex7",
    label: "7-day unstake",
    cooldownDays: 7,
    aprPct: 4.5,
    summary: "Base rate. Request to unstake any time; funds arrive 7 days later.",
  },
  {
    id: "lock30",
    label: "30-day lock",
    cooldownDays: 30,
    aprPct: 6.0,
    summary: "Higher rate. Funds stay staked for 30 days before you can withdraw.",
  },
];

/** Illustrative wallet balance used by the preview form. */
export const MOCK_BASE_BALANCE = 1_000;
