import { READINESS_WARN_BELOW } from "@/lib/accelerator.shared";

/** Readiness = share of required checklist items an admin has verified. */
export function ReadinessMeter({
  score,
  compact = false,
}: {
  score: number;
  compact?: boolean;
}) {
  const tone =
    score >= READINESS_WARN_BELOW
      ? "bg-primary"
      : score > 0
        ? "bg-accent"
        : "bg-muted-foreground/40";

  return (
    <div className={compact ? "w-full" : "w-full max-w-sm"}>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Verification readiness</span>
        <span className="tabular-nums text-foreground">{score}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
        <div className={`h-full ${tone}`} style={{ width: `${Math.max(score, 2)}%` }} />
      </div>
    </div>
  );
}
