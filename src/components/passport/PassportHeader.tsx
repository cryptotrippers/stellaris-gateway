import { AlertTriangle, MapPin } from "lucide-react";
import { ShareRow } from "@/components/landing/ShareRow";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { StatusChip } from "@/components/marketplace/AssetCard";
import { categoryGroup, categoryImage, groupLabel, riskLabel } from "@/components/marketplace/asset-meta";
import { countryOf } from "@/components/marketplace/filters";
import { ClarityMeter } from "./ClarityStandard";
import type { ClarityItem } from "./clarity";
import type { PassportAsset } from "./types";

/** Section A — asset identity. */
export function PassportHeader({
  asset,
  stage,
  clarity,
}: {
  asset: PassportAsset;
  stage: string;
  clarity: ClarityItem[];
}) {
  const isDemo = asset.funding_status === "demo";
  const rows: [string, string][] = [
    ["Asset type", groupLabel(categoryGroup(asset.category))],
    ["Operator", asset.issuer],
    ["Issuing legal vehicle", "Not documented"],
    ["Operating jurisdiction", countryOf(asset.location) ?? "Not stated"],
    ["Current project stage", stage],
  ];
  return (
    <section id="identity" aria-labelledby="passport-title" className="scroll-mt-28">
      <div className="grid overflow-hidden rounded-3xl border border-border bg-card lg:grid-cols-[1.15fr_1fr]">
        <div className="relative min-h-64 lg:min-h-[420px]">
          <img
            src={categoryImage(asset.category)}
            alt=""
            width={1280}
            height={960}
            className="absolute inset-0 h-full w-full object-cover"
          />
          <div className="absolute left-4 top-4 rounded-full bg-card shadow-sm">
            <StatusChip status={asset.funding_status} />
          </div>
          <span className="absolute bottom-3 left-4 rounded bg-card/90 px-2 py-0.5 text-[11px] text-muted-foreground">
            Illustrative category image — not a photo of this asset
          </span>
        </div>
        <div className="flex flex-col p-6 md:p-8">
          <p className="home-eyebrow">Stellaris Asset Passport</p>
          <h1 id="passport-title" className="mt-2 font-display text-3xl font-semibold leading-tight text-foreground md:text-4xl">
            {asset.name}
          </h1>
          <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" aria-hidden="true" />
            {asset.location ?? "Location not stated"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <FeatureStatus stage={isDemo ? "demo" : "unverified"} />
            <FeatureStatus stage="awaiting_legal" />
          </div>
          <dl className="mt-5 divide-y divide-border rounded-xl border border-border text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className={`text-right font-medium ${v.startsWith("Not ") ? "text-muted-foreground" : "text-foreground"}`}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5">
            <ClarityMeter items={clarity} />
          </div>
          <div className="mt-auto pt-5">
            <ShareRow
              url={`/marketplace/${asset.id}`}
              text={`${asset.name} — Stellaris Asset Passport.`}
              eventName="asset_share_click"
              label="Share this passport"
            />
          </div>
        </div>
      </div>
      <div
        role={isDemo ? "alert" : "note"}
        className={`mt-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${isDemo ? "border-gold/50 bg-gold/15 text-foreground" : "border-border bg-card text-muted-foreground"}`}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
        {isDemo ? (
          <span>
            <strong className="text-foreground">Demo listing.</strong> Everything on this passport is
            illustrative. Nothing can be invested, and the issuer named is not a real counterparty.
          </span>
        ) : (
          <span>
            {riskLabel(asset.funding_status)}. Cardano Preprod testnet — test ADA only, no real money,
            and no legal claim on the underlying asset.
          </span>
        )}
      </div>
    </section>
  );
}
