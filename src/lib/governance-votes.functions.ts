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

/**
 * The caller's live weight per asset: unspent on-chain Positions owned by
 * wallets the caller has proven with a signed link.
 */
export const getMyWeights = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({ context }): Promise<{ byAsset: Record<string, number>; total: number; linkedWallets: number }> => {
      const w = await import("./governance-weight.server");
      const owners = await w.linkedOwners(context.userId);
      if (owners.size === 0) return { byAsset: {}, total: 0, linkedWallets: 0 };
      const perAsset = await w.liveOwnerWeightsByAsset();
      const byAsset: Record<string, number> = {};
      let total = 0n;
      for (const [assetId, weights] of perAsset) {
        const mine = w.weightsPerUser(weights, owners).get(context.userId) ?? 0n;
        byAsset[assetId] = w.toAda(mine);
        total += mine;
      }
      return { byAsset, total: w.toAda(total), linkedWallets: owners.size };
    },
  );

/** The voting weight the caller would carry on a given asset's proposal, live from chain. */
export const getMyVotingWeight = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { assetId?: string | null }) => ({ assetId: data?.assetId ?? null }))
  .handler(async ({ data, context }): Promise<{ weightAda: number; positions: number }> => {
    const w = await import("./governance-weight.server");
    const owners = await w.linkedOwners(context.userId);
    if (owners.size === 0) return { weightAda: 0, positions: 0 };
    const weights = await w.liveOwnerWeights(data.assetId);
    const mine = w.weightsPerUser(weights, owners).get(context.userId) ?? 0n;
    const positions = [...weights.keys()].filter((k) => owners.has(k)).length;
    return { weightAda: w.toAda(mine), positions };
  });

/**
 * Cast or change a ballot. Rejected outside the voting window. The weight is
 * read live from unspent on-chain Positions of the caller's proven wallets;
 * the stored figure is history only — finalisation recomputes every vote.
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
    const w = await import("./governance-weight.server");
    const owners = await w.linkedOwners(context.userId);
    const weightAda =
      owners.size === 0
        ? 0
        : w.toAda(
            w.weightsPerUser(await w.liveOwnerWeights(assetId), owners).get(context.userId) ?? 0n,
          );

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
          : owners.size === 0
            ? "Vote recorded as a non-binding signal — link your wallet first so your vault positions count."
            : "Vote recorded as a non-binding signal — your linked wallets hold no unspent vault position on this proposal.",
      weightAda,
    };
  });
