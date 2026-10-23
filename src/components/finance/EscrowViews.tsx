import { ArrowDown, ArrowRight, ExternalLink } from "lucide-react";
import { cardanoscanTx } from "@/lib/chain-format";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { ESCROW_STATES, type EscrowState, type MilestoneRelease } from "./types";
import { money, shortHash } from "./format";

const FLOW = [
  { title: "Investor subscriptions", body: "Participants subscribe during the offer period." },
  { title: "Escrow", body: "Held until funding conditions are met. Refunded if they are not." },
  { title: "Milestone releases", body: "Released to the project only against approved milestones." },
  { title: "Operating revenue", body: "The asset earns income and pays its costs." },
  { title: "Reserves", body: "Part of the cash is held back for maintenance and shortfalls." },
  { title: "Distributions", body: "Net distributable cash is paid to eligible units." },
];

/** Diagram separating subscriptions, released proceeds, reserves and distributions. */
export function EscrowFlowDiagram() {
  return (
    <figure className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-display text-base font-semibold text-foreground">How capital would move</span>
        <FeatureStatus stage="awaiting_backend" />
      </figcaption>
      <ol className="mt-6 grid gap-3 lg:grid-cols-6">
        {FLOW.map((f, i) => (
          <li key={f.title} className="relative">
            <div className="h-full rounded-xl border border-border bg-secondary/50 p-4">
              <span className="text-[11px] font-semibold text-teal">Step {i + 1}</span>
              <p className="mt-1 text-sm font-semibold text-foreground">{f.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{f.body}</p>
            </div>
            {i < FLOW.length - 1 && (
              <>
                <ArrowDown className="mx-auto my-1 h-4 w-4 text-muted-foreground lg:hidden" aria-hidden="true" />
                <ArrowRight className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-muted-foreground lg:block" aria-hidden="true" />
              </>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        No escrow contract is deployed. Capital would only count as released when a confirmed
        on-chain transaction shows it — never because a record was marked in a database.
      </p>
    </figure>
  );
}

/**
 * Proposed escrow lifecycle. `current` is null until a verified backend
 * reports a state; every state stays visibly non-operational until then.
 */
export function EscrowStatusPanel({ current }: { current: EscrowState | null }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-base font-semibold text-foreground">Escrow status</p>
        <FeatureStatus stage="awaiting_backend" />
      </div>
      <p className="mt-2 text-sm text-foreground">
        Current state:{" "}
        <span className="font-semibold">{current ?? "Not applicable — no escrow is operating"}</span>
      </p>
      <ol className="mt-4 flex flex-wrap gap-2" aria-label="Proposed escrow states">
        {ESCROW_STATES.map((s) => (
          <li
            key={s}
            aria-current={s === current ? "step" : undefined}
            className={`rounded-full border px-2.5 py-1 text-xs ${s === current ? "border-teal bg-teal/10 font-medium text-teal" : "border-dashed border-border text-muted-foreground"}`}
          >
            {s}
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted-foreground">These states are proposed. None of them is operational yet.</p>
    </div>
  );
}

const EVIDENCE_LABEL: Record<MilestoneRelease["evidenceStatus"], string> = {
  missing: "Evidence missing",
  submitted: "Evidence submitted",
  verified: "Evidence verified",
  rejected: "Evidence rejected",
};

export function MilestoneReleaseCard({ m }: { m: MilestoneRelease }) {
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{m.name}</p>
        <span className="text-xs text-muted-foreground">{m.date ?? "No date"}</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Required</dt>
          <dd className="number-display font-medium text-foreground">{money(m.requiredAmount, m.currency)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence</dt>
          <dd className="font-medium text-foreground">{EVIDENCE_LABEL[m.evidenceStatus]}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Approval</dt>
          <dd className="font-medium capitalize text-foreground">{m.approvalStatus}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Released</dt>
          <dd className="number-display font-medium text-foreground">
            {m.releasedAmount != null && m.txHash ? money(m.releasedAmount, m.currency) : "Nothing released"}
          </dd>
        </div>
      </dl>
      {m.txHash && (
        <a href={cardanoscanTx(m.txHash)} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 font-mono text-xs text-teal">
          {shortHash(m.txHash)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </article>
  );
}

export function MilestoneReleaseList({ milestones }: { milestones: MilestoneRelease[] }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-base font-semibold text-foreground">Milestone releases</p>
        <FeatureStatus stage="awaiting_backend" />
      </div>
      {milestones.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No milestones are published. Releases will appear here with their evidence, approval and
          transaction reference once the release service exists.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {milestones.map((m) => (
            <MilestoneReleaseCard key={m.key} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}
