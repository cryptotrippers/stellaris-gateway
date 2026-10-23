import type { ReactNode } from "react";

/**
 * Displays a single stored value. Empty values render "Not published" —
 * never a placeholder number. Formatting only; no calculations.
 */
export function MetricCard({
  label,
  value,
  hint,
  badge,
}: {
  label: string;
  value?: ReactNode | null;
  hint?: string;
  badge?: ReactNode;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {badge}
      </div>
      <p
        className={`mt-2 font-display text-xl font-semibold ${empty ? "text-muted-foreground" : "text-foreground"}`}
      >
        {empty ? "Not published" : value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
