/**
 * Shared vote types and tally maths for governance.
 *
 * Kept out of the `.functions.ts` module so that file stays a thin
 * server-function wrapper (runtime siblings there are stripped when handler
 * bodies are split out of the client bundle).
 */

export const VOTE_CHOICES = ["for", "against", "abstain"] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

export interface VoteRow {
  proposal_id: string;
  voter_user_id: string;
  choice: VoteChoice;
  weight_ada: number;
  created_at: string;
  updated_at: string;
}

export interface ProposalTally {
  proposalId: string;
  /** Weighted totals, in ADA of verified vault position at the time of voting. */
  weightFor: number;
  weightAgainst: number;
  weightAbstain: number;
  weightTotal: number;
  /** Head counts, including voters whose weight was zero. */
  countFor: number;
  countAgainst: number;
  countAbstain: number;
  countTotal: number;
  /** Voters with no vault position — recorded, but not counted in the weight. */
  countUnweighted: number;
  /** Percentage of *weighted* for/against, or null when nothing is weighted. */
  forPct: number | null;
  againstPct: number | null;
}

export function emptyTally(proposalId: string): ProposalTally {
  return {
    proposalId,
    weightFor: 0,
    weightAgainst: 0,
    weightAbstain: 0,
    weightTotal: 0,
    countFor: 0,
    countAgainst: 0,
    countAbstain: 0,
    countTotal: 0,
    countUnweighted: 0,
    forPct: null,
    againstPct: null,
  };
}

/** Fold raw vote rows into per-proposal tallies. */
export function tallyVotes(rows: VoteRow[]): Record<string, ProposalTally> {
  const out: Record<string, ProposalTally> = {};
  for (const row of rows) {
    const t = (out[row.proposal_id] ??= emptyTally(row.proposal_id));
    const w = Number(row.weight_ada) || 0;
    t.countTotal += 1;
    if (w <= 0) t.countUnweighted += 1;
    if (row.choice === "for") {
      t.countFor += 1;
      t.weightFor += w;
    } else if (row.choice === "against") {
      t.countAgainst += 1;
      t.weightAgainst += w;
    } else {
      t.countAbstain += 1;
      t.weightAbstain += w;
    }
  }
  for (const t of Object.values(out)) {
    // Abstentions carry weight for quorum purposes but not for the outcome.
    const decisive = t.weightFor + t.weightAgainst;
    t.weightTotal = decisive + t.weightAbstain;
    t.forPct = decisive > 0 ? (t.weightFor / decisive) * 100 : null;
    t.againstPct = decisive > 0 ? (t.weightAgainst / decisive) * 100 : null;
  }
  return out;
}

export type DerivedStatus =
  | "draft"
  | "voting_open"
  | "awaiting_finalisation"
  | "passed"
  | "rejected"
  | "executed";

/**
 * Derive what a proposal's state actually is right now, rather than trusting
 * a stored label that nothing keeps up to date. An `active` proposal whose
 * voting window has closed is awaiting finalisation, not still open.
 */
export function derivedStatus(
  proposal: { status: string; starts_at: string | null; ends_at: string | null },
  now = Date.now(),
): DerivedStatus {
  if (proposal.status === "executed") return "executed";
  if (proposal.status === "passed") return "passed";
  if (proposal.status === "rejected") return "rejected";
  if (proposal.status === "draft") return "draft";
  const startsAt = proposal.starts_at ? Date.parse(proposal.starts_at) : null;
  const endsAt = proposal.ends_at ? Date.parse(proposal.ends_at) : null;
  if (startsAt !== null && now < startsAt) return "draft";
  if (endsAt !== null && now >= endsAt) return "awaiting_finalisation";
  return "voting_open";
}

export const DERIVED_STATUS_LABEL: Record<DerivedStatus, string> = {
  draft: "Draft",
  voting_open: "Voting open",
  awaiting_finalisation: "Awaiting finalisation",
  passed: "Passed",
  rejected: "Rejected",
  executed: "Executed on chain",
};

/** Whether a ballot may still be cast or changed. */
export function votingIsOpen(
  proposal: { status: string; starts_at: string | null; ends_at: string | null },
  now = Date.now(),
): boolean {
  return derivedStatus(proposal, now) === "voting_open";
}

/** "3d 4h left" / "closed" style countdown against the voting deadline. */
export function timeUntil(iso: string | null, now = Date.now()): string {
  if (!iso) return "no deadline set";
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "no deadline set";
  if (ms <= 0) return "closed";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}
