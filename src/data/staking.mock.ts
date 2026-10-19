/**
 * Illustrative staking tiers for the testnet preview. No live chain calls —
 * swap this module for a real source when the staking contract ships.
 */
export type StakeTierId = "flex" | "locked";

export interface StakeTier {
  id: StakeTierId;
  label: string;
  /** Days before funds can be withdrawn (flexible cooldown / lock length). */
  cooldownDays: number;
  /**
   * Target annual rate, percent. Variable: it follows the reserve portfolio's
   * yield and is never a promised or fixed rate, so UI must label it that way.
   */
  aprPct: number;
  /** Yield multiplier vs the flexible tier (protocol cap 1.5×). */
  multiplier: number;
  summary: string;
}

export const STAKE_TIERS: StakeTier[] = [
  {
    id: "flex",
    label: "Flexible",
    cooldownDays: 7,
    aprPct: 4.5,
    multiplier: 1,
    summary:
      "You receive sTSRA tokens. Unstaking starts a 7-day cooldown (protocol bounds 7–14 days). During the cooldown your request no longer earns yield but still shares in any loss until you claim.",
  },
  {
    id: "locked",
    label: "Locked",
    cooldownDays: 30,
    aprPct: 5.6,
    multiplier: 1.25,
    summary:
      "A locked Position, not a token. Locked for 30 days in this preview (protocol bounds: at least 2× the flexible cooldown, at most 90 days). Earns 1.25× the flexible tier's yield per TSRA (protocol cap 1.5×). Only you can unlock it once the lock ends.",
  },
];

/** Illustrative wallet balance used by the preview form. */
export const MOCK_BASE_BALANCE = 1_000;
