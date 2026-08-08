import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { cardanoscanTx, short } from "@/lib/chain-format";
import { useGovernanceData } from "@/hooks/useGovernanceData";
import { proposalKindLabel, type ProposalRow } from "@/lib/governance-vault.shared";
import {
  DERIVED_STATUS_LABEL,
  derivedStatus,
  emptyTally,
  timeUntil,
  type ProposalTally,
  type VoteChoice,
} from "@/lib/governance-votes.shared";
import {
  VERDICT_LABEL,
  VERDICT_TONE,
  computeOutcome,
  type ProposalOutcome,
} from "@/lib/governance-outcome.shared";
import { getEligibleWeights } from "@/lib/governance-eligibility.functions";
import type { TxChainTime } from "@/lib/governance-chain.functions";

export const Route = createFileRoute("/governance/$sip")({
  head: ({ params }) => {
    const title = `${params.sip.toUpperCase()} — Proposal detail | Stellaris Governance`;
    const description = `Live voting status, quorum and approval thresholds, and on-chain execution record for ${params.sip.toUpperCase()} on the Stellaris protocol.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "article" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: ProposalDetailPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="mx-auto max-w-3xl p-10 text-sm text-destructive">
      Could not load this proposal: {error.message}
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-3xl p-10 text-sm text-muted-foreground">Proposal not found.</div>
  ),
});

function fmtAda(n: number | null): string {
  if (n === null) return "—";
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADA`;
}

function fmtDateTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

function ProposalDetailPage() {
  const { sip } = Route.useParams();
  const gov = useGovernanceData();

  const proposal = useMemo(
    () => gov.proposals.find((p) => p.sip_number.toLowerCase() === sip.toLowerCase()),
    [gov.proposals, sip],
  );

  const eligibleQ = useQuery({
    queryKey: ["governance", "eligible-weights"],
    queryFn: () => getEligibleWeights(),
    staleTime: 60_000,
  });

  if (gov.proposalsLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center text-sm text-muted-foreground">
        <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
        Loading {sip.toUpperCase()}…
      </div>
    );
  }

  if (gov.proposalsError) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-sm text-destructive">
        Could not load proposals: {gov.proposalsError.message}
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16">
        <BackLink />
        <div className="card-institutional mt-4 p-10 text-center text-sm text-muted-foreground">
          No proposal numbered <span className="font-mono text-foreground">{sip.toUpperCase()}</span> exists.
        </div>
      </div>
    );
  }

  const tally: ProposalTally = gov.tallies[proposal.id] ?? emptyTally(proposal.id);
  const eligible = eligibleQ.data
    ? proposal.asset_id
      ? (eligibleQ.data.byAsset[proposal.asset_id] ?? 0)
      : eligibleQ.data.total
    : null;
  const outcome = computeOutcome(proposal, tally, eligible);
  const status = derivedStatus(proposal);
  const chainTime = proposal.executed_tx_hash ? gov.chainTimes[proposal.executed_tx_hash] : undefined;
  const myVote = gov.myVotes[proposal.id];
  const myWeight = gov.weightFor(proposal.asset_id);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <BackLink />

      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{proposal.sip_number}</span>
          <span className="rounded-full border border-border px-2 py-0.5">
            {proposalKindLabel(proposal.kind)}
          </span>
          {proposal.asset_id && (
            <Link
              to="/marketplace/$id"
              params={{ id: proposal.asset_id }}
              className="rounded-full border border-border px-2 py-0.5 font-mono hover:text-foreground"
            >
              {proposal.asset_id}
            </Link>
          )}
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">{proposal.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge tone={VERDICT_TONE[outcome.verdict]}>{VERDICT_LABEL[outcome.verdict]}</Badge>
          <span className="text-xs text-muted-foreground">
            {DERIVED_STATUS_LABEL[status]} ·{" "}
            {status === "voting_open"
              ? timeUntil(proposal.ends_at)
              : proposal.ends_at
                ? `Closed ${new Date(proposal.ends_at).toLocaleString()}`
                : "No deadline set"}
          </span>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{outcome.summary}</p>
      </header>

      <section className="mt-6 grid gap-4 md:grid-cols-2">
        <VotingStatusCard tally={tally} loading={gov.talliesLoading} outcome={outcome} />
        <QuorumCard outcome={outcome} eligibleUnknown={eligibleQ.isLoading} />
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        <ExecutionCard proposal={proposal} outcome={outcome} chainTime={chainTime} />
        <BallotCard
          proposalId={proposal.id}
          canVote={status === "voting_open"}
          statusLabel={DERIVED_STATUS_LABEL[status]}
          signedIn={gov.signedIn}
          myVote={myVote}
          myWeightAda={myWeight}
          voting={gov.votingId === proposal.id}
          voteError={gov.votingId === proposal.id || myVote ? gov.voteError : null}
          onVote={(choice) => gov.vote(proposal.id, choice)}
        />
      </section>

      <section className="card-institutional mt-4 p-5">
        <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Rationale</h2>
        {proposal.body ? (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {proposal.body}
          </p>
        ) : (
          <p className="mt-2 text-sm italic text-muted-foreground">
            No rationale was submitted with this proposal.
          </p>
        )}

        {Object.keys(proposal.params ?? {}).length > 0 && (
          <div className="mt-4 rounded-lg border border-border bg-secondary/20 p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              On-chain parameters
            </div>
            <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
              {Object.entries(proposal.params ?? {}).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="break-all font-mono text-foreground">
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      <section className="card-institutional mt-4 p-5">
        <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Timeline</h2>
        <dl className="mt-2 space-y-1.5 text-xs">
          <TimelineRow label="Submitted" value={fmtDateTime(Date.parse(proposal.created_at))} />
          <TimelineRow
            label="Voting opens"
            value={
              proposal.starts_at ? fmtDateTime(Date.parse(proposal.starts_at)) : "Immediately on submission"
            }
          />
          <TimelineRow
            label="Voting closes"
            value={proposal.ends_at ? fmtDateTime(Date.parse(proposal.ends_at)) : "No deadline set"}
          />
          {proposal.executed_tx_hash && (
            <TimelineRow
              label="Executed on chain"
              value={
                chainTime?.found
                  ? fmtDateTime(chainTime.blockTime)
                  : chainTime
                    ? "Transaction not found on Preprod"
                    : "Reading block time…"
              }
              note={
                chainTime?.found && chainTime.epoch !== null
                  ? `Epoch ${chainTime.epoch} · block ${chainTime.blockHeight}`
                  : undefined
              }
            />
          )}
        </dl>
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/governance"
      search={{ tab: "proposals" }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> All proposals
    </Link>
  );
}

function TimelineRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right text-foreground">
        {value}
        {note && <span className="block text-[10px] text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

function VotingStatusCard({
  tally,
  loading,
  outcome,
}: {
  tally: ProposalTally;
  loading: boolean;
  outcome: ProposalOutcome;
}) {
  return (
    <div className="card-institutional p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Voting status</h2>
      <div className="mt-3 space-y-3">
        <Bar label="For" pct={tally.forPct} weight={tally.weightFor} count={tally.countFor} tone="bg-success" loading={loading} />
        <Bar
          label="Against"
          pct={tally.againstPct}
          weight={tally.weightAgainst}
          count={tally.countAgainst}
          tone="bg-destructive"
          loading={loading}
        />
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Abstain</span>
          <span className="text-foreground">
            {tally.countAbstain} ballot{tally.countAbstain === 1 ? "" : "s"} · {fmtAda(tally.weightAbstain)}
          </span>
        </div>
      </div>
      <div className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
        {tally.countTotal === 0
          ? loading
            ? "Loading ballots…"
            : "No ballots cast yet."
          : `${tally.countTotal} ballot${tally.countTotal === 1 ? "" : "s"} · ${fmtAda(tally.weightTotal)} of verified vault position` +
            (tally.countUnweighted > 0
              ? ` · ${tally.countUnweighted} unweighted signal${tally.countUnweighted === 1 ? "" : "s"}`
              : "")}
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Approval is measured on decisive weight only (for vs against); abstentions count toward quorum,
        never toward the outcome. Current approval: {outcome.approvalPct === null ? "—" : `${outcome.approvalPct.toFixed(1)}%`}.
      </div>
    </div>
  );
}

function Bar({
  label,
  pct,
  weight,
  count,
  tone,
  loading,
}: {
  label: string;
  pct: number | null;
  weight: number;
  count: number;
  tone: string;
  loading: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">
          {loading ? "…" : pct === null ? "—" : `${pct.toFixed(1)}%`}
          <span className="ml-2 text-[10px] text-muted-foreground">
            {count} · {fmtAda(weight)}
          </span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    </div>
  );
}

function QuorumCard({
  outcome,
  eligibleUnknown,
}: {
  outcome: ProposalOutcome;
  eligibleUnknown: boolean;
}) {
  return (
    <div className="card-institutional p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Quorum &amp; threshold</h2>

      <div className="mt-3 space-y-2 text-xs">
        <Row label="Eligible weight" value={eligibleUnknown ? "Reading positions…" : fmtAda(outcome.eligibleAda)} />
        <Row label="Participating weight" value={fmtAda(outcome.participatingAda)} />
        <Row
          label={`Quorum (${outcome.quorumPct}% of eligible)`}
          value={
            outcome.quorumMet === null
              ? "Unknown"
              : outcome.quorumMet
                ? "Met"
                : `Short by ${fmtAda(outcome.quorumShortfallAda)}`
          }
        />
        <Row
          label={`Approval threshold (${outcome.thresholdPct}%)`}
          value={
            outcome.approvalPct === null
              ? "No decisive votes yet"
              : outcome.thresholdMet
                ? `Met — ${outcome.approvalPct.toFixed(1)}%`
                : `Not met — ${outcome.approvalPct.toFixed(1)}%`
          }
        />
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
          <span>Participation</span>
          <span>{outcome.participationPct === null ? "—" : `${outcome.participationPct.toFixed(1)}%`}</span>
        </div>
        <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, outcome.participationPct ?? 0)}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-foreground/60"
            style={{ left: `${outcome.quorumPct}%` }}
            aria-hidden
          />
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          The marker shows the {outcome.quorumPct}% quorum line.
        </div>
      </div>

      {outcome.eligibleAda === 0 && !eligibleUnknown && (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          No verified vault positions exist for this scope yet, so quorum cannot be assessed.
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </div>
  );
}

function ExecutionCard({
  proposal,
  outcome,
  chainTime,
}: {
  proposal: ProposalRow;
  outcome: ProposalOutcome;
  chainTime: TxChainTime | undefined;
}) {
  return (
    <div className="card-institutional p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Outcome &amp; execution</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={VERDICT_TONE[outcome.verdict]}>{VERDICT_LABEL[outcome.verdict]}</Badge>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{outcome.summary}</p>

      {proposal.executed_tx_hash ? (
        <div className="mt-3 space-y-2 text-xs">
          <Row
            label="Execution epoch"
            value={
              proposal.executed_epoch !== null
                ? String(proposal.executed_epoch)
                : chainTime?.epoch !== null && chainTime?.epoch !== undefined
                  ? String(chainTime.epoch)
                  : "—"
            }
          />
          <Row
            label="Block time"
            value={chainTime?.found ? fmtDateTime(chainTime.blockTime) : "Reading block time…"}
          />
          <a
            href={cardanoscanTx(proposal.executed_tx_hash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
          >
            {short(proposal.executed_tx_hash)} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : outcome.verdict === "quorum_failed" ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          Deactivated: the SIP closed below quorum and will not be executed on chain.
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          No execution transaction has been recorded for this proposal yet.
        </div>
      )}
    </div>
  );
}

const CHOICES: Array<{ key: VoteChoice; label: string }> = [
  { key: "for", label: "For" },
  { key: "against", label: "Against" },
  { key: "abstain", label: "Abstain" },
];

function BallotCard({
  canVote,
  statusLabel,
  signedIn,
  myVote,
  myWeightAda,
  voting,
  voteError,
  onVote,
}: {
  proposalId: string;
  canVote: boolean;
  statusLabel: string;
  signedIn: boolean;
  myVote: { choice: VoteChoice; weightAda: number } | undefined;
  myWeightAda: number | null;
  voting: boolean;
  voteError: string | null;
  onVote: (choice: VoteChoice) => void;
}) {
  return (
    <div className="card-institutional p-5">
      <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">Your ballot</h2>

      {myVote && (
        <div className="mt-3 text-xs text-foreground">
          You voted <span className="font-semibold">{myVote.choice}</span> with{" "}
          {fmtAda(myVote.weightAda)} of weight.
        </div>
      )}

      {!canVote ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          Voting is closed on this proposal ({statusLabel.toLowerCase()}).
        </div>
      ) : !signedIn ? (
        <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <Link to="/auth" className="font-medium text-primary hover:underline">
            Sign in
          </Link>{" "}
          to vote. Weight is derived from your verified vault positions.
        </div>
      ) : (
        <>
          <div className="mt-3 text-[11px] text-muted-foreground">
            {myWeightAda === null
              ? "Reading your position…"
              : myWeightAda > 0
                ? `Your weight: ${fmtAda(myWeightAda)}`
                : "No vault position — your ballot records as a non-binding signal."}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {CHOICES.map((c) => (
              <button
                key={c.key}
                type="button"
                disabled={voting}
                onClick={() => onVote(c.key)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  myVote?.choice === c.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}
              >
                {voting && <Loader2 className="h-3 w-3 animate-spin" />}
                {c.label}
              </button>
            ))}
          </div>
        </>
      )}

      {voteError && <div className="mt-3 text-xs text-destructive">{voteError}</div>}
    </div>
  );
}
