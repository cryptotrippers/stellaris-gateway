import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { PROPOSAL_COLUMNS, type ProposalRow } from "@/lib/governance-vault.shared";
import { castVote, getMyVotes, getProposalTallies } from "@/lib/governance-votes.functions";
import { getTxChainTimes, type TxChainTime } from "@/lib/governance-chain.functions";
import type { VoteChoice } from "@/lib/governance-votes.shared";

/** Proposals, live tallies, the caller's ballots, and chain execution times. */
export function useGovernanceData() {
  const queryClient = useQueryClient();
  const { user } = useSupabaseUser();
  const [voteError, setVoteError] = useState<string | null>(null);
  const [votingId, setVotingId] = useState<string | null>(null);

  const proposalsQ = useQuery({
    queryKey: ["governance", "proposals"],
    queryFn: async (): Promise<ProposalRow[]> => {
      const { data, error } = await supabase
        .from("governance_proposals")
        .select(PROPOSAL_COLUMNS)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ProposalRow[];
    },
    staleTime: 30_000,
  });

  const talliesQ = useQuery({
    queryKey: ["governance", "tallies"],
    queryFn: () => getProposalTallies(),
    staleTime: 15_000,
  });

  const myVotesQ = useQuery({
    queryKey: ["governance", "my-votes", user?.id ?? null],
    queryFn: () => getMyVotes(),
    enabled: Boolean(user),
    staleTime: 15_000,
  });

  const executedHashes = useMemo(
    () => (proposalsQ.data ?? []).map((p) => p.executed_tx_hash).filter((h): h is string => Boolean(h)),
    [proposalsQ.data],
  );

  const chainTimesQ = useQuery({
    queryKey: ["governance", "chain-times", executedHashes.join(",")],
    queryFn: () => getTxChainTimes({ data: { txHashes: executedHashes } }),
    enabled: executedHashes.length > 0,
    staleTime: 5 * 60_000,
  });

  const chainTimes = useMemo(() => {
    const map: Record<string, TxChainTime> = {};
    for (const t of chainTimesQ.data ?? []) map[t.txHash] = t;
    return map;
  }, [chainTimesQ.data]);

  const voteMutation = useMutation({
    mutationFn: (vars: { proposalId: string; choice: VoteChoice }) => castVote({ data: vars }),
    onMutate: (vars) => {
      setVoteError(null);
      setVotingId(vars.proposalId);
    },
    onSuccess: (res) => {
      if (!res.ok) setVoteError(res.reason);
      queryClient.invalidateQueries({ queryKey: ["governance", "tallies"] });
      queryClient.invalidateQueries({ queryKey: ["governance", "my-votes"] });
    },
    onError: (e: Error) => setVoteError(e.message),
    onSettled: () => setVotingId(null),
  });

  return {
    user,
    signedIn: Boolean(user),
    proposals: proposalsQ.data ?? [],
    proposalsLoading: proposalsQ.isLoading,
    proposalsError: proposalsQ.error as Error | null,
    tallies: talliesQ.data ?? {},
    talliesLoading: talliesQ.isLoading,
    myVotes: myVotesQ.data ?? {},
    chainTimes,
    votingId,
    voteError,
    vote: (proposalId: string, choice: VoteChoice) => voteMutation.mutate({ proposalId, choice }),
  };
}
