/**
 * ILLUSTRATIVE EXAMPLE ONLY — "Solar Farm Alpha".
 * Figures supplied in the product brief for explaining the Asset-to-Yield
 * waterfall. They are not a real project, not platform performance and not a
 * forecast. Every surface that shows them must say "Illustrative Example".
 * Derived values below (shares, per-unit amounts) are written out as fixed
 * constants so no component performs financial calculations.
 */
import type {
  AllocationItem,
  DistributionEvent,
  ForecastPoint,
  PerUnitSummaryData,
  Scenario,
  SensitivityRow,
  WaterfallData,
} from "@/components/finance/types";

export const SOLAR_FARM_ALPHA = {
  name: "Solar Farm Alpha",
  currency: "AUD",
  funding: 1_000_000,
  units: 1_000,
  issuePrice: 1_000,
  annualRevenue: 260_000,
  cashDeductions: 140_000,
  reserveContribution: 30_000,
  distributableCash: 90_000,
  distributionPerUnit: 90,
  cashYieldPct: 9,
} as const;

export const ALPHA_WATERFALL: WaterfallData = {
  currency: "AUD",
  period: "One illustrative year",
  steps: [
    {
      key: "revenue",
      label: "Solar project revenue",
      amount: 260_000,
      from: 0,
      to: 260_000,
      kind: "inflow",
      note: "Electricity sold under the project's offtake arrangements.",
    },
    {
      key: "deductions",
      label: "Cash deductions",
      amount: -140_000,
      from: 260_000,
      to: 120_000,
      kind: "deduction",
      note: "Operating expenses, debt service, tax and approved fees, combined in this example.",
    },
    {
      key: "reserve",
      label: "Reserve contribution",
      amount: -30_000,
      from: 120_000,
      to: 90_000,
      kind: "deduction",
      note: "Held back for maintenance and inverter replacement.",
    },
    {
      key: "distributable",
      label: "Net distributable cash",
      amount: 90_000,
      from: 0,
      to: 90_000,
      kind: "result",
      note: "Shared across 1,000 eligible participation units.",
    },
  ],
};

export const ALPHA_ALLOCATION: AllocationItem[] = [
  { key: "deductions", label: "Cash deductions", amount: 140_000, sharePct: 53.8, tone: "deduction" },
  { key: "reserve", label: "Reserve contribution", amount: 30_000, sharePct: 11.5, tone: "reserve" },
  { key: "distributable", label: "Net distributable cash", amount: 90_000, sharePct: 34.6, tone: "distribution" },
];

/** Reserve contribution shown three ways; all derived from the brief's figures. */
export const ALPHA_RESERVE = {
  amount: 30_000,
  shareOfRevenuePct: 11.5,
  perUnit: 30,
};

export const ALPHA_PER_UNIT: PerUnitSummaryData = {
  currency: "AUD",
  units: 1_000,
  unitPrice: 1_000,
  capitalRaised: 1_000_000,
  distributableCash: 90_000,
  distributionPerUnit: 90,
  cashYieldPct: 9,
};

export const ALPHA_BASE_SCENARIO: Scenario = {
  key: "base",
  label: "Base case (illustrative)",
  distributionPerUnit: 90,
  cashYieldPct: 9,
  assumptions: "AUD 260,000 revenue, AUD 140,000 cash deductions, AUD 30,000 reserve.",
};

/** One forecast year and no actual results: this example has no history. */
export const ALPHA_FORECAST: ForecastPoint[] = [{ period: "Year 1", forecast: 90, actual: null }];

export const ALPHA_DISTRIBUTIONS: DistributionEvent[] = [
  { key: "y1", period: "Year 1", date: null, perUnit: 90, total: 90_000, status: "forecast" },
];

/** Sensitivity and alternative scenarios come from the approved engine only. */
export const ALPHA_SENSITIVITY: SensitivityRow[] = [];
export const ALPHA_EXTRA_SCENARIOS: Scenario[] = [];
