import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Search, Filter, Leaf, Wind, Building2, Sun } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge, RiskBadge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { ASSETS, formatAda, type RiskProfile } from "@/lib/mock-data";

export const Route = createFileRoute("/marketplace")({
  head: () => ({
    meta: [
      { title: "Asset Marketplace · Stellaris Finance" },
      { name: "description", content: "Fractionalized real-world assets: sustainable farming, clean energy, real estate, carbon credits, and infrastructure — on Cardano." },
      { property: "og:title", content: "RealFi Asset Marketplace · Stellaris" },
      { property: "og:description", content: "Institutional-grade tokenized RWAs with verified ESG ratings and transparent yields." },
    ],
  }),
  component: MarketplaceLayout,
});

const categoryIcon = {
  "Sustainable Farming": Leaf,
  "Clean Energy": Wind,
  "Real Estate": Building2,
  "Carbon Credits": Leaf,
  "Infrastructure": Sun,
} as const;

const RISKS: (RiskProfile | "All")[] = ["All", "Conservative", "Moderate", "Aggressive"];

function MarketplaceLayout() {
  const matchRoute = useMatchRoute();
  const onDetail = matchRoute({ to: "/marketplace/$id" });
  if (onDetail) {
    return <AppShell><Outlet /></AppShell>;
  }
  return <AppShell><MarketplaceIndex /></AppShell>;
}

function MarketplaceIndex() {
  const [query, setQuery] = useState("");
  const [risk, setRisk] = useState<RiskProfile | "All">("All");

  const filtered = ASSETS.filter(a =>
    (risk === "All" || a.risk === risk) &&
    (query === "" || a.name.toLowerCase().includes(query.toLowerCase()) || a.category.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Marketplace</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Real-World Asset Opportunities</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Curated, ZK-verified issuers. Fractionalized, transparent, on-chain settlement in ADA.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{ASSETS.length} live vaults</Badge>
          <Badge tone="success">ZK-KYC bridged</Badge>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 card-institutional p-3 md:p-4 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by asset, issuer, or category…"
            className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          {RISKS.map(r => (
            <button
              key={r}
              onClick={() => setRisk(r)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                risk === r ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground hover:text-foreground"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(asset => {
          const Icon = categoryIcon[asset.category];
          return (
            <Link
              key={asset.id}
              to="/marketplace/$id"
              params={{ id: asset.id }}
              className="card-institutional card-institutional-hover p-5 flex flex-col"
            >
              <div className="flex items-center justify-between">
                <Badge tone="primary">{asset.category}</Badge>
                <RiskBadge risk={asset.risk} />
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-primary-foreground">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{asset.name}</div>
                  <div className="text-xs text-muted-foreground">{asset.location} · {asset.issuer}</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{asset.description}</p>

              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                <Metric label="APY" value={`${asset.apy}%`} accent />
                <Metric label="ESG" value={asset.esgRating} />
                <Metric label="Term" value={`${asset.maturityMonths}mo`} />
              </div>

              <FundingBar pct={asset.fundedPct} />
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Target</span>
                <span className="number-display text-foreground">{formatAda(asset.targetAda)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-secondary/50 py-2">
      <div className="text-[9.5px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display text-sm font-semibold ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}
