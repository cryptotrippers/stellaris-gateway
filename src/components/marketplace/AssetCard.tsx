import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { StatusPill } from "@/components/brand/StatusPill";
import { ClarityMeter } from "@/components/passport/ClarityStandard";
import { clarityItems } from "@/components/passport/clarity";
import {
  categoryGroup,
  categoryImage,
  groupLabel,
  riskLabel,
  statusLabel,
  STATUS_TONE,
} from "./asset-meta";
import { fundedPercent } from "./filters";
import type { MarketAsset } from "./marketplace-query";

export type ChainReturn = { apyPct: number | null; accrualCount: number } | null;

const TONE_CLASS: Record<string, string> = {
  warning: "border-gold/40 bg-gold/15 text-foreground",
  accent: "border-teal/30 bg-teal/10 text-teal",
  success: "border-success/30 bg-success/10 text-success",
  primary: "border-border bg-card text-foreground",
};

export function StatusChip({ status }: { status: string }) {
  if (status === "demo") return <StatusPill status="demo" label="Demo listing" />;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[STATUS_TONE[status] ?? "primary"]}`}
    >
      {statusLabel(status)}
    </span>
  );
}

function ada(lovelace: number) {
  return formatAda(lovelaceToAda(Number(lovelace)));
}

export function AssetCard({
  asset,
  ret,
  vaultLive,
}: {
  asset: MarketAsset;
  ret: ChainReturn;
  vaultLive: boolean;
}) {
  const isDemo = asset.funding_status === "demo";
  const target = Number(asset.target_lovelace);
  const pct = fundedPercent(asset);
  const clarity = clarityItems({ ...asset, vaultLive });
  return (
    <article className="card-institutional card-institutional-hover group relative flex flex-col overflow-hidden">
      <div className="relative h-48 overflow-hidden">
        <img
          src={categoryImage(asset.category)}
          alt=""
          loading="lazy"
          width={1280}
          height={960}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        <div className="absolute left-3 top-3 rounded-full bg-card shadow-sm">
          <StatusChip status={asset.funding_status} />
        </div>
        <span className="absolute bottom-2 right-3 rounded bg-card/85 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Illustrative image
        </span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <p className="text-xs font-medium text-teal">{groupLabel(categoryGroup(asset.category))}</p>
        <h3 className="mt-1 font-display text-lg font-semibold leading-snug text-foreground">
          <Link
            to="/marketplace/$id"
            params={{ id: asset.id }}
            className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {asset.name}
          </Link>
        </h3>
        <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{asset.location ?? "Location not stated"}</p>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">Issuer: {asset.issuer}</p>

        <dl className="mt-4 grid grid-cols-3 gap-2">
          <Metric label="Minimum" value={ada(asset.min_deposit_lovelace)} />
          <Metric label={isDemo ? "Target (illus.)" : "Target"} value={target > 0 ? ada(target) : "Not set"} />
          <Metric label="Term" value={asset.maturity_months ? `${asset.maturity_months} mo` : "None"} />
        </dl>

        {!isDemo && target > 0 && (
          <div className="mt-4">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Funding progress (registry)</span>
              <span className="number-display font-medium text-foreground">{pct.toFixed(1)}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Funding progress">
              <div className="h-full rounded-full bg-teal" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
          <Disclosure label="Unit structure" value="Not published" />
          <Disclosure label="Risk class" value="Not classified" />
          <Disclosure label="Income source" value="Not published" />
          <Disclosure label="Last report" value="None yet" />
          <Disclosure
            label="Verification"
            value={asset.audit_report_url ? "Report link published" : "No independent audit"}
            wide
          />
          <Disclosure
            label="On-chain return"
            value={
              ret?.apyPct != null
                ? `${ret.apyPct.toFixed(1)}% annualised from settled payouts`
                : ret
                  ? `${ret.accrualCount} payout${ret.accrualCount === 1 ? "" : "s"} recorded — two needed for a rate`
                  : "No settled payouts"
            }
            wide
          />
        </dl>

        <div className="mt-4">
          <ClarityMeter items={clarity} />
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <span className={`inline-flex items-center gap-1.5 text-[11px] ${isDemo ? "font-medium text-foreground" : "text-muted-foreground"}`}>
            <AlertTriangle className="h-3 w-3 text-gold" aria-hidden="true" /> {riskLabel(asset.funding_status)}
          </span>
          <span className="inline-flex items-center gap-0.5 text-xs font-medium text-teal">
            Passport <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </div>
      </div>
    </article>
  );
}

export function AssetListRow({ asset, ret }: { asset: MarketAsset; ret: ChainReturn }) {
  const isDemo = asset.funding_status === "demo";
  const target = Number(asset.target_lovelace);
  return (
    <article className="card-institutional card-institutional-hover relative flex items-center gap-4 p-3">
      <img
        src={categoryImage(asset.category)}
        alt=""
        loading="lazy"
        width={160}
        height={112}
        className="h-16 w-24 shrink-0 rounded-lg object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">
            <Link to="/marketplace/$id" params={{ id: asset.id }} className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {asset.name}
            </Link>
          </h3>
          <StatusChip status={asset.funding_status} />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {groupLabel(categoryGroup(asset.category))} · {asset.issuer}
          {asset.location ? ` · ${asset.location}` : ""}
        </p>
        <p className={`mt-0.5 text-[11px] ${isDemo ? "font-medium text-foreground" : "text-muted-foreground"}`}>
          {riskLabel(asset.funding_status)}
        </p>
      </div>
      <dl className="hidden gap-6 text-right text-xs sm:flex">
        <div>
          <dt className="text-muted-foreground">Minimum</dt>
          <dd className="number-display font-semibold text-foreground">{ada(asset.min_deposit_lovelace)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Funded</dt>
          <dd className="number-display font-semibold text-foreground">
            {!isDemo && target > 0 ? `${fundedPercent(asset).toFixed(1)}%` : "—"}
          </dd>
        </div>
        <div className="hidden md:block">
          <dt className="text-muted-foreground">On-chain return</dt>
          <dd className="number-display font-semibold text-foreground">
            {ret?.apyPct != null ? `${ret.apyPct.toFixed(1)}%` : "—"}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/60 px-2 py-2 text-center">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="number-display mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function Disclosure({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="inline text-muted-foreground">{label}: </dt>
      <dd className="inline text-foreground">{value}</dd>
    </div>
  );
}
