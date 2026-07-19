import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Search, Filter, Leaf, Wind, Building2, Sun, Landmark } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";

type AssetRow = {
  id: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  description: string | null;
  target_lovelace: number;
  raised_lovelace: number;
  maturity_months: number | null;
  funding_status: string;
};


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
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase
      .from("assets")
      .select("id,name,category,issuer,location,description,target_lovelace,raised_lovelace,maturity_months,funding_status")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { setError(error.message); setAssets([]); return; }
        setAssets((data ?? []) as AssetRow[]);
      });
    return () => { alive = false; };
  }, []);

  const filtered = (assets ?? []).filter(a =>
    query === "" ||
    a.name.toLowerCase().includes(query.toLowerCase()) ||
    a.category.toLowerCase().includes(query.toLowerCase()) ||
    a.issuer.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Marketplace</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Real-World Asset Opportunities</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Fractionalised, transparent, on-chain settlement in ADA. Assets appear here once issuers register and pass verification.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{(assets ?? []).length} live vault{(assets ?? []).length === 1 ? "" : "s"}</Badge>
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
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-4 w-4" />
          Live from on-chain registry
        </div>
      </div>

      {assets === null && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">Loading assets…</div>
      )}
      {error && (
        <div className="mt-6 card-institutional p-6 text-sm text-destructive">Failed to load assets: {error}</div>
      )}
      {assets && filtered.length === 0 && !error && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">
          No assets are registered yet. Issuers must complete on-chain verification before their vaults appear here.
        </div>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(asset => {
          const Icon = (categoryIcon as Record<string, typeof Leaf>)[asset.category] ?? Landmark;
          const target = Number(asset.target_lovelace);
          const raised = Number(asset.raised_lovelace);
          const fundedPct = target > 0 ? Math.min(100, (raised / target) * 100) : 0;
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
