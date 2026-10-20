import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronDown,
  Coins,
  ExternalLink,
  Leaf,
  Menu,
  ShieldCheck,
  Sun,
  Wallet,
  X,
  Layers,
  Clock3,
  Landmark,
  Eye,
  Boxes,
  FileCode2,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/StatusBadge";
import { StatusPill } from "@/components/brand/StatusPill";
import { StellarisWordmark } from "@/components/brand/Logo";
import { MarketingNav } from "@/components/layout/MarketingNav";
import { MarketingFooter } from "@/components/layout/MarketingFooter";
import { ShareRow } from "@/components/landing/ShareRow";
import { BRAND } from "@/config/brand";
import { STAKE_TIERS } from "@/data/staking.mock";
import { TRANSPARENCY } from "@/data/transparency.mock";
import { assetsQueryOptions, fundedPct } from "@/lib/assets-query";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { trackEvent } from "@/lib/analytics";
import homeImage from "@/assets/stellaris-home.jpg";
import propertyImg from "@/assets/home-property.jpg";
import energyImg from "@/assets/home-energy.jpg";
import agriImg from "@/assets/home-agriculture.jpg";

const SITE = "https://stellarischain.com";
const FAQ = [
  {
    q: "Is this live, or a preview?",
    a: "Stellaris runs on Cardano Preprod. Test funds have no real monetary value. Demo projects are illustrative and cannot be invested in. The staking and reserve figures are previews, not live balances.",
  },
  {
    q: `How do ${BRAND.base.ticker} and ${BRAND.staked.ticker} differ?`,
    a: `${BRAND.base.description} ${BRAND.staked.description} The staking preview also includes a locked Position, which is not a transferable token.`,
  },
  {
    q: "When can I withdraw?",
    a: `Each project shows its own exit rules. The ${BRAND.productName} model uses a daily redemption queue. Flexible staking has a 7-day cooldown; the locked preview has a 30-day lock. During flexible cooldown, the request earns no yield but still shares in losses until claimed.`,
  },
  {
    q: "What are the fees and risks?",
    a: "Returns are not guaranteed and losses are possible. The staking model allocates 12.5% of earned yield to the protocol, with a hard cap of 20%, never principal; half of that share goes to the first-loss reserve. Marketplace fees depend on the project and are shown before signing.",
  },
  {
    q: "Is property available now?",
    a: "No. Property in Australia and Southeast Asia is planned, subject to legal approval. Nothing is on offer yet. Ownership-cap contracts are not built yet.",
  },
  {
    q: "What do I need to explore?",
    a: "You can browse projects, the reserve preview and planned property without a wallet. A supported Cardano wallet on Preprod is needed for on-chain actions. Staking may require an eligibility check when available.",
  },
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Stellaris Finance · Real assets. More accessible ownership." },
      {
        name: "description",
        content: `Explore fractional real-world assets, ${BRAND.base.ticker}, ${BRAND.staked.ticker} staking and the reserve model on Cardano. Testnet preview; property is planned, subject to legal approval.`,
      },
      { property: "og:title", content: "Stellaris Finance · Real assets. More accessible ownership." },
      {
        property: "og:description",
        content:
          "Explore the marketplace, variable staking model and transparent reserve preview. Built on Cardano Preprod. No real money is used.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE}/` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${SITE}/` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Stellaris",
          url: SITE,
        }),
      },
    ],
  }),
  component: LandingPage,
});

const categoryIcon: Record<string, typeof Leaf> = {
  "Sustainable Farming": Leaf,
  "Clean Energy": Sun,
  "Real Estate": Building2,
  "Carbon Credits": Leaf,
  Infrastructure: Landmark,
};

function LandingPage() {
  return (
    <div className="home-page min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main>
        <Hero />
        <section className="border-y border-border bg-surface" aria-label="Platform status">
          <div className="home-container grid gap-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
            <TrustItem icon={Layers} title="Network" detail="Cardano Preprod (test network)" />
            <TrustItem icon={ExternalLink} title="Explorer" detail="Every transaction on Cardanoscan" />
            <TrustItem icon={ShieldCheck} title="Independent audit" detail="Not yet completed" />
            <TrustItem icon={Clock3} title="Status" detail="Preview — no live offerings" />
          </div>
        </section>
        <AssetClasses />
        <HowItWorks />
        <ClarityStandard />
        <FeaturedAssets />
        <WhyBlockchain />
        <ProtocolArchitecture />
        <ProductModel />
        <ReservePreview />
        <TransparencyLinks />
        <Education />
        <IssuerSection />
        <FaqSection />
        <FinalCta />
      </main>
      <MarketingFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="home-hero relative overflow-hidden">
      <div className="home-container grid items-center gap-10 py-14 md:py-20 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="home-eyebrow tracking-wider">Real-World Assets • Powered by Cardano</p>
          <h1 className="mt-5 text-4xl font-bold leading-[1.08] text-primary md:text-6xl">
            Real assets.
            <span className="block text-teal">More accessible ownership.</span>
          </h1>
          <p className="mt-6 max-w-[520px] text-base leading-relaxed text-muted-foreground md:text-lg">
            Explore the technology bringing fractional participation, transparent records and
            real-world investment opportunities closer together.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-6">
              <Link
                to="/marketplace"
                onClick={() => trackEvent("landing_hero_cta_click", { target: "marketplace" })}
              >
                Explore the Platform <ArrowRight />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="h-12 px-6">
              <a href="#how-it-works">How Stellaris Works</a>
            </Button>
          </div>
          <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden />
            Testnet preview on Cardano Preprod — no real money
          </p>
        </div>
        <div className="home-hero-panel relative overflow-hidden p-3 shadow-elevated">
          <img
            src={homeImage}
            alt="Concept image of solar-roofed homes near farmland — not a listed asset"
            width={1920}
            height={1024}
            fetchPriority="high"
            className="h-56 w-full rounded-xl object-cover md:h-72"
          />
          <div className="p-4 md:p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-wider text-gold">Illustrative ownership record</p>
              <span className="rounded-full border border-gold/40 px-2 py-0.5 text-[10px] text-gold">
                Example only
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs opacity-70">Asset type</dt>
                <dd className="font-medium">Rooftop solar</dd>
              </div>
              <div>
                <dt className="text-xs opacity-70">Network</dt>
                <dd className="font-medium">Cardano Preprod</dd>
              </div>
              <div>
                <dt className="text-xs opacity-70">Record</dt>
                <dd className="font-mono text-xs">Native token · transferable</dd>
              </div>
              <div>
                <dt className="text-xs opacity-70">Verification</dt>
                <dd className="font-medium">Evidence linked per asset</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustItem({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof Layers;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 sm:justify-center sm:border-r sm:border-border last:border-0">
      <Icon className="h-5 w-5 shrink-0 text-primary" />
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function ProductModel() {
  return (
    <section className="home-container home-section">
      <SectionHeading
        eyebrow="The Stellaris model"
        title="Different ways to participate. Clear distinctions."
        description="Own project fractions, explore a dollar-referenced token, or share in reserve yield. They are different products, with different risks."
      />
      <div className="mt-9 grid gap-5 lg:grid-cols-3">
        <article className="home-product border border-border bg-surface p-6 md:p-7">
          <div className="flex items-center justify-between">
            <span className="home-icon bg-primary/10 text-primary">
              <Building2 />
            </span>
            <Badge tone="primary">Marketplace</Badge>
          </div>
          <h3 className="mt-6 text-2xl font-semibold">Own a fraction</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Explore fractional real-world assets on Cardano. Each offering has its own price, fees
            and exit rules.
          </p>
          <div className="mt-5 border-t border-border pt-4 text-sm">
            <span className="font-medium">ADA-first</span>
            <p className="mt-1 text-xs text-muted-foreground">
              Project-specific terms. Demo rows are not offerings.
            </p>
          </div>
          <Button asChild variant="link" className="mt-auto justify-start px-0 pt-6">
            <Link to="/offerings">
              Explore fractions <ArrowRight />
            </Link>
          </Button>
        </article>
        <article className="home-product border border-border bg-surface p-6 md:p-7">
          <div className="flex items-center justify-between">
            <span className="home-icon bg-accent/15 text-accent-foreground">
              <Coins />
            </span>
            <Badge tone="accent">{BRAND.base.ticker}</Badge>
          </div>
          <h3 className="mt-6 text-2xl font-semibold">{BRAND.productName}</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {BRAND.base.description}
          </p>
          <div className="mt-5 border-t border-border pt-4 text-sm">
            <span className="font-medium">Non-yielding base token</span>
            <p className="mt-1 text-xs text-muted-foreground">
              Reserve model preview, not a live reserve attestation.
            </p>
          </div>
          <Button asChild variant="link" className="mt-auto justify-start px-0 pt-6">
            <Link to="/transparency">
              Explore the reserves <ArrowRight />
            </Link>
          </Button>
        </article>
        <article className="home-product border border-border bg-surface p-6 md:p-7">
          <div className="flex items-center justify-between">
            <span className="home-icon bg-success/10 text-success">
              <Layers />
            </span>
            <Badge tone="warning">Illustrative preview</Badge>
          </div>
          <h3 className="mt-6 text-2xl font-semibold">Stake {BRAND.base.ticker}</h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {BRAND.staked.description}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
            {STAKE_TIERS.map((tier) => (
              <div key={tier.id}>
                <p className="text-xs text-muted-foreground">
                  {tier.label} · {tier.cooldownDays} days
                </p>
                <p className="mt-1 text-lg font-semibold">
                  {tier.aprPct.toFixed(1)}%{" "}
                  <span className="text-xs font-normal text-muted-foreground">target</span>
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Variable, not guaranteed. Flexible token; locked Position.
          </p>
          <Button asChild variant="link" className="mt-auto justify-start px-0 pt-6">
            <Link to="/stake">
              Compare staking tiers <ArrowRight />
            </Link>
          </Button>
        </article>
      </div>
    </section>
  );
}

function ReservePreview() {
  const [view, setView] = useState<"overview" | "methodology">("overview");
  return (
    <section className="border-y border-border bg-secondary/40">
      <div className="home-container home-section">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <p className="home-eyebrow">Transparency, by design</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">
              See what sits behind the token.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
              Four reserve sleeves with published target bands, and a first-loss reserve designed
              to absorb losses before stakers — not a guarantee against loss.
            </p>
          </div>
          <div className="home-toggle" role="group" aria-label="Reserve view">
            <button
              type="button"
              aria-pressed={view === "overview"}
              onClick={() => setView("overview")}
            >
              Overview
            </button>
            <button
              type="button"
              aria-pressed={view === "methodology"}
              onClick={() => setView("methodology")}
            >
              Methodology
            </button>
          </div>
        </div>

        {view === "overview" ? (
          <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_1.15fr]">
            <div>
              <div className="border-l-2 border-success pl-4">
                <p className="text-sm font-semibold">The protocol pays before stakers</p>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                  In the intended loss order, originator collateral comes first, then the protocol
                  first-loss reserve, the overcollateral buffer, stakers and finally{" "}
                  {BRAND.base.ticker} holders.
                </p>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-4">
                <div className="home-card p-4">
                  <p className="text-xs text-muted-foreground">First-loss reserve</p>
                  <p className="mt-1 text-xl font-semibold">
                    {TRANSPARENCY.firstLoss.levelPct}%{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      / {TRANSPARENCY.firstLoss.targetPct}% target
                    </span>
                  </p>
                </div>
                <div className="home-card p-4">
                  <p className="text-xs text-muted-foreground">Overcollateralisation</p>
                  <p className="mt-1 text-xl font-semibold">
                    {TRANSPARENCY.overcollateral.ratioPct}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Target {TRANSPARENCY.overcollateral.targetMinPct}–
                    {TRANSPARENCY.overcollateral.targetMaxPct}%
                  </p>
                </div>
              </div>
              <Button asChild variant="link" className="mt-6 px-0">
                <Link to="/transparency">
                  Full reserve breakdown <ArrowUpRight />
                </Link>
              </Button>
            </div>
            <div>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Reserve allocation</h3>
                <Badge tone="warning">Testnet preview — illustrative data</Badge>
              </div>
              <div className="space-y-5">
                {TRANSPARENCY.sleeves.map((sleeve) => (
                  <div key={sleeve.id}>
                    <div className="mb-2 flex justify-between gap-4 text-sm">
                      <span className="font-medium">{sleeve.name}</span>
                      <span className="number-display font-semibold">{sleeve.sharePct}%</span>
                    </div>
                    <meter
                      className={`home-meter home-meter-${sleeve.id}`}
                      min={0}
                      max={100}
                      value={sleeve.sharePct}
                      aria-label={`${sleeve.name} illustrative allocation`}
                    >
                      {sleeve.sharePct}%
                    </meter>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Target band {sleeve.targetMinPct}–{sleeve.targetMaxPct}% · {sleeve.detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-10">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">How the reserve is intended to work</h3>
              <StatusPill status="illustrative" />
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="home-card p-6">
                <h4 className="font-semibold">Sleeves &amp; bands</h4>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Reserves are held across four sleeves — liquid cash and money-market funds
                  (60–70%), short investment-grade bonds (0–10%), multi-originator credit
                  (20–30%) and marketplace real-world assets (5–10%). Rebalancing is intended to
                  keep each sleeve inside its published band.
                </p>
              </div>
              <div className="home-card p-6">
                <h4 className="font-semibold">Redemption policy</h4>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Redemptions draw on cash first, then money-market funds, then short
                  investment-grade assets. Credit and marketplace assets are not sold to meet
                  redemptions.
                </p>
              </div>
              <div className="home-card p-6">
                <h4 className="font-semibold">Loss order</h4>
                <ol className="mt-3 space-y-2 text-sm">
                  {[
                    "Originator collateral & covenants",
                    "Protocol first-loss reserve",
                    "Overcollateral buffer",
                    `Stakers (${BRAND.staked.ticker})`,
                    `${BRAND.base.ticker} holders`,
                  ].map((step, i) => (
                    <li key={step} className="flex items-center gap-3">
                      <span className="home-step-num home-step-sm">{i + 1}</span>
                      <span className={i === 1 ? "font-semibold" : "text-muted-foreground"}>
                        {step}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-xs text-muted-foreground">
                  Losses are possible at every level; this order is a design, not a promise.
                </p>
              </div>
              <div className="home-card p-6">
                <h4 className="font-semibold">Controls</h4>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Reserve operations are designed for M-of-N multi-signature control with on-chain
                  hard limits, and an automatic 7-day pause if a reserve attestation is missed.
                </p>
              </div>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              Methodology describes the intended design. Figures on this page are illustrative
              preview data, not live reserve balances.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function FeaturedAssets() {
  const { data: assets, isLoading, error, refetch } = useQuery(assetsQueryOptions());
  const featured = (assets ?? []).slice(0, 6);
  return (
    <section className="home-container home-section">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          eyebrow="The marketplace"
          title="Real assets, with the rules on show."
          description="Explore the project registry. Demo entries are clearly marked and cannot be invested in."
        />
        <Button asChild variant="outline">
          <Link to="/marketplace">
            All projects <ArrowUpRight />
          </Link>
        </Button>
      </div>
      {isLoading && (
        <div className="mt-8 grid gap-5 md:grid-cols-3" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-lg bg-secondary" />
          ))}
        </div>
      )}
      {error && (
        <div className="mt-8 flex flex-wrap items-center gap-4 border border-border p-6">
          <p className="text-sm text-destructive">Projects couldn't be loaded right now.</p>
          <Button variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      )}
      {!isLoading && !error && featured.length === 0 && (
        <div className="home-card mt-8 p-8 text-center">
          <p className="text-lg font-semibold">New opportunities are being prepared.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-3 text-sm">
            <a href="#how-it-works" className="text-teal hover:underline">Learn how it works</a>
            <Link to="/auth" className="text-teal hover:underline">Get launch updates</Link>
            <Link to="/funding/new" className="text-teal hover:underline">Become an issuer</Link>
          </div>
        </div>
      )}
      {!error && (
        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((asset) => {
            const Icon = categoryIcon[asset.category] ?? Building2;
            const demo = asset.funding_status === "demo";
            return (
              <Link
                key={asset.id}
                to="/marketplace/$id"
                params={{ id: asset.id }}
                onClick={() => trackEvent("landing_asset_click", { asset: asset.id })}
                className="home-card group flex min-w-0 flex-col p-6"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="home-icon bg-secondary text-primary">
                    <Icon />
                  </span>
                  <Badge tone={demo ? "warning" : "primary"}>
                    {demo ? "Demo · not investable" : asset.funding_status}
                  </Badge>
                </div>
                <p className="mt-5 text-[11px] font-medium uppercase text-muted-foreground">
                  {asset.category}
                </p>
                <h3 className="mt-1 text-lg font-semibold">{asset.name}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {asset.location ?? asset.issuer}
                </p>
                <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                  {demo
                    ? "Demo project for the testnet preview — not a real offering, nothing can be invested."
                    : asset.description}
                </p>
                <div className="mt-auto pt-6">
                  <div className="flex justify-between gap-3 border-t border-border pt-4 text-xs">
                    <span className="text-muted-foreground">
                      {demo ? "Illustrative target" : "Funding target"}
                    </span>
                    <span className="font-semibold">
                      {formatAda(lovelaceToAda(Number(asset.target_lovelace)))}
                    </span>
                  </div>
                  {!demo && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {fundedPct(asset).toFixed(1)}% funded ·{" "}
                      {formatAda(lovelaceToAda(Number(asset.raised_lovelace)))} raised
                    </p>
                  )}
                  <div className="mt-5 flex justify-between text-sm font-medium text-primary">
                    <span>{demo ? "View demo project" : "View project & terms"}</span>
                    <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AssetClasses() {
  const classes = [
    { img: propertyImg, title: "Property", body: "Fractional residential property in Australia and Southeast Asia.", status: "Planned — subject to legal approval", to: "/property" },
    { img: energyImg, title: "Renewable energy", body: "Rooftop and community solar that produces measurable output.", status: "Demo projects on testnet", to: "/marketplace" },
    { img: agriImg, title: "Agriculture & productive businesses", body: "Farms and estates with reported harvests and income.", status: "Demo projects on testnet", to: "/marketplace" },
  ];
  return (
    <section className="home-container home-section">
      <SectionHeading
        eyebrow="Asset classes"
        title="Real-world assets, explained plainly."
        description="Other approved categories may follow. Nothing below is a live offering."
      />
      <div className="mt-10 grid gap-6 md:grid-cols-3">
        {classes.map((c) => (
          <Link key={c.title} to={c.to} className="home-card group overflow-hidden">
            <img src={c.img} alt={`${c.title} — illustrative image`} width={1024} height={768} loading="lazy" className="h-48 w-full object-cover" />
            <div className="p-6">
              <Badge tone="warning">{c.status}</Badge>
              <h3 className="mt-4 text-xl font-semibold">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
              <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-teal">
                Learn more <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function WhyBlockchain() {
  const points = [
    ["Traceable history", "Every transfer is recorded publicly and can be checked by anyone."],
    ["Programmable rules", "Fees, caps and exits can be enforced by the contract itself."],
    ["Leaner administration", "Registers and distributions could run with fewer manual steps."],
    ["Digital ownership records", "Your fractions are native tokens you hold in your own wallet."],
  ];
  return (
    <section className="home-dark-section">
      <div className="home-container home-section grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="home-eyebrow text-gold">Why blockchain matters</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">A shared record anyone can check.</h2>
          <p className="mt-5 text-sm leading-relaxed opacity-75">
            Important: a blockchain record does not by itself guarantee legal ownership of the
            underlying asset, its valuation, its performance or legal enforceability. Those depend
            on the legal structure and evidence behind each asset.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {points.map(([t, b]) => (
            <div key={t} className="rounded-2xl border border-deep-foreground/15 p-5">
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-2 text-sm leading-relaxed opacity-75">{b}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TransparencyLinks() {
  const items: [string, string, string][] = [
    ["Network details", "Live Preprod connection health", "/blockfrost-health"],
    ["Smart contract records", "Contracts, versions and pinned hashes", "/developers"],
    ["Audit status", "Internal review done; independent audit pending", "/security"],
    ["Reserve methodology", "Sleeves, targets and loss order (illustrative)", "/transparency"],
    ["Asset verification", "Issuer checks and evidence per project", "/marketplace"],
    ["Terms & risks", "What you agree to and what can go wrong", "/terms"],
  ];
  return (
    <section className="home-container home-section">
      <SectionHeading eyebrow="Transparency & evidence" title="Every claim comes with a source." />
      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([t, d, to]) => (
          <Link key={t} to={to} className="home-card group flex items-start justify-between gap-4 p-5">
            <div>
              <h3 className="font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </div>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-teal" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function Education() {
  const qs = [
    "What is a real-world asset?",
    "What does fractional ownership mean?",
    "What am I legally entitled to?",
    "How could distributions work?",
    "What are the risks?",
    "Can I sell or redeem my position?",
    "What is a Cardano wallet?",
  ];
  return (
    <section className="border-y border-border bg-surface">
      <div className="home-container home-section">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionHeading eyebrow="Learn" title="Start with the questions that matter." />
          <Button asChild variant="outline">
            <Link to="/learn">All guides <ArrowUpRight /></Link>
          </Button>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          {qs.map((q) => (
            <Link key={q} to="/learn" className="rounded-full border border-border bg-background px-4 py-2 text-sm transition-colors hover:border-teal hover:text-teal">
              {q}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function IssuerSection() {
  return (
    <section className="home-container home-section">
      <div className="home-card grid gap-8 p-8 md:grid-cols-[1.4fr_1fr] md:items-center md:p-12">
        <div>
          <p className="home-eyebrow">For asset owners & issuers</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight">Bring your real-world assets into a new digital marketplace.</h2>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Submit an asset with evidence, go through review and governance, and report against it
            on chain. Listing does not guarantee funding or investor demand.
          </p>
        </div>
        <div className="flex md:justify-end">
          <Button asChild size="lg" className="h-12">
            <Link to="/funding/new">Explore Issuer Partnerships <ArrowRight /></Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function ClarityStandard() {
  const labels = [
    {
      status: "published" as const,
      body: "On chain or in a public document, with a source you can check yourself.",
    },
    {
      status: "pending" as const,
      body: "Real work in progress — an audit, an approval, an attestation. It stays labelled pending until it is done.",
    },
    {
      status: "illustrative" as const,
      body: "Preview figures that show how the model works. Never presented as real balances or live returns.",
    },
    {
      status: "not_applicable" as const,
      body: "Deliberately not offered — no card payments, no promised returns, no claims we cannot evidence.",
    },
  ];
  return (
    <section className="border-y border-border bg-surface">
      <div className="home-container home-section grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <p className="home-eyebrow">The Clarity Standard</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">
            Every claim wears a label.
          </h2>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
            Across Stellaris, every figure, status and statement carries one of four labels — so
            you can always tell what is proven, what is in progress and what is only a plan.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <StatusPill status="pending" />
            <p className="text-xs text-muted-foreground">
              A full Clarity matrix on every project page is in progress.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap gap-5 text-sm font-medium">
            <Link to="/security" className="inline-flex items-center gap-1 text-teal hover:underline">
              Security &amp; controls <ArrowUpRight className="h-4 w-4" />
            </Link>
            <Link
              to="/transparency"
              className="inline-flex items-center gap-1 text-teal hover:underline"
            >
              Reserve methodology <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {labels.map((item) => (
            <div key={item.status} className="home-card p-5">
              <StatusPill status={item.status} />
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProtocolArchitecture() {
  const layers = [
    {
      icon: Wallet,
      name: "Your wallet",
      body: "A supported CIP-30 Cardano wallet. You hold your own tokens and sign every transaction — Stellaris never takes custody of your wallet keys.",
      status: "published" as const,
    },
    {
      icon: Boxes,
      name: "The Stellaris app",
      body: "Marketplace, offering registry, portfolio and the staking preview. Demo projects and illustrative figures are labelled as such, everywhere they appear.",
      status: "demo" as const,
    },
    {
      icon: FileCode2,
      name: "Smart contracts",
      body: "Vault and fraction-token validators. Their compiled hashes are pinned in the app and checked against a fresh contract build on every change, so the code you inspect is the code that runs.",
      status: "published" as const,
    },
    {
      icon: Globe,
      name: "Cardano Preprod",
      body: "A public Cardano test network — test funds only, no real money. Every transaction can be inspected on a public explorer.",
      status: "published" as const,
    },
  ];
  const assurances = [
    "Preprod only — the app refuses mainnet configuration.",
    "Contract drift guard — the build fails if the pinned contract hashes change.",
    "On-chain script state is checked with dedicated verification scripts.",
  ];
  return (
    <section className="home-dark-section">
      <div className="home-container home-section grid gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="home-eyebrow text-gold">Protocol architecture</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">
            Built in layers you can inspect.
          </h2>
          <ol className="mt-8 space-y-0">
            {layers.map((layer, i) => (
              <li key={layer.name}>
                {i > 0 && <span className="home-arch-connector" aria-hidden="true" />}
                <div className="home-arch-layer">
                  <span className="home-arch-num">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <layer.icon className="h-4 w-4 text-teal-bright" aria-hidden="true" />
                      <h3 className="font-semibold">{layer.name}</h3>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed opacity-75">{layer.body}</p>
                  </div>
                  <StatusPill status={layer.status} className="shrink-0" />
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="lg:pt-24">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-gold">
            What holds it together
          </h3>
          <ul className="mt-5 space-y-4">
            {assurances.map((a) => (
              <li key={a} className="flex items-start gap-3 text-sm leading-relaxed opacity-85">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-bright" aria-hidden="true" />
                {a}
              </li>
            ))}
          </ul>
          <div className="mt-6 flex items-center gap-3 border-t border-deep-foreground/15 pt-5">
            <StatusPill status="pending" />
            <p className="text-xs opacity-75">
              Independent security audit not yet completed.
            </p>
          </div>
          <Button
            asChild
            variant="outline"
            className="mt-6 border-teal-bright/40 bg-transparent text-deep-foreground hover:bg-teal/10 hover:text-deep-foreground"
          >
            <Link to="/developers">
              Contracts &amp; verification <ArrowUpRight />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Building2, title: "Discover", body: "Browse opportunities and planned asset classes — demo projects are marked, never mixed with real offerings." },
    { icon: ShieldCheck, title: "Review", body: "Read the asset, its evidence, risks, fees and exit terms before anything else." },
    { icon: Landmark, title: "Get eligible", body: "Complete onboarding and any eligibility checks — a wallet alone is not enough." },
    { icon: Wallet, title: "Participate", body: "Use supported Cardano infrastructure when a valid offering is open. You sign every transaction yourself." },
    { icon: Layers, title: "Follow", body: "Track holdings, transactions and per-asset reporting in your portfolio." },
  ];
  return (
    <section id="how-it-works" className="home-container home-section scroll-mt-20">
      <SectionHeading
        eyebrow="How Stellaris works"
        title="Five steps, with the rules in view."
        description="From browsing to holding, each step shows its terms up front. Nothing on this page is a live offering — the marketplace runs on the Cardano Preprod test network."
      />
      <ol className="home-steps mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((step, i) => (
          <li key={step.title} className="home-card home-step p-5">
            <div className="flex items-center justify-between">
              <span className="home-step-num">{i + 1}</span>
              <step.icon className="h-5 w-5 text-teal" />
            </div>
            <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="border-t border-border">
      <div className="home-container home-section grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <SectionHeading eyebrow="A few important answers" title="Clarity comes first." />
          <p className="mt-4 text-sm text-muted-foreground">
            Not investment advice. Not a promise of returns.
          </p>
          <Button asChild variant="link" className="mt-5 px-0">
            <Link to="/security">
              Security & controls <ExternalLink />
            </Link>
          </Button>
        </div>
        <div>
          {FAQ.map((item, i) => (
            <div key={item.q} className="border-b border-border">
              <Button
                variant="ghost"
                aria-expanded={open === i}
                aria-controls={`home-faq-${i}`}
                onClick={() => setOpen(open === i ? null : i)}
                className="h-auto w-full justify-between gap-4 rounded-none px-0 py-5 text-left whitespace-normal hover:bg-transparent hover:text-primary"
              >
                <span className="text-sm font-semibold">{item.q}</span>
                <ChevronDown
                  className={`shrink-0 transition-transform ${open === i ? "rotate-180" : ""}`}
                />
              </Button>
              {open === i && (
                <p
                  id={`home-faq-${i}`}
                  className="pb-5 text-sm leading-relaxed text-muted-foreground"
                >
                  {item.a}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="home-dark-section">
      <div className="home-container flex flex-wrap items-center justify-between gap-8 py-16">
        <div>
          <p className="home-eyebrow text-gold">Explore Stellaris</p>
          <h2 className="mt-3 max-w-xl text-3xl font-semibold">Explore what the future of real-world ownership could look like.</h2>
          <p className="mt-3 text-sm opacity-75">
            Browse the testnet experience. No real money required.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Button asChild size="lg" className="h-12 bg-gold text-deep hover:bg-gold/90">
            <Link to="/marketplace" onClick={() => trackEvent("landing_final_cta_click")}>
              Explore the Demo <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 border-gold/50 bg-transparent text-deep-foreground hover:bg-gold/10 hover:text-deep-foreground">
            <Link to="/auth">Get Launch Updates</Link>
          </Button>
          <ShareRow
            url="/"
            text="Explore Stellaris: fractional real-world assets and a transparent reserve model on Cardano. Testnet preview — no real money."
            eventName="landing_share_click"
            label="Share Stellaris"
          />
        </div>
      </div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="max-w-2xl">
      <p className="home-eyebrow">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">{title}</h2>
      {description && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
          {description}
        </p>
      )}
    </div>
  );
}

