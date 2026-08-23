/**
 * Accelerator toolkit — shared, browser-safe types and pure derivations.
 *
 * Lives outside `accelerator.functions.ts` because server-function modules may
 * only contain imports, types and server-function declarations.
 *
 * Nothing here invents data: every number is derived from rows the caller
 * already has, and a project with no checklist scores zero.
 */

export type ChecklistStatus = "missing" | "submitted" | "verified" | "rejected";

export interface ChecklistItemDef {
  key: string;
  label: string;
  hint: string;
  /** Required items are the denominator of the readiness score. */
  required: boolean;
}

/** The fixed verification checklist every funding request is measured against. */
export const CHECKLIST_ITEMS: ChecklistItemDef[] = [
  {
    key: "legal_wrapper",
    label: "Legal wrapper",
    hint: "Incorporation or SPV documents for the entity that will hold the asset.",
    required: true,
  },
  {
    key: "asset_title",
    label: "Asset title or lease",
    hint: "Proof the entity owns, or has long-term rights to, the underlying asset.",
    required: true,
  },
  {
    key: "operating_licence",
    label: "Operating licence",
    hint: "Permit or licence allowing the asset to operate in its jurisdiction.",
    required: true,
  },
  {
    key: "insurance",
    label: "Insurance",
    hint: "Cover for the physical asset and its operation.",
    required: false,
  },
  {
    key: "offtake_agreement",
    label: "Offtake / revenue agreement",
    hint: "The contract that actually produces the yield depositors are promised.",
    required: true,
  },
  {
    key: "technical_audit",
    label: "Technical audit",
    hint: "Independent engineering or condition report on the asset.",
    required: false,
  },
  {
    key: "impact_methodology",
    label: "Impact methodology",
    hint: "How impact metrics are measured, by whom, and how often.",
    required: true,
  },
];

export const REQUIRED_ITEM_KEYS = CHECKLIST_ITEMS.filter((i) => i.required).map((i) => i.key);

/** Readiness threshold below which promoting to a vote shows a warning. */
export const READINESS_WARN_BELOW = 80;

export interface ChecklistRow {
  id: string;
  funding_request_id: string;
  item_key: string;
  status: ChecklistStatus;
  evidence_url: string | null;
  note: string | null;
  verified_at: string | null;
}

export interface IssuerRow {
  id: string;
  legal_name: string;
  jurisdiction: string;
  registration_number: string | null;
  contact_email: string | null;
  website: string | null;
  wrapper_type: string;
  verification_status: "unverified" | "pending" | "verified" | "rejected";
  verified_at: string | null;
  created_at: string;
}

export interface ImpactMetricRow {
  id: string;
  metric_name: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  measurement_method: string | null;
}

export interface ImpactAttestationRow {
  id: string;
  funding_request_id: string;
  attester: string;
  methodology: string;
  reporting_cadence: string;
  evidence_url: string | null;
  published: boolean;
  created_at: string;
  metrics: ImpactMetricRow[];
}

/** Percentage of REQUIRED checklist items that an admin has verified. */
export function readinessScore(rows: Pick<ChecklistRow, "item_key" | "status">[]): number {
  if (REQUIRED_ITEM_KEYS.length === 0) return 0;
  const verified = REQUIRED_ITEM_KEYS.filter((k) =>
    rows.some((r) => r.item_key === k && r.status === "verified"),
  ).length;
  return Math.round((verified / REQUIRED_ITEM_KEYS.length) * 100);
}

export type PipelineStage =
  | "submitted"
  | "verifying"
  | "proposed"
  | "approved"
  | "vault_live"
  | "reporting"
  | "rejected";

export const PIPELINE_STAGES: { key: PipelineStage; label: string; blurb: string }[] = [
  { key: "submitted", label: "Submitted", blurb: "A claim, nothing verified yet" },
  { key: "verifying", label: "Verifying", blurb: "Evidence under review" },
  { key: "proposed", label: "Proposed", blurb: "In front of governance" },
  { key: "approved", label: "Approved", blurb: "Voted through, no vault yet" },
  { key: "vault_live", label: "Vault live", blurb: "On-chain and open to deposits" },
  { key: "reporting", label: "Reporting", blurb: "Yield accrued on chain" },
];

export function deriveStage(input: {
  status: string;
  proposalId: string | null;
  checklist: Pick<ChecklistRow, "item_key" | "status">[];
  vaultBootstrapped: boolean;
  hasAccruals: boolean;
}): PipelineStage {
  if (input.status === "rejected") return "rejected";
  if (input.hasAccruals) return "reporting";
  if (input.vaultBootstrapped) return "vault_live";
  if (input.status === "asset_created") return "approved";
  if (input.proposalId) return "proposed";
  if (input.checklist.some((c) => c.status !== "missing")) return "verifying";
  return "submitted";
}

export interface PipelineProject {
  fundingRequestId: string;
  slug: string;
  name: string;
  category: string;
  issuerName: string;
  issuer: IssuerRow | null;
  location: string | null;
  targetLovelace: number;
  minDepositLovelace: number;
  proposedFeeBps: number;
  maturityMonths: number | null;
  status: string;
  proposalId: string | null;
  assetId: string | null;
  stage: PipelineStage;
  readiness: number;
  checklist: ChecklistRow[];
  attestedMetrics: number;
  /** On-chain vault script address once bootstrapped, else null. */
  vaultAddress: string | null;
  vaultBootstrappedAt: string | null;
  createdAt: string;
}

export interface PipelineSummary {
  projects: number;
  verifiedIssuers: number;
  liveVaults: number;
  attestedMetrics: number;
  /** Lovelace recorded against on-chain accruals; 0 when nothing has accrued. */
  accountedLovelace: number;
  generatedAt: string;
}
