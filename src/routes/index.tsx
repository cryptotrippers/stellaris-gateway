import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Wallet,
  Coins,
  TrendingUp,
  ShieldCheck,
  Leaf,
  Sun,
  Wind,
  Building2,
  Home,
  Users,
  KeyRound,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { StellarisWordmark } from "@/components/brand/Logo";
import { ShareRow } from "@/components/landing/ShareRow";
import { useQuery } from "@tanstack/react-query";
import { assetsQueryOptions, fundedPct } from "@/lib/assets-query";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { trackEvent } from "@/lib/analytics";
import ogAsset from "@/assets/og-landing.jpg.asset.json";

const SITE = "https://stellarischain.com";
const OG_IMAGE = `${SITE}${ogAsset.url}`;

const FAQ = [
  {
    q: "Is this actually safe?",
    a: "Every project is run by a registered, audited operator, and withdrawals carry a 24h safety delay. Your share is recorded in your own name on Cardano — you hold it, not us.",
  },
  {
    q: "Do I need to know anything about crypto?",
    a: "No. You can pay by card, or connect a Cardano wallet if you already have one. Returns can be converted back to your local currency at any time.",
  },
  {
    q: "What's the minimum investment?",
    a: "You can start from ₳10 (about $4). Some projects set a higher minimum — most sit between ₳100 and ₳500.",
  },

  {
    q: "What are the fees?",
    a: "0.4% per year, streamed continuously from yield. No entry fee, no exit fee, no lockups beyond the 24h security timelock.",
  },
  {
    q: "Who can invest?",
    a: "Retail investors in 60+ jurisdictions where fractional RWAs are permitted. Our one-click ZK-KYC checks eligibility in seconds without exposing your data.",
  },
  {
    q: "What is Cardano and why does it matter?",
    a: "Cardano is a public blockchain known for peer-reviewed engineering and low fees. Using it means every share, every dividend, and every audit is transparent and verifiable — not locked inside a private database.",
  },
];

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Own real-world assets from ₳10 · Stellaris" },
      { name: "description", content: "Solar farms, coffee estates, and real estate — fractionalized on Cardano. Verified yields, ESG ratings, and 24h withdrawals. Start with ₳10." },
      { property: "og:title", content: "Own real-world assets from ₳10 · Stellaris" },
      { property: "og:description", content: "Solar farms, coffee estates, and real estate — fractionalized on Cardano. Verified yields, ESG ratings, and 24h withdrawals." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE + "/" },
      { property: "og:image", content: OG_IMAGE },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Own real-world assets from ₳10 · Stellaris" },
      { name: "twitter:description", content: "Solar farms, coffee estates, and real estate — fractionalized on Cardano." },
      { name: "twitter:image", content: OG_IMAGE },
    ],
    links: [{ rel: "canonical", href: SITE + "/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Stellaris Finance",
          url: SITE,
          potentialAction: {
            "@type": "SearchAction",
            target: `${SITE}/marketplace?q={search_term_string}`,
            "query-input": "required name=search_term_string",
          },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map(f => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }),
      },
    ],
  }),
  component: LandingPage,
});

const categoryIcon = {
  "Sustainable Farming": Leaf,
  "Clean Energy": Wind,
  "Real Estate": Building2,
  "Carbon Credits": Leaf,
  "Infrastructure": Sun,
} as const;

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[520px] bg-gradient-hero opacity-90" />
      <MarketingNav />
      <main className="relative">
        <Hero />
        <SocialProof />
        <HowItWorks />
        <FeaturedAssets />
        <ImpactStrip />
        <FaqSection />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

function MarketingNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-surface/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 md:px-6">
        <Link to="/" className="shrink-0"><StellarisWordmark /></Link>
        <nav className="ml-6 hidden md:flex items-center gap-1">
          <NavLink to="/marketplace">Invest</NavLink>
          <NavLink to="/yield">Earnings</NavLink>
          <NavLink to="/stewardship">Impact</NavLink>
          <NavLink to="/security">Security</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/app"
            onClick={() => trackEvent("nav_open_app_click")}
            className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground px-3 py-1.5"
          >
            Open app
          </Link>
          <Link
            to="/marketplace"
            onClick={() => trackEvent("nav_cta_click", { location: "topbar" })}
            className="inline-flex items-center gap-1.5 rounded-full bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow hover:-translate-y-0.5 transition-transform"
          >
            Start investing <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors">
      {children}
    </Link>
  );
}

function Hero() {
  return (
    <section className="relative mx-auto max-w-[1400px] px-4 md:px-6 pt-16 md:pt-24 pb-12 md:pb-20">
      <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr] items-center">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/70 backdrop-blur px-3 py-1 text-xs text-primary">
            <Sparkles className="h-3 w-3" /> Open to everyone · Start from ₳10
          </div>
          <h1 className="mt-5 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Own a piece of the <span className="text-transparent bg-clip-text bg-gradient-primary">real world.</span>
            <br className="hidden md:block" />
            From <span className="number-display">₳10</span>.
          </h1>
          <p className="mt-5 max-w-xl text-base md:text-lg text-muted-foreground leading-relaxed">
            Solar farms, coffee estates and property — split into small shares you can buy in a few
            taps. You can see exactly what you own and take your money out whenever you like.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/marketplace"
              onClick={() => trackEvent("landing_hero_cta_click", { target: "marketplace" })}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-primary px-6 py-3.5 text-sm md:text-base font-semibold text-primary-foreground shadow-glow hover:-translate-y-0.5 transition-transform"
            >
              Browse projects <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-6 py-3.5 text-sm md:text-base font-semibold text-foreground hover:border-primary/50 hover:bg-secondary transition-colors"
            >
              How it works
            </a>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Demo network — funds aren't real</span>
            <span className="inline-flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5 text-primary" /> Works with common Cardano wallets</span>
            <span className="inline-flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-accent" /> Everything verifiable on-chain</span>
          </div>

        </div>

        <div className="relative">
          <div className="relative rounded-3xl overflow-hidden border border-border/70 shadow-elegant">
            <img
              src={ogAsset.url}
              alt="Stellaris — own real-world assets on Cardano"
              width={1200}
              height={630}
              className="w-full h-auto"
            />
          </div>
          <div className="absolute -bottom-4 -left-4 hidden md:block rounded-2xl border border-border bg-surface/95 backdrop-blur px-4 py-3 shadow-elegant">
            <div className="text-xs text-muted-foreground">Currently running on</div>
            <div className="text-lg font-semibold text-accent">A free demo network</div>
          </div>

        </div>
      </div>
    </section>
  );
}

function SocialProof() {
  const stats = [
    { k: "Projects open", v: "0" },
    { k: "Minimum to start", v: "₳10" },
    { k: "Independent audits", v: "0" },
  ];
  return (
    <section className="relative border-y border-border/60 bg-surface/40">
      <div className="mx-auto max-w-[1400px] px-4 md:px-6 py-8 grid grid-cols-3 gap-6">
        {stats.map(s => (
          <div key={s.k} className="text-center md:text-left">
            <div className="number-display text-2xl md:text-3xl font-semibold text-foreground">{s.v}</div>
            <div className="mt-1 text-xs text-muted-foreground">{s.k}</div>
          </div>
        ))}
      </div>
      <div className="mx-auto max-w-[1400px] px-4 md:px-6 pb-6 -mt-3 text-xs text-muted-foreground">
        This is a demo build on a test network — no real money is involved.
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Coins, title: "Pick a project", body: "Browse real things — solar, farms, property. Each one shows what it does and what it aims to pay." },
    { icon: Wallet, title: "Connect a wallet", body: "Link a Cardano wallet and put in as little as ₳10. Your share is recorded in your own name, not ours." },
    { icon: TrendingUp, title: "Track your earnings", body: "Returns land back in your wallet and show up in your portfolio. Withdraw whenever you want." },
  ];
  return (
    <section id="how-it-works" className="mx-auto max-w-[1400px] px-4 md:px-6 py-16 md:py-24 scroll-mt-20">
      <div className="max-w-2xl">
        <div className="text-sm font-medium text-primary">How it works</div>
        <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">Three steps. No jargon.</h2>
        <p className="mt-3 text-muted-foreground">The kind of investments that used to need a private banker — now open to anyone, starting at ₳10.</p>
      </div>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <div key={s.title} className="card-institutional card-institutional-hover p-6 relative">
            <div className="absolute top-4 right-4 number-display text-4xl font-semibold text-primary/10">0{i + 1}</div>
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-primary text-primary-foreground shadow-glow">
              <s.icon className="h-6 w-6" />
            </div>
            <h3 className="mt-5 text-lg font-semibold text-foreground">{s.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}


function FeaturedAssets() {
  const { data: assets, isLoading, error } = useQuery(assetsQueryOptions());
  const featured = (assets ?? []).slice(0, 6);
  return (
    <section className="relative bg-surface/40 border-y border-border/60">
      <div className="mx-auto max-w-[1400px] px-4 md:px-6 py-16 md:py-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-primary">Featured projects</div>
            <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">Real things that make real money.</h2>
          </div>
          <Link to="/marketplace" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80">
            All projects <ArrowUpRight className="h-4 w-4" />
          </Link>

        </div>

        {isLoading && (
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="card-institutional h-56 animate-pulse bg-secondary/40" />
            ))}
          </div>
        )}
        {error && (
          <div className="mt-8 card-institutional p-6 text-sm text-destructive">
            We couldn't load the projects right now. Please try again shortly.
          </div>
        )}
        {!isLoading && !error && featured.length === 0 && (
          <div className="mt-8 card-institutional p-6 text-sm text-muted-foreground">
            No projects are open yet. Operators must pass verification before their project is listed here.
          </div>
        )}


        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featured.map(asset => {
            const Icon = (categoryIcon as Record<string, typeof Leaf>)[asset.category] ?? Building2;
            const pct = fundedPct(asset);
            return (
              <Link
                key={asset.id}
                to="/marketplace/$id"
                params={{ id: asset.id }}
                onClick={() => trackEvent("landing_asset_click", { asset: asset.id })}
                className="card-institutional card-institutional-hover p-5 flex flex-col"
              >
                <div className="flex items-center justify-between">
                  <Badge tone="primary">{asset.category}</Badge>
                  <Badge tone="accent">{asset.funding_status}</Badge>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-primary-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{asset.name}</div>
                    <div className="text-xs text-muted-foreground">{asset.location ?? asset.issuer}</div>
                  </div>
                </div>
                {asset.description && (
                  <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{asset.description}</p>
                )}
                <div className="mt-4 flex items-end justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Raised</div>
                    <div className="number-display text-2xl font-semibold text-accent">
                      {formatAda(lovelaceToAda(Number(asset.raised_lovelace)))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Funded</div>
                    <div className="number-display text-sm font-semibold text-foreground">{pct.toFixed(1)}%</div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ImpactStrip() {
  return (
    <section className="mx-auto max-w-[1400px] px-4 md:px-6 py-16 md:py-24">
      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr] items-center">
        <div>
          <div className="text-sm font-medium text-success">Verifiable impact</div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">Every ₳ has a footprint you can check.</h2>
          <p className="mt-3 text-muted-foreground">Impact numbers only appear here once they've been independently checked and recorded. Nothing is estimated.</p>
          <Link to="/stewardship" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80">
            See the impact record <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="card-institutional p-8">
          <div className="text-sm font-semibold text-foreground">No impact results published yet</div>
          <p className="mt-2 text-sm text-muted-foreground">
            Each project reports at the end of its reporting period. Once the first one is checked, you'll see
            CO₂ avoided, households powered, hectares protected and producers financed here — each linked to its record.
          </p>

        </div>
      </div>
    </section>
  );
}

function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="mx-auto max-w-[900px] px-4 md:px-6 py-16 md:py-24">
      <div className="text-center">
        <div className="text-sm font-medium text-primary">FAQ</div>
        <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">Everything you're probably wondering.</h2>
      </div>
      <div className="mt-10 space-y-3">
        {FAQ.map((item, i) => {
          const isOpen = open === i;
          return (
            <div key={item.q} className="card-institutional overflow-hidden">
              <button
                onClick={() => setOpen(isOpen ? null : i)}
                className="w-full flex items-center justify-between gap-4 p-5 text-left"
              >
                <span className="text-base font-semibold text-foreground">{item.q}</span>
                <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && (
                <div className="px-5 pb-5 text-sm text-muted-foreground leading-relaxed">{item.a}</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-[1400px] px-4 md:px-6 pb-20">
      <div className="card-institutional bg-gradient-to-br from-primary via-primary to-[oklch(0.28_0.16_264)] p-10 md:p-16 text-primary-foreground text-center relative overflow-hidden">
        <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/30 blur-3xl" />
        <div className="absolute -left-24 -bottom-24 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
        <div className="relative">
          <h2 className="text-3xl md:text-5xl font-semibold tracking-tight">Start with ₳10. Own something real.</h2>
          <p className="mt-4 max-w-xl mx-auto text-primary-foreground/80">The rich have owned real assets forever. It's your turn.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/marketplace"
              onClick={() => trackEvent("landing_final_cta_click")}
              className="inline-flex items-center gap-2 rounded-xl bg-white text-primary px-6 py-3.5 text-base font-semibold hover:-translate-y-0.5 transition-transform"
            >
              Browse projects <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/app"
              className="inline-flex items-center gap-2 rounded-xl border border-primary-foreground/30 bg-primary-foreground/10 backdrop-blur px-6 py-3.5 text-base font-semibold text-primary-foreground hover:bg-primary-foreground/20 transition-colors"
            >
              My portfolio
            </Link>

          </div>
          <div className="mt-10 flex justify-center">
            <ShareRow
              url="/"
              text="I found a way to own solar farms, coffee estates, and real estate from ₳10. On Cardano."
              eventName="landing_share_click"
              label="Tell a friend"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border/60 bg-surface/40">
      <div className="mx-auto max-w-[1400px] px-4 md:px-6 py-12 grid gap-8 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <StellarisWordmark />
          <p className="mt-3 text-sm text-muted-foreground max-w-sm">Small shares of real-world projects, on Cardano. Simple to use, seriously engineered.</p>
        </div>
        <FooterCol title="Product" links={[["Invest", "/marketplace"], ["Earnings", "/yield"], ["Vote", "/governance"]]} />
        <FooterCol title="Trust" links={[["Security", "/security"], ["Impact", "/stewardship"], ["Developers", "/developers"]]} />
        <FooterCol title="Account" links={[["My portfolio", "/app"], ["Upgrade", "/upgrade"]]} />

      </div>
      <div className="border-t border-border/60">
        <div className="mx-auto max-w-[1400px] px-4 md:px-6 py-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} Stellaris Finance. Built on Cardano.</span>
          <span>Not investment advice. Yield is not guaranteed.</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">{title}</div>
      <ul className="mt-3 space-y-2 text-sm">
        {links.map(([label, to]) => (
          <li key={to}><Link to={to} className="text-foreground/85 hover:text-primary transition-colors">{label}</Link></li>
        ))}
      </ul>
    </div>
  );
}
