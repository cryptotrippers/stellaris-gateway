import { Lock } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { ASSET_STAGES } from "./content";
import { HIW_ICONS } from "./icons";

const GATES = ASSET_STAGES.filter((s) => s.gate).map((s) => ({ ...s.gate!, stage: s.title }));

export function AssetLifecycle() {
  return (
    <div>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Nine stages every project follows. These are educational steps, <strong className="text-foreground">not the status of any real project</strong>.
        Each stage shows two separate things: what happens to the project, and how ready the platform feature is today.
      </p>

      <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Review gates">
        {GATES.map((g) => (
          <li key={g.id} className="home-hiw-gate rounded-xl p-4">
            <p className="flex items-center gap-2 font-display text-sm font-semibold text-foreground">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-gold bg-gold/15 text-xs" aria-hidden="true">
                {g.id}
              </span>
              <Lock className="h-3.5 w-3.5 text-gold" aria-hidden="true" />
              {g.label.replace(/^Gate [A-D] · /, "")}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{g.note}</p>
            <p className="mt-2 text-xs font-medium text-foreground">Before: {g.stage}</p>
          </li>
        ))}
      </ul>

      <Accordion type="multiple" className="home-hiw-path mt-10 space-y-3">
        {ASSET_STAGES.map((s, i) => {
          const Icon = HIW_ICONS[s.icon];
          return (
            <AccordionItem key={s.key} value={s.key} className="home-hiw-tile relative rounded-2xl border border-border bg-card px-4 md:px-5">
              {s.gate && (
                <p className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-gold/50 bg-gold/10 px-2 py-0.5 text-xs font-semibold text-foreground">
                  <Lock className="h-3 w-3 text-gold" aria-hidden="true" /> {s.gate.label}
                </p>
              )}
              <AccordionTrigger className="min-h-11 gap-3 py-4 text-left hover:no-underline">
                <span className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="home-hiw-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal/10 text-teal" aria-hidden="true">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-display text-base font-semibold text-foreground">
                      <span className="sr-only">Stage {i + 1}: </span>
                      {s.title}
                    </span>
                    <span className="mt-0.5 block text-sm font-normal text-muted-foreground">{s.summary}</span>
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <dl className="grid gap-4 pb-2 pl-0 text-sm sm:grid-cols-2 md:pl-[100px]">
                  {[
                    ["What happens", s.happens],
                    ["Evidence", s.evidence],
                    ["Who decides", s.decides],
                    ["What can fail", s.canFail],
                    ["Next step", s.next],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-teal">{k}</dt>
                      <dd className="mt-1 leading-relaxed text-foreground">{v}</dd>
                    </div>
                  ))}
                  <div className="rounded-xl bg-secondary/60 p-3 sm:col-span-2">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Platform feature readiness</dt>
                    <dd className="mt-2 flex flex-wrap gap-2">
                      {s.readiness.map((r) => (
                        <FeatureStatus key={r} stage={r} />
                      ))}
                    </dd>
                    <dd className="mt-2 text-xs text-muted-foreground">{s.readinessNote}</dd>
                  </div>
                </dl>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}
