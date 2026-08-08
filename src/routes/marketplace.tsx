import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Filter, Leaf, Wind, Building2, Sun, Landmark } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { assetsQueryOptions, fundedPct, type AssetRow } from "@/lib/assets-query";



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

const STATUS_TONE: Record<string, "primary" | "accent" | "warning" | "success"> = {
  pilot: "warning",
  draft: "warning",
  open: "accent",
  funded: "success",
  closed: "primary",
};

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
  const [category, setCategory] = useState<string>("all");
  const { data, isLoading, error } = useQuery(assetsQueryOptions());
  const assets: AssetRow[] = data ?? [];

  const categories = useMemo(
    () => Array.from(new Set(assets.map(a => a.category))).sort(),
    [assets],
  );

  const filtered = assets.filter(a => {
    const q = query.trim().toLowerCase();
    const matchesQuery =
      q === "" ||
      a.name.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      a.issuer.toLowerCase().includes(q) ||
      (a.location ?? "").toLowerCase().includes(q);
    const matchesCategory = category === "all" || a.category === category;
    return matchesQuery && matchesCategory;
  });

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Marketplace</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Real-World Asset Opportunities</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Fractionalised, transparent, on-chain settlement in ADA. Assets appear here once issuers register and pass verification.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{assets.length} live vault{assets.length === 1 ? "" : "s"}</Badge>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 card-institutional p-3 md:p-4 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by asset, issuer, location, or category…"
            className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-4 w-4" />
          Live from the on-chain registry
        </div>
      </div>

      {categories.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <CategoryChip label="All" active={category === "all"} onClick={() => setCategory("all")} />
          {categories.map(c => (
            <CategoryChip key={c} label={c} active={category === c} onClick={() => setCategory(c)} />
          ))}
        </div>
      )}

      {isLoading && (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="card-institutional h-64 animate-pulse bg-secondary/40" />
          ))}
        </div>
      )}
      {error && (
        <div className="mt-6 card-institutional p-6 text-sm text-destructive">
          Failed to load assets: {(error as Error).message}
        </div>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">
          {assets.length === 0
            ? "No assets are registered yet. Issuers must complete on-chain verification before their vaults appear here."
            : "No vaults match those filters."}
        </div>
      )}


      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(asset => {
          const Icon = (categoryIcon as Record<string, typeof Leaf>)[asset.category] ?? Landmark;
          const target = Number(asset.target_lovelace);
          const raised = Number(asset.raised_lovelace);
          const pct = fundedPct(asset);
          return (
            <Link
              key={asset.id}
              to="/marketplace/$id"
              params={{ id: asset.id }}
              className="card-institutional card-institutional-hover p-5 flex flex-col"
            >
              <div className="flex items-center justify-between">
                <Badge tone="primary">{asset.category}</Badge>
                <Badge tone={STATUS_TONE[asset.funding_status] ?? "primary"}>{asset.funding_status}</Badge>
              </div>
              <div className="mt-4 flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-primary-foreground">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{asset.name}</div>
                  <div className="text-xs text-muted-foreground">{asset.location ?? "—"} · {asset.issuer}</div>
                </div>
              </div>
              {asset.description && (
                <p className="mt-3 text-xs text-muted-foreground line-clamp-2">{asset.description}</p>
              )}

              <div className="mt-5 grid grid-cols-3 gap-3 text-center">
                <Metric label="Raised" value={`${lovelaceToAda(raised).toLocaleString()} ₳`} accent />
                <Metric label="Target" value={target > 0 ? formatAda(lovelaceToAda(target)) : "—"} />
                <Metric label="Term" value={asset.maturity_months ? `${asset.maturity_months}mo` : "—"} />
              </div>

              <FundingBar pct={fundedPct} />
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Funded</span>
                <span className="number-display text-foreground">{fundedPct.toFixed(1)}%</span>
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
