import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Building2, Globe2, Home } from "lucide-react";
import { BRAND } from "@/config/brand";

export const Route = createFileRoute("/property")({
  head: () => ({
    meta: [
      { title: "Property: Australia & Southeast Asia (planned) · Stellaris" },
      { name: "description", content: `How Stellaris plans to offer tokenised property shares in Australia and Southeast Asia, with rent paid pro rata in ${BRAND.base.ticker}. Planned — subject to legal approval.` },
      { property: "og:title", content: "Property: Australia & Southeast Asia (planned) · Stellaris" },
      { property: "og:description", content: "Tokenised shares in local property companies, with ownership caps to be enforced by the contracts. Planned — nothing is on offer yet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://stellarischain.com/property" }],
  }),
  component: PropertyPage,
});

function Meter({ label, pct, note }: { label: string; pct: number; note: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="number-display font-semibold">{pct}%</span>
      </div>
      <div className="mt-1.5 h-2.5 rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{note}</div>
    </div>
  );
}

function PropertyPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 md:px-6 py-10 space-y-8">
      <div>
        <div className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" /> Planned — subject to legal approval. Nothing is on offer yet.
        </div>
        <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">Property: Australia &amp; Southeast Asia</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          How Stellaris plans to bring property on chain, starting in Australia and the Philippines.
        </p>
      </div>

      <section className="card-institutional p-5 md:p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Home className="h-5 w-5 text-primary" /> How it works</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>A local property company owns each property; investors hold tokenised shares in that company.</li>
          <li>Rent is paid out pro rata in {BRAND.base.ticker}.</li>
          <li>Ownership caps and transfer rules will be enforced by the contracts on every purchase and transfer.</li>
        </ul>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card-institutional p-5 md:p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Globe2 className="h-5 w-5 text-primary" /> Philippines</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>The property company is majority Filipino-owned, as the law requires.</li>
            <li>Foreign ownership will be capped at 40% per project, and the contracts will enforce the cap on every purchase and transfer.</li>
            <li>
              Filipino citizens abroad, including dual citizens, can invest on the Filipino side:{" "}
              <strong className="text-foreground">Invest back home</strong>.
            </li>
          </ul>
        </section>
        <section className="card-institutional p-5 md:p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Building2 className="h-5 w-5 text-primary" /> Australia</h2>
          <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>A company or unit trust owns the properties.</li>
            <li>Launch to wholesale investors first.</li>
            <li>Foreign-investor limits are applied per offering.</li>
          </ul>
        </section>
      </div>

      <section className="card-institutional p-5 md:p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Illustrative offering</h2>
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 text-[11px] text-warning">Illustrative</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          An example of how a Philippine project would show its ownership split. Numbers are placeholders.
        </p>
        <div className="mt-5 space-y-5">
          <Meter label="Filipino allocation" pct={62} note="Majority Filipino-owned, as required by law" />
          <Meter label="Foreign allocation" pct={31} note="31% of the 40% cap (illustrative). The contract will enforce it on every purchase and transfer" />
        </div>
      </section>
    </div>
  );
}
