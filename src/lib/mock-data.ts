/**
 * DEPRECATED — this module used to export fabricated marketplace, portfolio,
 * proposal, and vault-activity rows. The institutional-readiness pass replaced
 * every literal statistic with a live query or an honest empty state.
 *
 * This file remains only as a compatibility shim so existing imports keep
 * compiling while consumers migrate. All arrays here are EMPTY by design.
 * Do not add rows. Ship new data through:
 *   - `assets`               table + `src/lib/assets.functions.ts`
 *   - `governance_proposals` table + `src/lib/governance.functions.ts`
 *   - `transactions`         table (activity)
 *   - `vault_positions`      table (portfolio)
 *
 * See `.lovable/plan.md` for the phased rollout.
 */

export { formatAda, formatUsd, sparkline, lovelaceToAda } from "@/lib/format";

export type RiskProfile = "Conservative" | "Moderate" | "Aggressive";
export type AssetCategory =
  | "Sustainable Farming"
  | "Clean Energy"
  | "Real Estate"
  | "Carbon Credits"
  | "Infrastructure";

export interface Asset {
  id: string;
  name: string;
  category: AssetCategory;
  apy: number;
  risk: RiskProfile;
  fundedPct: number;
  targetAda: number;
  maturityMonths: number;
  esgRating: "AAA" | "AA" | "A" | "BBB";
  minInvestmentAda: number;
  description: string;
  location: string;
  issuer: string;
}

export interface Investment {
  assetId: string;
  amountAda: number;
  entryDate: string;
  currentValueAda: number;
  yieldEarnedAda: number;
}

export interface Proposal {
  id: string;
  title: string;
  status: "Voting" | "Executed" | "Defeated" | "Queued";
  category: "Treasury" | "Protocol" | "Listing" | "Risk";
  forPct: number;
  againstPct: number;
  quorumPct: number;
  endsIn: string;
  author: string;
}

/** Empty by design. Query the real `assets` table instead. */
export const ASSETS: Asset[] = [];

/** Empty by design. Query `vault_positions` for the connected wallet. */
export const PORTFOLIO: Investment[] = [];

/** Empty by design. Query the real `governance_proposals` table. */
export const PROPOSALS: Proposal[] = [];

/** Empty by design. Query `transactions` filtered by kind. */
export const VAULT_ACTIVITY: Array<{
  id: number | string;
  kind: string;
  asset: string;
  amount: string;
  who: string;
  time: string;
}> = [];
