import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, RefreshCw, SearchX } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { Button } from "@/components/ui/button";
import { listVaultReturns } from "@/lib/yield-chain.functions";
import { listAssetVaults } from "@/lib/asset-vaults.functions";
import { MarketplaceHero } from "@/components/marketplace/MarketplaceHero";
import { CategoryShowcase } from "@/components/marketplace/CategoryShowcase";
import { FilterBar } from "@/components/marketplace/FilterBar";
import { AssetCard, AssetListRow, type ChainReturn } from "@/components/marketplace/AssetCard";
import { marketAssetsQuery, type MarketAsset } from "@/components/marketplace/marketplace-query";
import { categoryGroup, type CategoryGroup } from "@/components/marketplace/asset-meta";
import {
  countryOf,
  filterAssets,
  hasActiveFilters,
  parseMarketSearch,
  sortAssets,
  type MarketFilters,
} from "@/components/marketplace/filters";

type MarketSearch = MarketFilters & { view?: "list" };

const TITLE = "Explore real-world assets · Stellaris Marketplace";
const DESCRIPTION =
  "Discover the real-world assets behind tokenised opportunities on Cardano. Compare ownership, risks, evidence and income before taking part. Testnet preview.";

export const Route = createFileRoute("/marketplace")({
  validateSearch: (s: Record<string, unknown>): MarketSearch => parseMarketSearch(s),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      {
        property: "og:description",
        content:
          "Real-world asset projects with structure, evidence and risks in view. Cardano Preprod testnet — no real-money offerings.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketplaceLayout,
});

function MarketplaceLayout() {
  const matchRoute = useMatchRoute();
  const onDetail = matchRoute({ to: "/marketplace/$id" });
  return (
    <MarketingLayout>
      <div className="home-container py-6 md:py-10">{onDetail ? <Outlet /> : <MarketplaceIndex />}</div>
    </MarketingLayout>
  );
}

function MarketplaceIndex() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/marketplace" });
  const set = (patch: Partial<MarketSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true, resetScroll: false });

  const assetsQ = useQuery(marketAssetsQuery());
  const assets: MarketAsset[] = assetsQ.data ?? [];
  const returnsQ = useQuery({
    queryKey: ["vault-returns"],
    queryFn: () => listVaultReturns(),
    staleTime: 300_000,
    retry: 0,
  });
  const vaultsQ = useQuery({
    queryKey: ["asset-vaults-public"],
    queryFn: () => listAssetVaults(),
    staleTime: 300_000,
    retry: 0,
  });

  const returnsByAsset = useMemo(() => {
    const m = new Map<string, ChainReturn>();
    for (const v of returnsQ.data?.vaults ?? [])
      m.set(v.assetId, { apyPct: v.apyPct, accrualCount: v.accrualCount });
    return m;
  }, [returnsQ.data]);
  const liveVaults = useMemo(
    () => new Set((vaultsQ.data ?? []).filter((v) => v.bootstrap_tx_hash).map((v) => v.asset_id)),
    [vaultsQ.data],
  );

  const options = useMemo(() => {
    const uniq = (xs: (string | null)[]) =>
      Array.from(new Set(xs.filter((x): x is string => !!x))).sort();
    return {
      groups: Array.from(new Set(assets.map((a) => categoryGroup(a.category)))),
      countries: uniq(assets.map((a) => countryOf(a.location))),
      statuses: uniq(assets.map((a) => a.funding_status)),
      operators: uniq(assets.map((a) => a.issuer)),
    };
  }, [assets]);

  const counts = useMemo(() => {
    const c: Partial<Record<CategoryGroup, { total: number; demo: number }>> = {};
    for (const a of assets) {
      const g = categoryGroup(a.category);
      const cur = c[g] ?? { total: 0, demo: 0 };
      cur.total += 1;
      if (a.funding_status === "demo") cur.demo += 1;
      c[g] = cur;
    }
    return c;
  }, [assets]);

  const filters: MarketFilters = search;
  const visible = sortAssets(filterAssets(assets, filters), search.sort);
  const view = search.view === "list" ? "list" : "grid";
  const activeCount = [
    search.q,
    search.group,
    search.country,
    search.status,
    search.availability,
    search.operator,
    search.min,
    search.term,
  ].filter(Boolean).length;
  const reset = () =>
    navigate({ search: { view: search.view, sort: search.sort }, replace: true, resetScroll: false });
  const demos = assets.filter((a) => a.funding_status === "demo").length;

  return (
    <>
      <MarketplaceHero listings={assets.length} demos={demos} loading={assetsQ.isLoading} />
      <CategoryShowcase counts={counts} loading={assetsQ.isLoading} />

      <section id="assets" aria-labelledby="assets-heading" className="mt-16 scroll-mt-28">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="home-eyebrow">Registry</p>
            <h2 id="assets-heading" className="mt-2 font-display text-3xl font-semibold text-foreground">
              Explore assets
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Every listing opens a Stellaris Asset Passport. Figures come from the project registry
              and the Cardano Preprod chain; anything not published is labelled as missing.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <FilterBar
            value={filters}
            view={view}
            options={options}
            shown={visible.length}
            total={assets.length}
            activeCount={activeCount}
            onChange={set}
            onView={(v) => set({ view: v === "list" ? "list" : undefined })}
            onReset={reset}
          />
        </div>

        {assetsQ.isLoading ? (
          <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading listings">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card-institutional overflow-hidden">
                <div className="h-48 animate-pulse bg-secondary" />
                <div className="space-y-3 p-5">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-secondary" />
                  <div className="h-5 w-2/3 animate-pulse rounded bg-secondary" />
                  <div className="h-16 animate-pulse rounded bg-secondary" />
                </div>
              </div>
            ))}
          </div>
        ) : assetsQ.isError ? (
          <div role="alert" className="mt-6 card-institutional flex flex-col items-center gap-3 p-10 text-center">
            <p className="font-medium text-foreground">We couldn&apos;t load the asset registry.</p>
            <p className="max-w-md text-sm text-muted-foreground">
              This is a connection problem on our side, not a change to any listing. Please try again.
            </p>
            <Button variant="outline" onClick={() => assetsQ.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-6 card-institutional flex flex-col items-center gap-3 p-10 text-center">
            <SearchX className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium text-foreground">
              {assets.length === 0 ? "No projects are listed yet." : "No listings match those filters."}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {assets.length === 0
                ? "A project only appears here after its issuer request passes review and governance."
                : "Try a broader category or location, or clear the filters to see every listing."}
            </p>
            {hasActiveFilters(filters) && (
              <Button variant="outline" onClick={reset}>
                Reset filters
              </Button>
            )}
          </div>
        ) : view === "grid" ? (
          <div className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((a) => (
              <AssetCard key={a.id} asset={a} ret={returnsByAsset.get(a.id) ?? null} vaultLive={liveVaults.has(a.id)} />
            ))}
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            {visible.map((a) => (
              <AssetListRow key={a.id} asset={a} ret={returnsByAsset.get(a.id) ?? null} />
            ))}
          </div>
        )}
      </section>

      <NoOfferingsNotice />
    </>
  );
}

/** Shown while no project is open for real-money participation. */
function NoOfferingsNotice() {
  return (
    <section className="protocol mt-16 overflow-hidden rounded-3xl border border-border bg-background px-6 py-12 md:px-12">
      <div className="grid gap-8 md:grid-cols-[1.4fr_1fr] md:items-center">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-aqua">
            No real-money offerings yet
          </p>
          <h2 className="mt-3 font-display text-2xl font-semibold text-foreground md:text-3xl">
            Every listing above is a testnet pilot or a demo.
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Real participation opens only after a project passes issuer verification, independent
            review and legal approval. Until then nothing here can be bought with real money.
          </p>
        </div>
        <div className="flex flex-col gap-3 md:items-end">
          <Button asChild size="lg" className="h-12 w-full md:w-auto">
            <Link to="/for-issuers" hash="enquire">
              <Building2 /> List your project
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 w-full md:w-auto">
            <Link to="/how-it-works">
              How projects are reviewed <ArrowRight />
            </Link>
          </Button>
          <p className="text-xs text-muted-foreground md:text-right">
            Product-update sign-up opens once a mailing service is approved.
          </p>
        </div>
      </div>
    </section>
  );
}
