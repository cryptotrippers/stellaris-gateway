import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Info, Lock } from "lucide-react";
import { BRAND } from "@/config/brand";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { TesseraActions } from "@/components/tessera/TesseraActions";

export const Route = createFileRoute("/stake")({
  head: () => ({
    meta: [
      { title: `Stake ${BRAND.staked.ticker} · Stellaris` },
      {
        name: "description",
        content: `Stake ${BRAND.base.ticker} for ${BRAND.staked.ticker}: flexible staking with a cooldown, or a locked position at a higher target rate. Rates are variable, not promised.`,
      },
      { property: "og:title", content: `Stake ${BRAND.staked.ticker} · Stellaris` },
      {
        property: "og:description",
        content: `Flexible or locked staking for ${BRAND.staked.ticker}, with the cooldown shown before you confirm.`,
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StakePage,
});

function StakePage() {
  return (
    <MarketingLayout>
      <div className="mx-auto max-w-3xl px-4 md:px-6 py-10">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" /> Cardano Preprod testnet — test tokens only, no
          real value
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Stake {BRAND.base.ticker}, earn as {BRAND.staked.ticker}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{BRAND.staked.description}</p>

        <div className="mt-8">
          <ClientOnly
            fallback={<p className="text-sm text-muted-foreground">Loading live figures…</p>}
          >
            <TesseraActions />
          </ClientOnly>
        </div>

        <ul className="mt-6 space-y-2">
          {[
            "Yield is credited gradually over 7 days after each report, so staking just before a report doesn't capture it.",
            `The protocol keeps 12.5% of yield (hard cap 20%), never your principal; half of that goes to the first-loss reserve.`,
            "Staking may require an eligibility check, depending on your country.",
          ].map((note) => (
            <li key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {note}
            </li>
          ))}
        </ul>

        <div className="mt-6 flex items-start gap-2 rounded-xl border border-border bg-secondary/40 p-4 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          The locked tier (a fixed lock for a larger share of yield) is coming next; this page
          stakes in the flexible tier, which you leave through a Ticket and a 7-day cooldown.
        </div>
      </div>
    </MarketingLayout>
  );
}
