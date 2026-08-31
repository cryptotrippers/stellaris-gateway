import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Clock, Minus, RefreshCw, ShieldCheck } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { lovelaceToAda, timeAgo } from "@/lib/chain-format";
import type { YieldFeed } from "@/lib/yield-dashboard.shared";

const REFRESH_MS = 30_000;

const SLICE_COLORS = ["var(--primary)", "var(--success)", "var(--warning)", "var(--accent)"];

async function fetchYieldFeed(): Promise<YieldFeed> {
  const res = await fetch("/api/v1/yield", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Yield feed responded ${String(res.status)}`);
  return (await res.json()) as YieldFeed;
}

/**
 * Live sUSDr dashboard: TVL, realised APY, reserve composition and redemption
 * status, refreshed every 30 seconds from `/api/v1/yield`. Every number shown
 * is decoded from the vault state UTxOs; anything without a source renders as
 * an explicit "not published" note rather than a placeholder figure.
 */
export function YieldDashboard() {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["susdr-yield-feed"],
    queryFn: fetchYieldFeed,
    refetchInterval: REFRESH_MS,
    retry: 1,
  });

  // Keep the "last updated" stamp honest between refetches.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  if (isLoading) return <DashboardSkeleton />;

  if (error || !data) {
    return (
      <section className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <div className="font-medium">Data unavailable</div>
        <p className="mt-1 text-destructive/80">
          The live yield feed could not be read right now. Nothing is estimated in its place.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      </section>
    );
  }

  const apy = data.apyPct;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">sUSDr</div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Live vault yield
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>
            {isFetching ? "Updating…" : `Last updated: ${timeAgo(data.checkedAt)}`}
          </span>
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh yield data"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:text-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <TvlCard feed={data} />
        <ApyCard apyPct={apy} weeklyYieldLovelace={data.weeklyYieldLovelace} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ReservesCard feed={data} />
        <RedemptionCard feed={data} />
      </div>

      <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Decoded from the vault state UTxOs on {data.network}. Figures without an on-chain or
        attested source are shown as unavailable rather than estimated.
      </p>
    </section>
  );
}

function TvlCard({ feed }: { feed: YieldFeed }) {
  const change = feed.tvlChange24hPct;
  const tone =
    change === null ? "text-muted-foreground" : change > 0 ? "text-success" : "text-destructive";
  const Icon = change === null ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="card-institutional p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Total value locked
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground sm:text-3xl">
        ₳{lovelaceToAda(feed.tvlLovelace)}
      </div>
      <div className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
        <Icon className="h-3.5 w-3.5" />
        {change === null
          ? "No change recorded since yesterday"
          : `${change > 0 ? "+" : ""}${change.toFixed(2)}% since yesterday`}
      </div>
      <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted-foreground">
        {feed.vaults.length === 0 && <span>No vault has been bootstrapped yet.</span>}
        {feed.vaults.map((v) => (
          <div key={v.address} className="flex items-center justify-between gap-3">
            <span className="font-mono">{v.assetId}</span>
            <span className="tabular-nums text-foreground">
              ₳{lovelaceToAda(v.totalAssetsLovelace)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApyCard({
  apyPct,
  weeklyYieldLovelace,
}: {
  apyPct: number | null;
  weeklyYieldLovelace: string;
}) {
  const tone =
    apyPct === null
      ? "text-muted-foreground"
      : apyPct > 5
        ? "text-success"
        : apyPct >= 4
          ? "text-warning"
          : "text-destructive";

  return (
    <div className="card-institutional p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Realised APY
      </div>
      <div className={`mt-2 text-4xl font-semibold tabular-nums sm:text-5xl ${tone}`}>
        {apyPct === null ? "—" : `${apyPct.toFixed(2)}%`}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {apyPct === null
          ? "Not enough verified accruals yet to quote a rate."
          : "Annualised from verified on-chain accruals."}
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Yield earned this week
        </div>
        <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">
          ₳{lovelaceToAda(weeklyYieldLovelace)}
        </div>
      </div>
    </div>
  );
}

function ReservesCard({ feed }: { feed: YieldFeed }) {
  const slices = feed.reserves;

  return (
    <div className="card-institutional p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Reserve composition
      </div>
      {!slices || slices.length === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {feed.reservesUnavailableReason ?? "No reserve breakdown is published for these vaults."}
        </p>
      ) : (
        <div className="mt-2 flex flex-col items-center gap-4 sm:flex-row">
          <DonutChart slices={slices} />

          <ul className="flex w-full flex-col gap-2 text-xs">
            {slices.map((slice, i) => (
              <li key={slice.label} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }}
                  />
                  {slice.label}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {slice.pct.toFixed(1)}% · ₳{lovelaceToAda(slice.amountLovelace)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RedemptionCard({ feed }: { feed: YieldFeed }) {
  const r = feed.redemption;
  const hasQueue = r.queueLength !== null;

  return (
    <div className="card-institutional p-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Redemption status
      </div>
      {!hasQueue ? (
        <p className="mt-3 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          {r.unavailableReason ?? "No redemption queue is in operation."}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <Stat label="Your queue position" value={r.queuePosition === null ? "—" : `#${String(r.queuePosition)}`} />
          <Stat label="Queue length" value={String(r.queueLength)} />
          <Stat
            label="Days until withdrawal"
            value={
              r.daysUntilAvailable === null
                ? "—"
                : `${String(Math.min(r.daysUntilAvailable, 7))} of max 7`
            }
          />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true" aria-label="Loading yield data">
      <div className="flex items-end justify-between gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card-institutional flex flex-col gap-3 p-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-3 w-36" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card-institutional flex flex-col gap-3 p-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

export default YieldDashboard;

/** Donut rendered with plain SVG arcs — hover a slice for its exact amount. */
function DonutChart({
  slices,
}: {
  slices: Array<{ label: string; pct: number; amountLovelace: string }>;
}) {
  const total = slices.reduce((sum, s) => sum + s.pct, 0) || 1;
  let angle = -90;
  const radius = 60;
  const center = 70;

  return (
    <svg viewBox="0 0 140 140" className="h-40 w-40 shrink-0" role="img" aria-label="Reserve composition">
      {slices.map((slice, i) => {
        const sweep = (slice.pct / total) * 360;
        const start = angle;
        const end = angle + sweep;
        angle = end;
        const rad = (deg: number) => (deg * Math.PI) / 180;
        const x1 = center + radius * Math.cos(rad(start));
        const y1 = center + radius * Math.sin(rad(start));
        const x2 = center + radius * Math.cos(rad(end));
        const y2 = center + radius * Math.sin(rad(end));
        const largeArc = sweep > 180 ? 1 : 0;
        const d =
          sweep >= 359.9
            ? `M ${center - radius} ${center} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`
            : `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
        return (
          <path key={slice.label} d={d} fill={SLICE_COLORS[i % SLICE_COLORS.length]}>
            <title>
              {slice.label}: {slice.pct.toFixed(1)}% · ₳{lovelaceToAda(slice.amountLovelace)}
            </title>
          </path>
        );
      })}
      <circle cx={center} cy={center} r={radius * 0.55} className="fill-card" />
    </svg>
  );
}
