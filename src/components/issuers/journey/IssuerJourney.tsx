import { Check, Clock, Lock, LockOpen, AlertCircle, CircleDashed, ServerCog, Scale, XCircle } from "lucide-react";
import type { JourneyStage, JourneyStatus } from "./journey";

const META: Record<JourneyStatus, { label: string; cls: string; dot: string; Icon: typeof Check }> = {
  complete: { label: "Complete", cls: "border-success/30 bg-success/10 text-success", dot: "border-success bg-success text-success-foreground", Icon: Check },
  in_progress: { label: "In progress", cls: "border-teal/30 bg-teal/10 text-teal", dot: "border-teal bg-teal text-primary-foreground", Icon: Clock },
  action_required: { label: "Action required", cls: "border-gold/50 bg-gold/15 text-foreground", dot: "border-gold bg-gold text-foreground", Icon: AlertCircle },
  rejected: { label: "Rejected", cls: "border-destructive/30 bg-destructive/10 text-destructive", dot: "border-destructive bg-destructive text-destructive-foreground", Icon: XCircle },
  not_started: { label: "Not started", cls: "border-border bg-muted text-muted-foreground", dot: "border-border bg-card text-muted-foreground", Icon: CircleDashed },
  awaiting_backend: { label: "Waiting for backend", cls: "border-border bg-muted text-muted-foreground", dot: "border-border bg-muted text-muted-foreground", Icon: ServerCog },
  awaiting_legal: { label: "Waiting for legal approval", cls: "border-border bg-muted text-muted-foreground", dot: "border-border bg-muted text-muted-foreground", Icon: Scale },
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";

export function JourneyStatusBadge({ status }: { status: JourneyStatus }) {
  const m = META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      <m.Icon className="h-3 w-3" aria-hidden="true" /> {m.label}
    </span>
  );
}

/** Read-only vertical timeline. It renders server decisions; it cannot change them. */
export function IssuerJourney({ stages }: { stages: JourneyStage[] }) {
  return (
    <ol className="relative">
      {stages.map((s, i) => {
        const m = META[s.status];
        return (
          <li key={s.key} className="relative pb-8 pl-12 last:pb-0">
            {i < stages.length - 1 && <span className="absolute left-[15px] top-8 h-full w-px bg-border" aria-hidden="true" />}
            <span className={`absolute left-0 top-0 grid h-8 w-8 place-items-center rounded-full border text-xs font-semibold ${m.dot}`} aria-hidden="true">
              {s.status === "complete" ? <Check className="h-4 w-4" /> : i + 1}
            </span>
            {s.gate && (
              <p
                className={`mb-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${s.gate.passed ? "border-success/40 bg-success/10 text-success" : "border-gold/40 bg-gold/10 text-foreground"}`}
              >
                {s.gate.passed ? <LockOpen className="h-3 w-3" aria-hidden="true" /> : <Lock className="h-3 w-3 text-gold" aria-hidden="true" />}
                {s.gate.label} · {s.gate.passed === true ? "passed" : s.gate.passed === false ? "not passed" : "not decided"}
              </p>
            )}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-base font-semibold text-foreground">{s.title}</h3>
                <JourneyStatusBadge status={s.status} />
              </div>
              <p className="mt-2 text-sm text-foreground">{s.actions}</p>
              <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Evidence required</dt>
                  <dd className="text-foreground">{s.evidence}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Reviewer</dt>
                  <dd className="text-foreground">{s.reviewer ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Submitted</dt>
                  <dd className="text-foreground">{fmt(s.submitted)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Reviewed</dt>
                  <dd className="text-foreground">{fmt(s.reviewed)}</dd>
                </div>
              </dl>
              {s.outstanding.length > 0 && (
                <div className="mt-3 rounded-lg bg-secondary/60 px-3 py-2 text-xs">
                  <p className="font-medium text-foreground">Outstanding</p>
                  <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                    {s.outstanding.map((o) => (
                      <li key={o}>{o}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
