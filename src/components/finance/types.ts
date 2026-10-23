/**
 * Typed shapes the financial visual components accept. Values arrive already
 * calculated — from the approved calculation service once it exists, or from a
 * fixed illustrative data file. Components only scale and format them.
 */

export type WaterfallStep = {
  key: string;
  label: string;
  /** Signed display amount for the step (negative for deductions). */
  amount: number;
  /** Running total before and after this step, supplied by the data source. */
  from: number;
  to: number;
  kind: "inflow" | "deduction" | "result";
  note?: string;
};

export type WaterfallData = {
  currency: string;
  period: string;
  steps: WaterfallStep[];
};

export type AllocationItem = {
  key: string;
  label: string;
  amount: number;
  /** Share of the parent total, supplied by the data source. */
  sharePct: number;
  tone: "deduction" | "reserve" | "distribution" | "fee";
};

export type PerUnitSummaryData = {
  currency: string;
  units: number;
  unitPrice: number;
  capitalRaised: number;
  distributableCash: number;
  distributionPerUnit: number;
  /** Cash yield on the issue price, as a percentage. */
  cashYieldPct: number;
};

export type DistributionStatus = "forecast" | "approved" | "funded" | "paid";

export type DistributionEvent = {
  key: string;
  period: string;
  date: string | null;
  perUnit: number;
  total: number;
  status: DistributionStatus;
  /** Settlement transaction hash, only for paid distributions. */
  txHash?: string;
};

export type ForecastPoint = {
  period: string;
  forecast: number | null;
  actual: number | null;
};

export type Scenario = {
  key: string;
  label: string;
  distributionPerUnit: number;
  cashYieldPct: number;
  assumptions: string;
};

export type SensitivityRow = {
  key: string;
  driver: string;
  change: string;
  distributionPerUnit: number;
};

/** Proposed escrow lifecycle. Non-operational until a verified backend exists. */
export const ESCROW_STATES = [
  "Subscriptions Open",
  "Funding Deadline Reached",
  "Soft Cap Met",
  "Funding Unsuccessful",
  "Refund Available",
  "Funding Closed",
  "Milestone Pending",
  "Release Approved",
  "Funds Released",
  "Operating",
  "Redeeming",
  "Completed",
] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export type MilestoneRelease = {
  key: string;
  name: string;
  requiredAmount: number;
  currency: string;
  evidenceStatus: "missing" | "submitted" | "verified" | "rejected";
  approvalStatus: "pending" | "approved" | "rejected";
  releasedAmount: number | null;
  txHash: string | null;
  date: string | null;
};
