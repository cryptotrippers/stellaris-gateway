import type { AllocationItem, WaterfallData } from "./types";
import { money, pct } from "./format";

const BAR: Record<WaterfallData["steps"][number]["kind"], string> = {
  inflow: "bg-primary",
  deduction: "bg-gold",
  result: "bg-teal",
};

/**
 * Horizontal revenue-to-distribution waterfall. Running totals come from the
 * data source; the component only positions bars on a shared scale.
 */
export function YieldWaterfall({ data, title = "Revenue waterfall" }: { data: WaterfallData; title?: string }) {
  const max = Math.max(1, ...data.steps.map((s) => Math.max(s.from, s.to)));
  return (
    <figure className="relative rounded-2xl border border-border bg-card p-5 md:p-6">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-base font-semibold text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">
          {data.currency} · {data.period}
        </span>
      </figcaption>
      <ol className="mt-6 space-y-4" aria-hidden="true">
        {data.steps.map((s, i) => {
          const lo = Math.min(s.from, s.to);
          const hi = Math.max(s.from, s.to);
          return (
            <li key={s.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium text-foreground">{s.label}</span>
                <span className={`number-display font-semibold ${s.kind === "deduction" ? "text-muted-foreground" : "text-foreground"}`}>
                  {s.kind === "deduction" ? "−" : ""}
                  {money(Math.abs(s.amount), data.currency)}
                </span>
              </div>
              <div className="relative mt-2 h-7 rounded-md bg-secondary/70">
                <div
                  className={`absolute inset-y-0 rounded-md ${BAR[s.kind]} transition-[width] duration-700 motion-reduce:transition-none`}
                  style={{ left: `${(lo / max) * 100}%`, width: `${Math.max(0.5, ((hi - lo) / max) * 100)}%` }}
                />
              </div>
              {s.note && <p className="mt-1 text-xs text-muted-foreground">{s.note}</p>}
              {i < data.steps.length - 1 && (
                <div className="ml-2 mt-2 h-3 w-px bg-border" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
      <div className="sr-only">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Step</th>
            <th>Amount ({data.currency})</th>
            <th>Running total</th>
          </tr>
        </thead>
        <tbody>
          {data.steps.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>{s.amount}</td>
              <td>{s.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

const TONE: Record<AllocationItem["tone"], string> = {
  deduction: "bg-gold",
  reserve: "bg-primary/70",
  distribution: "bg-teal",
  fee: "bg-aqua",
};

/** Stacked share bar with a legend: where each unit of revenue goes. */
export function AllocationBreakdown({
  items,
  currency,
  title,
  caption,
}: {
  items: AllocationItem[];
  currency: string;
  title: string;
  caption?: string;
}) {
  return (
    <figure className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <figcaption className="font-display text-base font-semibold text-foreground">{title}</figcaption>
      {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No breakdown has been provided.</p>
      ) : (
        <>
          <div className="mt-5 flex h-4 overflow-hidden rounded-full bg-secondary" role="img" aria-label={items.map((i) => `${i.label} ${pct(i.sharePct)}`).join(", ")}>
            {items.map((i) => (
              <span key={i.key} className={TONE[i.tone]} style={{ width: `${i.sharePct}%` }} />
            ))}
          </div>
          <ul className="mt-5 space-y-3">
            {items.map((i) => (
              <li key={i.key} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-foreground">
                  <span className={`h-2.5 w-2.5 rounded-full ${TONE[i.tone]}`} aria-hidden="true" />
                  {i.label}
                </span>
                <span className="number-display text-right">
                  <span className="font-semibold text-foreground">{money(i.amount, currency)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{pct(i.sharePct)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}
