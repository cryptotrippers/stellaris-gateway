import { Check, Lock } from "lucide-react";
import type { ReactNode } from "react";

export type TimelineState = "done" | "current" | "upcoming" | "blocked";

export type TimelineItem = {
  title: string;
  description?: ReactNode;
  state: TimelineState;
  meta?: ReactNode;
  /** Optional gate shown before this step, e.g. "Gate A: Issuer verified". */
  gate?: string;
};

const DOT: Record<TimelineState, string> = {
  done: "bg-success text-success-foreground border-success",
  current: "bg-teal text-primary-foreground border-teal",
  upcoming: "bg-card text-muted-foreground border-border",
  blocked: "bg-muted text-muted-foreground border-border",
};

/** Vertical, read-only timeline. State must come from server data or be "upcoming". */
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative">
      {items.map((it, i) => (
        <li key={it.title} className="relative pb-6 pl-10 last:pb-0">
          {i < items.length - 1 && (
            <span className="absolute left-[13px] top-7 h-full w-px bg-border" aria-hidden="true" />
          )}
          {it.gate && <GateMarker label={it.gate} />}
          <span
            className={`absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold ${DOT[it.state]}`}
            aria-hidden="true"
          >
            {it.state === "done" ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <p className="font-medium text-foreground">
            {it.title}
            <span className="sr-only"> — {it.state}</span>
          </p>
          {it.description && <div className="mt-1 text-sm text-muted-foreground">{it.description}</div>}
          {it.meta && <div className="mt-2">{it.meta}</div>}
        </li>
      ))}
    </ol>
  );
}

export function GateMarker({ label }: { label: string }) {
  return (
    <p className="mb-2 inline-flex items-center gap-1.5 rounded-md border border-gold/40 bg-gold/10 px-2 py-0.5 text-xs font-semibold text-foreground">
      <Lock className="h-3 w-3 text-gold" aria-hidden="true" />
      {label}
    </p>
  );
}
