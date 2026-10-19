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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/StatusBadge";
import { StellarisWordmark } from "@/components/brand/Logo";
import { ShareRow } from "@/components/landing/ShareRow";
import { BRAND } from "@/config/brand";
import { STAKE_TIERS } from "@/data/staking.mock";
import { TRANSPARENCY } from "@/data/transparency.mock";
import { assetsQueryOptions, fundedPct } from "@/lib/assets-query";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { trackEvent } from "@/lib/analytics";
import homeImage from "@/assets/stellaris-home.jpg";

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
      { title: `Stellaris · Real assets, ${BRAND.productName} & transparent reserves` },
      {
        name: "description",
        content: `Explore fractional real-world assets, ${BRAND.base.ticker}, ${BRAND.staked.ticker} staking and the reserve model on Cardano. Testnet preview; property is planned, subject to legal approval.`,
      },
      { property: "og:title", content: `Stellaris · Real assets & ${BRAND.productName}` },
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
        <section className="border-b border-border bg-surface">
          <div className="home-container grid gap-4 py-5 sm:grid-cols-3">
            <TrustItem icon={Layers} title="Built on Cardano" detail="Preprod test network" />
            <TrustItem
              icon={ShieldCheck}
              title="Rules before returns"
              detail="Risks, fees and exits in view"
            />
            <TrustItem
              icon={Landmark}
              title="A reserve-first model"
              detail="Explore the illustrative allocation"
            />
          </div>
        </section>
        <ProductModel />
        <ReservePreview />
        <FeaturedAssets />
        <PropertyPreview />
        <HowItWorks />
        <FaqSection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

function MarketingNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const links = [
    { to: "/marketplace", label: "Marketplace" },
    { to: "/stake", label: "Staking" },
    { to: "/transparency", label: "Transparency" },
    { to: "/property", label: "Property" },
  ];
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur-md">
      <div className="home-container flex h-[72px] items-center justify-between gap-3">
        <Link to="/" aria-label="Stellaris home" className="shrink-0">
          <StellarisWordmark />
        </Link>
        <nav aria-label="Main navigation" className="hidden items-center gap-6 lg:flex">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground xl:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Preprod
          </span>
          <Button asChild className="h-10 px-4 sm:px-5">
            <Link to="/app" onClick={() => trackEvent("nav_open_app_click")}>
              Open app <ArrowUpRight />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="home-mobile-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X /> : <Menu />}
          </Button>
        </div>
      </div>
      {menuOpen && (
        <nav
          id="home-mobile-menu"
          aria-label="Mobile navigation"
          className="home-container grid gap-1 border-t border-border py-3 lg:hidden"
        >
          {links.map((link) => (
            <Button key={link.to} asChild variant="ghost" className="justify-start">
              <Link to={link.to} onClick={() => setMenuOpen(false)}>
                {link.label}
              </Link>
            </Button>
          ))}
        </nav>
      )}
    </header>
  );
}

function Hero() {
  return (
    <section className="home-hero relative isolate overflow-hidden">
      <img
        src={homeImage}
        alt="Illustrative solar-roofed homes overlooking farmland and the coast, not an actual offering"
        width={1920}
        height={1024}
        fetchPriority="high"
        className="absolute inset-0 -z-20 h-full w-full object-cover object-[65%_center]"
      />
      <div className="home-hero-veil absolute inset-0 -z-10" />
      <div className="home-container relative py-12 md:py-16">
        <div className="max-w-[620px]">
          <div className="inline-flex items-center gap-2 border-l-2 border-primary pl-3 text-xs font-semibold uppercase text-primary">
            Real-world assets. A clearer model.
          </div>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.05] md:text-7xl">
            Stellaris
            <span className="mt-3 block text-2xl font-medium leading-tight md:text-4xl">
              Real assets.
              <br />
              With the rules on show.
            </span>
          </h1>
          <p className="mt-6 max-w-[470px] text-base leading-relaxed text-muted-foreground md:text-lg">
            Fractional ownership, {BRAND.productName} and a reserve-first staking model. Explore
            what you hold, how it works and where the risks sit.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-6">
              <Link
                to="/marketplace"
                onClick={() => trackEvent("landing_hero_cta_click", { target: "marketplace" })}
              >
                Explore projects <ArrowRight />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="h-12 border-primary/20 bg-surface/90 px-6"
            >
              <Link to="/transparency">See the reserve model</Link>
            </Button>
          </div>
          <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            Testnet preview — no real money. Staking and reserve data are illustrative.
          </p>
        </div>
        <p className="mt-8 text-[10px] text-muted-foreground md:absolute md:bottom-4 md:right-6 md:mt-0">
          Concept image · not a listed property
        </p>
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
  return (
    <section className="border-y border-border bg-secondary/40">
      <div className="home-container home-section grid gap-10 lg:grid-cols-[1fr_1.15fr]">
        <div>
          <p className="home-eyebrow">Transparency, by design</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">
            See what sits
            <br className="hidden md:block" /> behind the token.
          </h2>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
            Four reserve sleeves. Published target bands. A first-loss reserve designed to absorb
            losses before stakers — not a guarantee against loss.
          </p>
          <div className="mt-6 border-l-2 border-success pl-4">
            <p className="text-sm font-semibold">The protocol pays before stakers</p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
              In the intended loss order, originator collateral comes first, then the protocol
              first-loss reserve, the overcollateral buffer, stakers and finally {BRAND.base.ticker}{" "}
              holders.
            </p>
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
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-5">
            <div>
              <p className="text-xs text-muted-foreground">First-loss reserve</p>
              <p className="mt-1 text-xl font-semibold">
                {TRANSPARENCY.firstLoss.levelPct}%{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  / {TRANSPARENCY.firstLoss.targetPct}% target
                </span>
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Overcollateralisation</p>
              <p className="mt-1 text-xl font-semibold">{TRANSPARENCY.overcollateral.ratioPct}%</p>
              <p className="text-xs text-muted-foreground">
                Target {TRANSPARENCY.overcollateral.targetMinPct}–
                {TRANSPARENCY.overcollateral.targetMaxPct}%
              </p>
            </div>
          </div>
        </div>
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
        <p className="mt-8 border-y border-border py-8 text-sm text-muted-foreground">
          No projects are registered yet.
        </p>
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
                className="group flex min-w-0 flex-col rounded-lg border border-border bg-surface p-6 transition-colors hover:border-primary/40"
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

function PropertyPreview() {
  return (
    <section className="border-y border-border bg-surface">
      <div className="home-container grid gap-7 py-10 md:grid-cols-[auto_1fr_auto] md:items-center">
        <span className="home-icon h-14 w-14 bg-primary/10 text-primary">
          <Building2 />
        </span>
        <div>
          <Badge tone="warning">Planned — subject to legal approval</Badge>
          <h2 className="mt-3 text-2xl font-semibold">Property: Australia & Southeast Asia</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            An exploration of fractional property ownership. Nothing is on offer yet; ownership-cap
            contracts are not built yet.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/property">
            Explore the plan <ArrowUpRight />
          </Link>
        </Button>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: Building2,
      title: "Explore the terms",
      body: "Compare projects and product models. Read the risks, fees and exit rules before deciding.",
    },
    {
      icon: Wallet,
      title: "Connect on Preprod",
      body: "Use a supported Cardano wallet with test funds. Demo projects and staking previews do not accept investments.",
    },
    {
      icon: Layers,
      title: "Follow your position",
      body: "Returns land in your wallet and show in your portfolio. Each project shows its exit rules before you invest. Returns are never guaranteed.",
    },
  ];
  return (
    <section className="home-container home-section">
      <SectionHeading
        eyebrow="From exploration to ownership"
        title="Know the rules before you participate."
      />
      <div className="mt-9 grid gap-7 md:grid-cols-3">
        {steps.map((step, i) => (
          <div key={step.title} className="border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-primary">0{i + 1}</span>
              <step.icon className="h-5 w-5 text-muted-foreground" />
            </div>
            <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </div>
        ))}
      </div>
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
    <section className="border-y border-border bg-secondary/50">
      <div className="home-container flex flex-wrap items-center justify-between gap-8 py-12">
        <div>
          <p className="home-eyebrow">Explore Stellaris</p>
          <h2 className="mt-3 text-3xl font-semibold">Start with understanding.</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Browse the testnet experience. No real money required.
          </p>
        </div>
        <div className="flex flex-col items-start gap-5">
          <Button asChild size="lg" className="h-12">
            <Link to="/marketplace" onClick={() => trackEvent("landing_final_cta_click")}>
              Explore the marketplace <ArrowRight />
            </Link>
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

function Footer() {
  return (
    <footer className="bg-surface">
      <div className="home-container grid gap-8 py-12 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <StellarisWordmark />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Real-world assets, a reserve-first model and clearer rules. Built on Cardano.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Testnet preview. Illustrative data is not live financial information.
          </p>
        </div>
        <FooterCol
          title="Explore"
          links={[
            ["Marketplace", "/marketplace"],
            ["Fractions", "/offerings"],
            [`${BRAND.staked.ticker} staking`, "/stake"],
            ["Property (planned)", "/property"],
          ]}
        />
        <FooterCol
          title="Transparency"
          links={[
            ["Reserve model", "/transparency"],
            ["Security", "/security"],
            ["Governance", "/governance"],
            ["Impact record", "/stewardship"],
          ]}
        />
        <FooterCol
          title="Your account"
          links={[
            ["My portfolio", "/app"],
            ["Invite friends", "/invite"],
            ["Learn", "/learn"],
            ["Terms", "/terms"],
          ]}
        />
      </div>
      <div className="home-container flex flex-wrap justify-between gap-3 border-t border-border py-5 text-xs text-muted-foreground">
        <span>© {new Date().getUTCFullYear()} Stellaris. Built on Cardano.</span>
        <span>Capital at risk. Rates are target, variable. Nothing is guaranteed.</span>
      </div>
    </footer>
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

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      <ul className="mt-4 space-y-3">
        {links.map(([label, to]) => (
          <li key={to}>
            <Link to={to} className="text-sm transition-colors hover:text-primary">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
