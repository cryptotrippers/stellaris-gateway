import { createFileRoute, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Filter, Leaf, Wind, Building2, Sun, Landmark } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { assetsQueryOptions, fundedPct, type AssetRow } from "@/lib/assets-query";
import { listVaultReturns } from "@/lib/yield-chain.functions";



export const Route = createFileRoute("/marketplace")({
  head: () => ({
    meta: [
      { title: "Invest in real-world projects · Stellaris" },
      { name: "description", content: "Farms, solar, property and infrastructure split into small shares anyone can buy — with clear returns and verified operators." },
      { property: "og:title", content: "Invest in real-world projects · Stellaris" },
      { property: "og:description", content: "Small shares of real things: farms, solar, property. Clear returns, verified operators." },
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

  // Realised returns for every bootstrapped vault, read straight from chain.
  const returnsQ = useQuery({
    queryKey: ["vault-returns"],
    queryFn: () => listVaultReturns(),
    staleTime: 300_000,
    retry: 0,
  });
  const returnsByAsset = useMemo(() => {
    const m = new Map<string, { apyPct: number | null; accrualCount: number }>();
    for (const v of returnsQ.data?.vaults ?? []) {
      m.set(v.assetId, { apyPct: v.apyPct, accrualCount: v.accrualCount });
    }
    return m;
  }, [returnsQ.data]);

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
          <div className="text-[11px] tracking-wide text-primary">Invest</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Projects you can invest in</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Real things — farms, solar, property — split into small shares anyone can buy. Projects appear here once the issuer has been verified.</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="accent">{assets.length} open project{assets.length === 1 ? "" : "s"}</Badge>
        </div>
      </div>


      {/* Filters */}
      <div className="mt-6 card-institutional p-3 md:p-4 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by project, operator, place, or type…"
            className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Filter className="h-4 w-4" />
          Updated live
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
          We couldn't load the projects just now. Please try again shortly.
        </div>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-6 card-institutional p-6 text-sm text-muted-foreground">
          {assets.length === 0
            ? "No projects are open yet. Operators must pass verification before their project is listed here."
            : "No projects match those filters."}
        </div>
      )}



      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map(asset => {
          const Icon = (categoryIcon as Record<string, typeof Leaf>)[asset.category] ?? Landmark;
          const target = Number(asset.target_lovelace);
          const raised = Number(asset.raised_lovelace);
          const pct = fundedPct(asset);
          const ret = returnsByAsset.get(asset.id) ?? null;
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

              <div className="mt-5 grid grid-cols-4 gap-2 text-center">
                <Metric label="Raised" value={`${lovelaceToAda(raised).toLocaleString()} ₳`} accent />
                <Metric label="Target" value={target > 0 ? formatAda(lovelaceToAda(target)) : "—"} />
                <Metric
                  label="Return"
                  value={ret?.apyPct != null ? `${ret.apyPct.toFixed(1)}%` : "—"}
                  accent={ret?.apyPct != null}
                />
                <Metric label="Term" value={asset.maturity_months ? `${asset.maturity_months}mo` : "—"} />
              </div>

              <FundingBar pct={pct} />
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {lovelaceToAda(raised).toLocaleString()} of{" "}
                  {target > 0 ? `${lovelaceToAda(target).toLocaleString()} ₳` : "—"} raised
                </span>
                <span className="number-display text-foreground">{pct.toFixed(1)}%</span>
              </div>
              <p className="mt-1.5 text-[10px] text-muted-foreground">
                {ret == null
                  ? "Return shown once this project's vault goes live on chain."
                  : ret.apyPct != null
                    ? "Return is annualised from settled on-chain payouts."
                    : `Vault live · ${ret.accrualCount} payout${ret.accrualCount === 1 ? "" : "s"} so far — a return needs two.`}
              </p>
            </Link>
          );
        })}
      </div>
    </>
  );

}

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
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
