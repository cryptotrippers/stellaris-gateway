import { ArrowDown, ArrowRight, CornerDownRight, Minus, Plus, Undo2 } from "lucide-react";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { WATERFALL_STEPS } from "./content";

/** Categorical, number-free waterfall. Bar widths are decorative, not amounts. */
const WIDTH = ["100%", "82%", "66%", "54%", "44%", "44%"];

export function CashWaterfallConcept() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <figure className="rounded-2xl border border-border bg-card p-5 md:p-6">
        <figcaption>
          <span className="font-display text-base font-semibold text-foreground">How project cash flows to holders</span>
          <span className="mt-1 block text-xs font-medium text-muted-foreground">
            Conceptual · categories only, no amounts · bar lengths are not to scale
          </span>
        </figcaption>
        <ol className="mt-6 space-y-2">
          {WATERFALL_STEPS.map((s, i) => (
            <li key={s.key}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${s.kind === "out" ? "bg-gold/20 text-foreground" : "bg-teal/15 text-teal"}`} aria-hidden="true">
                  {s.kind === "out" ? <Minus className="h-3.5 w-3.5" /> : s.kind === "in" ? <Plus className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {s.label}
                    <span className="sr-only"> ({s.kind === "out" ? "deducted" : s.kind === "in" ? "received" : "result"})</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{s.text}</p>
                  <div className="mt-2 h-3 rounded-full bg-secondary/70" aria-hidden="true">
                    <div
                      className={`h-3 rounded-full ${s.kind === "out" ? "home-hiw-hatch bg-gold/70" : "bg-teal"}`}
                      style={{ width: WIDTH[i] }}
                    />
                  </div>
                </div>
              </div>
              {i < WATERFALL_STEPS.length - 1 && <ArrowDown className="ml-1.5 mt-1 h-3 w-3 text-muted-foreground" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </figure>

      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="font-display text-base font-semibold text-foreground">Risks to the flow</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Revenue can fall or stop.</li>
            <li>Costs, interest or tax can rise.</li>
            <li>Reserves may be topped up before anything is distributed.</li>
            <li>Distributions can be reduced, delayed or skipped.</li>
            <li>You can lose some or all of the capital.</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-foreground">If funding fails</h3>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">PLANNED</span>
          </div>
          <ol className="mt-3 space-y-2 text-sm text-foreground">
            <li className="flex gap-2"><CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden="true" />Minimum raise not met by the deadline.</li>
            <li className="flex gap-2"><CornerDownRight className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden="true" />No capital is released to the issuer.</li>
            <li className="flex gap-2"><Undo2 className="mt-0.5 h-4 w-4 shrink-0 text-teal" aria-hidden="true" />Subscriptions are refunded under the offering terms.</li>
          </ol>
          <div className="mt-3">
            <FeatureStatus stage="awaiting_backend" />
          </div>
        </div>
      </div>
    </div>
  );
}
