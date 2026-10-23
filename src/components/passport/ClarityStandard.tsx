import { StatusPill, type DisclosureStatus } from "@/components/brand/StatusPill";
import { clarityPublishedCount, type ClarityItem } from "./clarity";

const SEGMENT: Record<DisclosureStatus, string> = {
  verified: "bg-success",
  published: "bg-teal",
  pending: "bg-gold/60",
  illustrative: "bg-aqua/50",
  demo: "bg-aqua/50",
  not_applicable: "bg-muted-foreground/25",
  unknown: "bg-muted-foreground/25",
};

/** Seven-segment summary of the Clarity Standard for cards and headers. */
export function ClarityMeter({ items }: { items: ClarityItem[] }) {
  const count = clarityPublishedCount(items);
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-muted-foreground">Clarity Standard</span>
        <span className="text-foreground">
          <span className="font-semibold">{count}</span> of {items.length} published
        </span>
      </div>
      <div className="mt-1.5 flex gap-1" role="img" aria-label={`Clarity Standard: ${count} of ${items.length} disclosures published`}>
        {items.map((i) => (
          <span key={i.key} title={`${i.label}: ${i.status}`} className={`h-1.5 flex-1 rounded-full ${SEGMENT[i.status]}`} />
        ))}
      </div>
    </div>
  );
}

/** Full checklist with a status and plain-language note per disclosure. */
export function ClarityChecklist({ items }: { items: ClarityItem[] }) {
  return (
    <div>
      <ClarityMeter items={items} />
      <ul className="mt-5 divide-y divide-border rounded-xl border border-border">
        {items.map((i, n) => (
          <li key={i.key} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-foreground">
                {n + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-foreground">{i.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{i.note}</p>
              </div>
            </div>
            <StatusPill status={i.status} className="self-start sm:shrink-0" />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Published means a disclosure exists. Verified means an independent review is recorded — no
        project has a recorded independent review yet.
      </p>
    </div>
  );
}
