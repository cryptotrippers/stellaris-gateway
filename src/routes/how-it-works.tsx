import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Building2, Info, ShieldCheck, Store } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { TESTNET_DISCLOSURE } from "@/components/brand/DisclosureBanner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetLifecycle } from "@/components/how-it-works/AssetLifecycle";
import { InvestorJourney } from "@/components/how-it-works/InvestorJourney";
import { TesseraMechanism } from "@/components/how-it-works/TesseraMechanism";
import { CashWaterfallConcept } from "@/components/how-it-works/CashWaterfallConcept";
import { JOURNEYS, isJourneyKey, type JourneyKey } from "@/components/how-it-works/content";
import { BRAND } from "@/config/brand";

export const Route = createFileRoute("/how-it-works")({
  validateSearch: (s: Record<string, unknown>): { journey?: JourneyKey } =>
    isJourneyKey(s.journey) ? { journey: s.journey } : {},
  head: () => ({
    meta: [
      { title: "How It Works · Stellaris Finance" },
      {
        name: "description",
        content:
          "How real-world asset projects move from enquiry to exit, how investors take part, and how Tessera works. Cardano Preprod testnet preview.",
      },
      { property: "og:title", content: "How It Works · Stellaris Finance" },
      {
        property: "og:description",
        content: "Asset lifecycle with four review gates, the investor journey and the Tessera mechanism, explained.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HowItWorks,
});

const CTAS = [
  { to: "/marketplace" as const, Icon: Store, title: "Explore the marketplace", text: "Browse assets and read their passports." },
  { to: "/for-issuers" as const, Icon: Building2, title: "For issuers", text: "Bring a real-world project through review." },
  { to: "/trust" as const, Icon: ShieldCheck, title: "Trust Centre", text: "See what is verified, pending and how we disclose." },
];

function HowItWorks() {
  // Guard again here: an unknown or repeated ?journey= value must fall back to
  // the first journey rather than leave every tab unselected and the page blank.
  const search = Route.useSearch() as { journey?: unknown };
  const journey: JourneyKey = isJourneyKey(search.journey) ? search.journey : "asset";
  const navigate = Route.useNavigate();

  return (
    <MarketingLayout>
      <section className="home-dark-section home-hiw-hero relative overflow-hidden">
        <div className="home-container relative py-16 md:py-24">
          <p className="home-eyebrow">How it works</p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-semibold leading-[1.08] md:text-6xl">
            From real-world project to reviewed, reported asset.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed opacity-85 md:text-lg">
            Three journeys explained: how assets are reviewed through four gates, how investors take part, and how{" "}
            {BRAND.productName} ({BRAND.base.ticker} / {BRAND.staked.ticker}) works — kept separate from project cash yield.
          </p>
          <div role="note" className="mt-8 flex max-w-2xl items-start gap-3 rounded-xl border border-gold/50 bg-gold/10 p-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            <span>
              {TESTNET_DISCLOSURE} The stages below are educational and do not describe the status of any real project.
            </span>
          </div>
        </div>
      </section>

      <section className="home-container py-12 md:py-16">
        <Tabs value={journey} onValueChange={(v) => isJourneyKey(v) && navigate({ search: { journey: v }, replace: true, resetScroll: false })}>
          <TabsList aria-label="Choose a journey" className="grid h-auto w-full grid-cols-3 gap-1 rounded-xl p-1 sm:inline-grid sm:w-auto">
            {JOURNEYS.map((j) => (
              <TabsTrigger key={j.key} value={j.key} className="min-h-11 rounded-lg px-2 text-xs sm:px-5 sm:text-sm">
                <span className="sm:hidden">{j.short}</span>
                <span className="hidden sm:inline">{j.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="asset" className="mt-10">
            <h2 className="font-display text-2xl font-semibold md:text-3xl">Asset lifecycle</h2>
            <div className="mt-4"><AssetLifecycle /></div>
          </TabsContent>
          <TabsContent value="investor" className="mt-10">
            <h2 className="font-display text-2xl font-semibold md:text-3xl">Investor journey</h2>
            <div className="mt-4"><InvestorJourney /></div>
          </TabsContent>
          <TabsContent value="tessera" className="mt-10">
            <h2 className="font-display text-2xl font-semibold md:text-3xl">
              {BRAND.productName} · {BRAND.base.ticker} and {BRAND.staked.ticker}
            </h2>
            <div className="mt-4"><TesseraMechanism /></div>
          </TabsContent>
        </Tabs>
      </section>

      <section className="border-t border-border bg-secondary/30">
        <div className="home-container py-12 md:py-16">
          <SectionHeader
            eyebrow="Project cash yield · conceptual"
            title="Where project cash goes before anyone is paid."
            description="Project distributions come from the asset's own cash flow — not from Tessera. This chart shows categories only; it contains no real or example amounts."
          />
          <div className="mt-8"><CashWaterfallConcept /></div>
        </div>
      </section>

      <section className="home-container py-12 md:py-16">
        <h2 className="font-display text-2xl font-semibold md:text-3xl">Keep exploring</h2>
        <ul className="mt-6 grid gap-4 md:grid-cols-3">
          {CTAS.map(({ to, Icon, title, text }) => (
            <li key={to}>
              <Link to={to} className="home-card group flex h-full min-h-11 flex-col p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon className="h-6 w-6 text-teal" aria-hidden="true" />
                <span className="mt-3 font-display text-lg font-semibold text-foreground">{title}</span>
                <span className="mt-1 flex-1 text-sm text-muted-foreground">{text}</span>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-teal">
                  Open <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </MarketingLayout>
  );
}
