import { useState } from "react";
import { ChevronDown, ExternalLink, Check, Loader2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/StatusBadge";
import { cardanoscanTx, short } from "@/lib/chain-format";
import { proposalKindLabel, type ProposalRow } from "@/lib/governance-vault.shared";
import {
  DERIVED_STATUS_LABEL,
  derivedStatus,
  emptyTally,
  timeUntil,
  type DerivedStatus,
  type ProposalTally,
  type VoteChoice,
} from "@/lib/governance-votes.shared";
import type { TxChainTime } from "@/lib/governance-chain.functions";

const STATUS_TONE: Record<DerivedStatus, "accent" | "success" | "destructive" | "primary"> = {
  draft: "primary",
  voting_open: "accent",
  awaiting_finalisation: "primary",
  passed: "success",
  rejected: "destructive",
  executed: "success",
};

function fmtAda(n: number): string {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADA`;
}

function fmtDateTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : "—";
}

export interface ProposalCardProps {
  proposal: ProposalRow;
  tally: ProposalTally | undefined;
  talliesLoading: boolean;
  myVote: { choice: VoteChoice; weightAda: number } | undefined;
  myWeightAda: number | null;
  signedIn: boolean;
  chainTime: TxChainTime | undefined;
  voting: boolean;
  voteError: string | null;
  onVote: (choice: VoteChoice) => void;
}

export function ProposalCard(props: ProposalCardProps) {
  const { proposal: p, tally: rawTally, talliesLoading, myVote, myWeightAda, signedIn, chainTime } = props;
  const [open, setOpen] = useState(false);
  const tally = rawTally ?? emptyTally(p.id);
  const status = derivedStatus(p);
  const canVote = status === "voting_open";

  return (
    <div className="card-institutional p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{p.sip_number}</span>
            <span className="rounded-full border border-border px-2 py-0.5">{proposalKindLabel(p.kind)}</span>
            {p.asset_id && (
              <span className="rounded-full border border-border px-2 py-0.5 font-mono">{p.asset_id}</span>
            )}
          </div>
          <h3 className="mt-1 text-base font-semibold text-foreground">{p.title}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={STATUS_TONE[status]}>{DERIVED_STATUS_LABEL[status]}</Badge>
          <span className="text-xs text-muted-foreground">
            {status === "voting_open" ? timeUntil(p.ends_at) : p.ends_at ? `Closed ${new Date(p.ends_at).toLocaleDateString()}` : "No deadline set"}
          </span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </div>
      </button>

      {/* Tally — always visible */}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <VoteBar
          label="For"
          pct={tally.forPct}
          weight={tally.weightFor}
          count={tally.countFor}
          tone="success"
          loading={talliesLoading}
        />
        <VoteBar
          label="Against"
          pct={tally.againstPct}
          weight={tally.weightAgainst}
          count={tally.countAgainst}
          tone="destructive"
          loading={talliesLoading}
        />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        {tally.countTotal === 0
          ? talliesLoading
            ? "Loading ballots…"
            : "No ballots cast yet — nothing has been voted on this proposal."
          : `${tally.countTotal} ballot${tally.countTotal === 1 ? "" : "s"} · ${fmtAda(tally.weightTotal)} of verified vault position` +
            (tally.countAbstain > 0 ? ` · ${tally.countAbstain} abstain` : "") +
            (tally.countUnweighted > 0 ? ` · ${tally.countUnweighted} unweighted signal${tally.countUnweighted === 1 ? "" : "s"}` : "")}
      </div>

      {open && (
        <div className="mt-5 space-y-5 border-t border-border pt-5">
          {p.body ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{p.body}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">No rationale was submitted with this proposal.</p>
          )}

          {Object.keys(p.params ?? {}).length > 0 && (
            <div className="rounded-lg border border-border bg-secondary/20 p-3">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">On-chain parameters</div>
              <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
                {Object.entries(p.params ?? {}).map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all font-mono text-foreground">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <Timeline proposal={p} chainTime={chainTime} />

          <VotePanel
            canVote={canVote}
            signedIn={signedIn}
            status={status}
            myVote={myVote}
            myWeightAda={myWeightAda}
            voting={props.voting}
            voteError={props.voteError}
            onVote={props.onVote}
          />

          <Link
            to="/governance/$sip"
            params={{ sip: p.sip_number }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          >
            Open full detail — quorum, threshold and execution
          </Link>

          {p.asset_id && (
            <Link
              to="/marketplace/$id"
              params={{ id: p.asset_id }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              View the vault this proposal governs <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Timeline({ proposal: p, chainTime }: { proposal: ProposalRow; chainTime: TxChainTime | undefined }) {
  const rows: Array<{ label: string; value: string; note?: string }> = [
    { label: "Submitted", value: fmtDateTime(Date.parse(p.created_at)) },
    {
      label: "Voting opens",
      value: p.starts_at ? fmtDateTime(Date.parse(p.starts_at)) : "Immediately on submission",
    },
    { label: "Voting closes", value: p.ends_at ? fmtDateTime(Date.parse(p.ends_at)) : "No deadline set" },
  ];

  if (p.executed_tx_hash) {
    rows.push({
      label: "Executed on chain",
      value: chainTime?.found
        ? fmtDateTime(chainTime.blockTime)
        : chainTime
          ? "Transaction not found on Preprod"
          : "Reading block time…",
      note:
        chainTime?.found && chainTime.epoch !== null
          ? `Epoch ${chainTime.epoch} · block ${chainTime.blockHeight}`
          : undefined,
    });
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Timeline</div>
      <dl className="mt-2 space-y-1.5 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="text-right text-foreground">
              {r.value}
              {r.note && <span className="block text-[10px] text-muted-foreground">{r.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {p.executed_tx_hash && (
        <a
          href={cardanoscanTx(p.executed_tx_hash)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
        >
          {short(p.executed_tx_hash)} <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

const CHOICES: Array<{ key: VoteChoice; label: string }> = [
  { key: "for", label: "For" },
  { key: "against", label: "Against" },
  { key: "abstain", label: "Abstain" },
];

function VotePanel({
  canVote,
  signedIn,
  status,
  myVote,
  myWeightAda,
  voting,
  voteError,
  onVote,
}: {
  canVote: boolean;
  signedIn: boolean;
  status: DerivedStatus;
  myVote: { choice: VoteChoice; weightAda: number } | undefined;
  myWeightAda: number | null;
  voting: boolean;
  voteError: string | null;
  onVote: (choice: VoteChoice) => void;
}) {
  if (!canVote) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        {status === "awaiting_finalisation"
          ? "The voting window has closed. The result stands until the committee finalises it."
          : status === "draft"
            ? "Voting has not opened on this proposal yet."
            : "Voting on this proposal is closed."}
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <Link to="/auth" className="font-medium text-primary hover:underline">
          Sign in
        </Link>{" "}
        to vote. Weight is derived from your verified vault positions.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Cast your vote</div>
        <div className="text-[11px] text-muted-foreground">
          {myWeightAda === null
            ? "Reading your position…"
            : myWeightAda > 0
              ? `Your weight: ${fmtAda(myWeightAda)}`
              : "No vault position — your ballot records as a non-binding signal."}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {CHOICES.map((c) => {
          const mine = myVote?.choice === c.key;
          return (
            <button
              key={c.key}
              type="button"
              disabled={voting}
              onClick={() => onVote(c.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-60 ${
                mine
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-foreground hover:bg-secondary"
              }`}
            >
              {voting ? <Loader2 className="h-3 w-3 animate-spin" /> : mine ? <Check className="h-3 w-3" /> : null}
              {c.label}
            </button>
          );
        })}
      </div>
      {myVote && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Recorded: {myVote.choice} at {fmtAda(myVote.weightAda)} weight. You can change it until voting closes.
        </div>
      )}
      {voteError && <div className="mt-2 text-[11px] text-destructive">{voteError}</div>}
    </div>
  );
}

function VoteBar({
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
  tone: "success" | "destructive";
  loading: boolean;
}) {
  const bar = tone === "success" ? "bg-success" : "bg-destructive";
  const text = tone === "success" ? "text-success" : "text-destructive";
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className={`number-display text-sm font-semibold ${text}`}>
          {loading ? "…" : pct === null ? "—" : `${pct.toFixed(1)}%`}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="mt-1.5 text-[10px] text-muted-foreground">
        {fmtAda(weight)} · {count} ballot{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}
