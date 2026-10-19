import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, LayoutGrid, List, AlertTriangle, RotateCcw } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { assetsQueryOptions, fundedPct, type AssetRow } from "@/lib/assets-query";
import { listVaultReturns } from "@/lib/yield-chain.functions";
import { categoryImage, riskLabel, STATUS_TONE } from "@/components/marketplace/asset-meta";

type MarketSearch = {
  q?: string;
  category?: string;
  location?: string;
  issuer?: string;
  status?: string;
  sort?: string;
  view?: string;
};

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.slice(0, 120) : undefined);

export const Route = createFileRoute("/marketplace")({
  validateSearch: (s: Record<string, unknown>): MarketSearch => ({
    q: str(s.q),
    category: str(s.category),
    location: str(s.location),
    issuer: str(s.issuer),
    status: str(s.status),
    sort: str(s.sort),
    view: str(s.view),
  }),
  head: () => ({
    meta: [
      { title: "Real-world asset marketplace · Stellaris" },
      { name: "description", content: "Browse real-world asset projects on Cardano Preprod. Filter by asset class, location, issuer and status, with risks and data sources shown." },
      { property: "og:title", content: "Real-world asset marketplace · Stellaris" },
      { property: "og:description", content: "Real-world asset projects with the structure, evidence and risks in view. Testnet preview." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketplaceLayout,
});

function MarketplaceLayout() {
  const matchRoute = useMatchRoute();
  const onDetail = matchRoute({ to: "/marketplace/$id" });
  return <AppShell>{onDetail ? <Outlet /> : <MarketplaceIndex />}</AppShell>;
}

const SORTS: Record<string, string> = {
  newest: "Newest",
  progress: "Funding progress",
  target: "Target size",
  name: "Name",
};

function MarketplaceIndex() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/marketplace" });
  const set = (patch: Partial<MarketSearch>) =>
    navigate({ search: prev => ({ ...prev, ...patch }), replace: true });

  const { data, isLoading, error } = useQuery(assetsQueryOptions());
  const assets: AssetRow[] = data ?? [];
  const returnsQ = useQuery({
    queryKey: ["vault-returns"],
    queryFn: () => listVaultReturns(),
    staleTime: 300_000,
    retry: 0,
  });
  const returnsByAsset = useMemo(() => {
    const m = new Map<string, { apyPct: number | null; accrualCount: number }>();
    for (const v of returnsQ.data?.vaults ?? []) m.set(v.assetId, { apyPct: v.apyPct, accrualCount: v.accrualCount });
    return m;
  }, [returnsQ.data]);

  const uniq = (f: (a: AssetRow) => string | null) =>
    Array.from(new Set(assets.map(f).filter((x): x is string => !!x))).sort();
  const categories = useMemo(() => uniq(a => a.category), [assets]);
  const locations = useMemo(() => uniq(a => a.location), [assets]);
  const issuers = useMemo(() => uniq(a => a.issuer), [assets]);
  const statuses = useMemo(() => uniq(a => a.funding_status), [assets]);

  const view = search.view === "list" ? "list" : "grid";
  const sort = search.sort && SORTS[search.sort] ? search.sort : "newest";
  const q = (search.q ?? "").trim().toLowerCase();

  const filtered = assets
    .filter(a =>
      (q === "" || [a.name, a.issuer, a.category, a.location ?? ""].some(s => s.toLowerCase().includes(q))) &&
      (!search.category || a.category === search.category) &&
      (!search.location || a.location === search.location) &&
      (!search.issuer || a.issuer === search.issuer) &&
      (!search.status || a.funding_status === search.status),
    )
    .sort((a, b) => {
      if (sort === "progress") return fundedPct(b) - fundedPct(a);
      if (sort === "target") return Number(b.target_lovelace) - Number(a.target_lovelace);
      if (sort === "name") return a.name.localeCompare(b.name);
      return b.created_at.localeCompare(a.created_at);
    });

  const hasFilters = !!(search.q || search.category || search.location || search.issuer || search.status);
  const reset = () => navigate({ search: { view: search.view, sort: search.sort }, replace: true });

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl border border-border">
        <img src={categoryImage("Clean Energy")} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/40" />
        <div className="relative p-6 md:p-10">
          <div className="text-[11px] uppercase tracking-widest text-primary">Marketplace</div>
          <h1 className="mt-2 max-w-xl font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            Real assets, with the rules on show.
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            Every project shows who the issuer is, what's documented, what isn't, and where the risks sit — before you take part.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5" /> Testnet preview (Cardano Preprod). No real money.
          </div>
        </div>
      </section>

      <div className="mt-6 card-institutional p-3 md:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search.q ?? ""}
              onChange={e => set({ q: e.target.value || undefined })}
              placeholder="Search name, issuer or location…"
              aria-label="Search projects"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="flex items-center gap-1 self-end rounded-lg border border-border p-0.5">
            <ViewBtn active={view === "grid"} label="Grid view" onClick={() => set({ view: undefined })}><LayoutGrid className="h-4 w-4" /></ViewBtn>
            <ViewBtn active={view === "list"} label="List view" onClick={() => set({ view: "list" })}><List className="h-4 w-4" /></ViewBtn>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Select label="Asset class" value={search.category} options={categories} onChange={v => set({ category: v })} />
          <Select label="Location" value={search.location} options={locations} onChange={v => set({ location: v })} />
          <Select label="Issuer" value={search.issuer} options={issuers} onChange={v => set({ issuer: v })} />
          <Select label="Status" value={search.status} options={statuses} onChange={v => set({ status: v })} />
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            Sort
            <select
              value={sort}
              onChange={e => set({ sort: e.target.value === "newest" ? undefined : e.target.value })}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-foreground"
            >
              {Object.entries(SORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{filtered.length} of {assets.length} project{assets.length === 1 ? "" : "s"}</span>
          {hasFilters && (
            <button type="button" onClick={reset} className="inline-flex items-center gap-1 text-primary">
              <RotateCcw className="h-3.5 w-3.5" /> Reset filters
            </button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map(i => <div key={i} className="card-institutional h-72 animate-pulse bg-secondary/40" />)}
        </div>
      )}
      {error && (
        <div className="mt-6 card-institutional p-6 text-sm text-destructive">
          We couldn't load the projects just now. Please try again shortly.
        </div>
      )}
      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-6 card-institutional p-6 text-center text-sm text-muted-foreground">
          {assets.length === 0
            ? "No projects are listed yet. Issuers must pass verification before a project appears here."
            : "No projects match those filters."}
          {hasFilters && (
            <div><button type="button" onClick={reset} className="mt-3 text-primary">Reset filters</button></div>
          )}
        </div>
      )}

      {view === "grid" ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(a => <AssetCard key={a.id} asset={a} ret={returnsByAsset.get(a.id) ?? null} />)}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          {filtered.map(a => <AssetListRow key={a.id} asset={a} ret={returnsByAsset.get(a.id) ?? null} />)}
        </div>
      )}
    </>
  );
}

type Ret = { apyPct: number | null; accrualCount: number } | null;

function AssetCard({ asset, ret }: { asset: AssetRow; ret: Ret }) {
  const target = Number(asset.target_lovelace);
  const raised = Number(asset.raised_lovelace);
  const pct = fundedPct(asset);
  const isDemo = asset.funding_status === "demo";
  return (
    <Link to="/marketplace/$id" params={{ id: asset.id }} className="card-institutional card-institutional-hover flex flex-col overflow-hidden">
      <div className="relative h-36">
        <img src={categoryImage(asset.category)} alt="" loading="lazy" className="h-full w-full object-cover" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <Badge tone="primary">{asset.category}</Badge>
          <Badge tone={STATUS_TONE[asset.funding_status] ?? "primary"}>{asset.funding_status}</Badge>
        </div>
        <span className="absolute bottom-2 right-3 rounded bg-background/80 px-1.5 py-0.5 text-[9px] text-muted-foreground">Illustrative image</span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="text-sm font-semibold text-foreground">{asset.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{asset.issuer}{asset.location ? ` · ${asset.location}` : ""}</div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <Metric label="Min. entry" value={formatAda(lovelaceToAda(Number(asset.min_deposit_lovelace)))} />
          <Metric label="Term" value={asset.maturity_months ? `${asset.maturity_months} mo` : "—"} />
          <Metric label="Return" value={ret?.apyPct != null ? `${ret.apyPct.toFixed(1)}%` : "—"} accent={ret?.apyPct != null} />
        </div>
        {!isDemo && target > 0 && (
          <div className="mt-4">
            <FundingBar pct={pct} />
            <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
              <span>{lovelaceToAda(raised).toLocaleString()} of {lovelaceToAda(target).toLocaleString()} ₳</span>
              <span className="number-display text-foreground">{pct.toFixed(1)}%</span>
            </div>
          </div>
        )}
        <div className="mt-auto pt-4">
          <div className={`flex items-center gap-1.5 text-[11px] ${isDemo ? "text-warning" : "text-muted-foreground"}`}>
            <AlertTriangle className="h-3 w-3" /> {riskLabel(asset.funding_status)}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {ret == null ? "Return shown once settled on-chain payouts exist." : ret.apyPct != null ? "Return annualised from settled on-chain payouts." : `${ret.accrualCount} payout${ret.accrualCount === 1 ? "" : "s"} so far — a return needs two.`}
          </p>
        </div>
      </div>
    </Link>
  );
}

function AssetListRow({ asset, ret }: { asset: AssetRow; ret: Ret }) {
  const isDemo = asset.funding_status === "demo";
  const target = Number(asset.target_lovelace);
  return (
    <Link to="/marketplace/$id" params={{ id: asset.id }} className="card-institutional card-institutional-hover flex items-center gap-4 p-3">
      <img src={categoryImage(asset.category)} alt="" loading="lazy" className="h-14 w-20 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{asset.name}</span>
          <Badge tone={STATUS_TONE[asset.funding_status] ?? "primary"}>{asset.funding_status}</Badge>
        </div>
        <div className="truncate text-xs text-muted-foreground">{asset.category} · {asset.issuer}{asset.location ? ` · ${asset.location}` : ""}</div>
        <div className={`mt-0.5 text-[11px] ${isDemo ? "text-warning" : "text-muted-foreground"}`}>{riskLabel(asset.funding_status)}</div>
      </div>
      <div className="hidden text-right text-xs sm:block">
        <div className="text-muted-foreground">Funded</div>
        <div className="number-display font-semibold text-foreground">{!isDemo && target > 0 ? `${fundedPct(asset).toFixed(1)}%` : "—"}</div>
      </div>
      <div className="hidden text-right text-xs md:block">
        <div className="text-muted-foreground">Return</div>
        <div className="number-display font-semibold text-foreground">{ret?.apyPct != null ? `${ret.apyPct.toFixed(1)}%` : "—"}</div>
      </div>
    </Link>
  );
}

function Select({ label, value, options, onChange }: { label: string; value?: string; options: string[]; onChange: (v: string | undefined) => void }) {
  return (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
      {label}
      <select
        value={value ?? ""}
        onChange={e => onChange(e.target.value || undefined)}
        className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm normal-case tracking-normal text-foreground"
      >
        <option value="">All</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

function ViewBtn({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={onClick}
      className={`rounded-md p-1.5 ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
      {children}
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
