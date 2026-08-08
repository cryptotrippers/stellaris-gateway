/**
 * Quorum and approval rules for SIPs.
 *
 * These are protocol parameters, stated in one place so the detail page, the
 * proposal list and any future on-chain finalisation all read the same rule.
 * Nothing here invents numbers: the eligible weight is the sum of verified
 * vault positions, computed server-side.
 */

import type { ProposalTally } from "./governance-votes.shared";
import { derivedStatus } from "./governance-votes.shared";

/** Share of eligible weight that must participate for the vote to count. */
export const QUORUM_PCT = 20;
/** Share of decisive (for + against) weight required to pass. */
export const APPROVAL_THRESHOLD_PCT = 60;

export type OutcomeVerdict =
  | "pending_start"
  | "in_progress"
  | "quorum_failed"
  | "would_pass"
  | "would_fail"
  | "passed"
  | "rejected"
  | "executed";

export interface ProposalOutcome {
  /** Eligible weight, or null when it could not be read. */
  eligibleAda: number | null;
  /** Weight that participated (for + against + abstain). */
  participatingAda: number;
  /** Participation as a share of eligible weight, or null. */
  participationPct: number | null;
  quorumPct: number;
  /** Weight still needed to reach quorum. */
  quorumShortfallAda: number | null;
  quorumMet: boolean | null;
  approvalPct: number | null;
  thresholdPct: number;
  thresholdMet: boolean;
  verdict: OutcomeVerdict;
  /** One-line, plain-English statement of where the SIP stands. */
  summary: string;
}

export function computeOutcome(
  proposal: { status: string; starts_at: string | null; ends_at: string | null },
  tally: ProposalTally,
  eligibleAda: number | null,
  now = Date.now(),
): ProposalOutcome {
  const status = derivedStatus(proposal, now);
  const participatingAda = tally.weightTotal;
  const participationPct =
    eligibleAda && eligibleAda > 0 ? (participatingAda / eligibleAda) * 100 : null;
  const quorumTargetAda = eligibleAda !== null ? (eligibleAda * QUORUM_PCT) / 100 : null;
  const quorumShortfallAda =
    quorumTargetAda !== null ? Math.max(0, quorumTargetAda - participatingAda) : null;
  const quorumMet = quorumShortfallAda === null ? null : quorumShortfallAda <= 0;
  const approvalPct = tally.forPct;
  const thresholdMet = approvalPct !== null && approvalPct >= APPROVAL_THRESHOLD_PCT;

  let verdict: OutcomeVerdict;
  if (status === "executed") verdict = "executed";
  else if (status === "passed") verdict = "passed";
  else if (status === "rejected") verdict = "rejected";
  else if (status === "draft") verdict = "pending_start";
  else if (status === "voting_open") verdict = "in_progress";
  else if (quorumMet === false) verdict = "quorum_failed";
  else verdict = thresholdMet ? "would_pass" : "would_fail";

  return {
    eligibleAda,
    participatingAda,
    participationPct,
    quorumPct: QUORUM_PCT,
    quorumShortfallAda,
    quorumMet,
    approvalPct,
    thresholdPct: APPROVAL_THRESHOLD_PCT,
    thresholdMet,
    verdict,
    summary: summarise(verdict, quorumMet, approvalPct),
  };
}

function pct(n: number | null): string {
  return n === null ? "—" : `${n.toFixed(1)}%`;
}

function summarise(
  verdict: OutcomeVerdict,
  quorumMet: boolean | null,
  approvalPct: number | null,
): string {
  switch (verdict) {
    case "executed":
      return "Executed on chain. The transaction below is the authoritative record.";
    case "passed":
      return "Finalised as passed. Awaiting or already carried out by the operator committee.";
    case "rejected":
      return "Finalised as rejected. No on-chain action will be taken.";
    case "pending_start":
      return "Voting has not opened yet, so no ballots count toward quorum.";
    case "in_progress":
      return quorumMet === true
        ? `Voting is open and quorum is already met. Approval currently sits at ${pct(approvalPct)}.`
        : "Voting is open. Quorum has not been reached yet, so the result is not yet binding.";
    case "quorum_failed":
      return "The voting window closed below quorum, so the SIP deactivates without effect.";
    case "would_pass":
      return `Voting closed with quorum met and ${pct(approvalPct)} approval — above threshold. Pending committee finalisation.`;
    default:
      return `Voting closed with quorum met but only ${pct(approvalPct)} approval — below threshold. Pending committee finalisation.`;
  }
}

export const VERDICT_LABEL: Record<OutcomeVerdict, string> = {
  pending_start: "Not yet open",
  in_progress: "Voting open",
  quorum_failed: "Deactivated — quorum not met",
  would_pass: "Provisionally passing",
  would_fail: "Provisionally failing",
  passed: "Passed",
  rejected: "Rejected",
  executed: "Executed on chain",
};

export const VERDICT_TONE: Record<OutcomeVerdict, "accent" | "success" | "destructive" | "primary"> = {
  pending_start: "primary",
  in_progress: "accent",
  quorum_failed: "destructive",
  would_pass: "success",
  would_fail: "destructive",
  passed: "success",
  rejected: "destructive",
  executed: "success",
};
