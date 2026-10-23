import type { PipelineStage } from "@/lib/accelerator.shared";

/** Public pipeline vocabulary. Rejected or withdrawn applications are never shown publicly. */
export const PUBLIC_STAGES = [
  {
    key: "initial_review",
    label: "Under Initial Review",
    blurb: "Submitted; no evidence reviewed yet.",
  },
  { key: "due_diligence", label: "Due Diligence", blurb: "Evidence is being reviewed." },
  { key: "awaiting_decision", label: "Awaiting Decision", blurb: "In front of a governance vote." },
  {
    key: "preparing_offering",
    label: "Preparing Offering",
    blurb: "Approved on testnet; no vault yet.",
  },
  {
    key: "funding_open",
    label: "Funding Open (testnet)",
    blurb: "Vault live on Preprod — test deposits only.",
  },
  { key: "operating", label: "Operating", blurb: "On-chain accruals recorded (test ADA)." },
  { key: "completed", label: "Completed", blurb: "Exited under its terms." },
] as const;

export type PublicStageKey = (typeof PUBLIC_STAGES)[number]["key"];

export function publicStage(stage: PipelineStage): PublicStageKey | null {
  switch (stage) {
    case "submitted":
      return "initial_review";
    case "verifying":
      return "due_diligence";
    case "proposed":
      return "awaiting_decision";
    case "approved":
      return "preparing_offering";
    case "vault_live":
      return "funding_open";
    case "reporting":
      return "operating";
    case "rejected":
      return null;
  }
}
