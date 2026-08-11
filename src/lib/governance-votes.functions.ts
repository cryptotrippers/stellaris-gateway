/**
 * Voting for governance proposals.
 *
 * Weight is never supplied by the browser: the server reads the caller's own
 * vault positions and stores the weight it computed on the vote row, so a
 * recount later is reproducible. A voter with no position can still record a
 * choice, but it lands with zero weight and is reported separately as a
 * non-binding signal.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import {
  VOTE_CHOICES,
  tallyVotes,
  votingIsOpen,
  type ProposalTally,
  type VoteChoice,
  type VoteRow,
} from "./governance-votes.shared";

export type { ProposalTally, VoteChoice } from "./governance-votes.shared";

/**
 * Public, aggregated tallies. No voter identity is ever returned.
 * Individual ballots are not readable by anon/authenticated roles (RLS), so the
 * aggregation is done server-side with the service-role client and only the
 * aggregate leaves this handler.
 */
export const getProposalTallies = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<string, ProposalTally>> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("proposal_votes")
      .select("proposal_id, voter_user_id, choice, weight_ada, created_at, updated_at");
    if (error) throw new Error(error.message);
    return tallyVotes((data ?? []) as unknown as VoteRow[]);
  },
);

/** The caller's own ballots, keyed by proposal id. */
export const getMyVotes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({ context }): Promise<Record<string, { choice: VoteChoice; weightAda: number }>> => {
      const { data, error } = await context.supabase
        .from("proposal_votes")
        .select("proposal_id, choice, weight_ada")
        .eq("voter_user_id", context.userId);
      if (error) throw new Error(error.message);
      const out: Record<string, { choice: VoteChoice; weightAda: number }> = {};
      for (const row of data ?? []) {
        out[row.proposal_id as string] = {
          choice: row.choice as VoteChoice,
          weightAda: Number(row.weight_ada) || 0,
        };
      }
      return out;
    },
  );

/** The voting weight the caller would carry on a given asset's proposal. */
export const getMyVotingWeight = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { assetId?: string | null }) => ({ assetId: data?.assetId ?? null }))
  .handler(async ({ data, context }): Promise<{ weightAda: number; positions: number }> => {
    let query = context.supabase
      .from("vault_positions")
      .select("amount_ada, vault_id")
      .eq("user_id", context.userId);
    if (data.assetId) query = query.eq("vault_id", data.assetId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    const weightAda = (rows ?? []).reduce((sum, r) => sum + (Number(r.amount_ada) || 0), 0);
    return { weightAda, positions: (rows ?? []).length };
  });

/**
 * Cast or change a ballot. Rejected outside the voting window; the weight is
 * derived server-side from the caller's verified vault positions.
 */
export const castVote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { proposalId: string; choice: VoteChoice }) => {
    if (!data?.proposalId) throw new Error("A proposal id is required.");
    if (!VOTE_CHOICES.includes(data?.choice)) throw new Error("Unknown vote choice.");
    return { proposalId: data.proposalId, choice: data.choice };
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; reason: string; weightAda: number }> => {
    const { data: proposal, error: pErr } = await context.supabase
      .from("governance_proposals")
      .select("id, asset_id, status, starts_at, ends_at")
      .eq("id", data.proposalId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!proposal) return { ok: false, reason: "Proposal not found.", weightAda: 0 };

    if (!votingIsOpen(proposal as never)) {
      return { ok: false, reason: "Voting on this proposal is not open.", weightAda: 0 };
    }

    const assetId = (proposal.asset_id as string | null) ?? null;
    let posQuery = context.supabase
      .from("vault_positions")
      .select("amount_ada, vault_id")
      .eq("user_id", context.userId);
    if (assetId) posQuery = posQuery.eq("vault_id", assetId);
    const { data: positions, error: posErr } = await posQuery;
    if (posErr) throw new Error(posErr.message);

    const weightAda = (positions ?? []).reduce((sum, r) => sum + (Number(r.amount_ada) || 0), 0);

    const { error } = await context.supabase.from("proposal_votes").upsert(
      {
        proposal_id: data.proposalId,
        voter_user_id: context.userId,
        choice: data.choice,
        weight_ada: weightAda,
        asset_id: assetId,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "proposal_id,voter_user_id" },
    );
    if (error) throw new Error(error.message);

    return {
      ok: true,
      reason:
        weightAda > 0
          ? "Vote recorded."
          : "Vote recorded as a non-binding signal — you hold no vault position on this proposal.",
      weightAda,
    };
  });
