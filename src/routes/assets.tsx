import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import {
  DEPOSIT_STATUS_COPY,
  depositAssetUnit,
  isAdaAsset,
  type DepositAsset,
} from "@/lib/deposit-assets.shared";
import { APP_NETWORK } from "@/lib/network";

const TITLE = "Accepted assets — open Cardano RWA entry point";
const DESCRIPTION =
  "The open registry of Cardano denominations this aggregator recognises: ADA today, plus published interfaces for USDM, iUSD and other issuers to plug into real-world-asset vaults without an exclusive partnership.";

export const Route = createFileRoute("/assets")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AssetsPage,
});

function AssetsPage() {
  const q = useQuery({ queryKey: ["deposit-assets"], queryFn: () => listDepositAssets() });
  const rows = q.data ?? [];
  const onThisNetwork = rows.filter((r) => r.network === APP_NETWORK);
  const elsewhere = rows.filter((r) => r.network !== APP_NETWORK);

  return (
    <AppShell>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Accepted assets</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          This is an entry point for Cardano capital into real-world assets, not a single issuer's
          storefront. Every denomination is recorded by its ledger unit — policy id and asset name —
          so a new stablecoin issuer can be listed without changing the vault logic or signing an
          exclusive deal.
        </p>
      </header>

      {q.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the registry…
        </p>
      ) : q.isError ? (
        <p className="mt-8 text-sm text-destructive">{(q.error as Error).message}</p>
      ) : (
        <>
          <Section
            title={`On this network (${APP_NETWORK})`}
            blurb="What vaults here can actually be denominated in right now."
            rows={onThisNetwork}
          />
          <Section
            title="Published interfaces"
            blurb="Recorded on other networks so integrators can verify the exact unit ahead of time. Listing an asset is not an endorsement of its issuer."
            rows={elsewhere}
          />
        </>
      )}

      <section className="mt-10 rounded-xl border border-border bg-secondary/20 p-5">
        <h2 className="text-sm font-semibold text-foreground">For issuers and integrators</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Vault backends implement a single open interface — describe, read accounting, deposit,
          withdraw — with CIP-0113 token identity and CIP-0143 style share accounting (share price
          is <span className="text-foreground">total assets ÷ total shares</span>, redemption value
          is always derived). See <code className="text-foreground">src/lib/rwa-adapter.ts</code>{" "}
          and the developer reference for the pinned validator hashes.
        </p>
      </section>
    </AppShell>
  );
}

function Section({
  title,
  blurb,
  rows,
}: {
  title: string;
  blurb: string;
  rows: DepositAsset[];
}) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{blurb}</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {rows.map((a) => (
          <li key={a.id} className="card-institutional p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">{a.symbol}</div>
                <div className="text-xs text-muted-foreground">{a.display_name}</div>
              </div>
              <Badge
                tone={a.status === "live" ? "success" : a.status === "test" ? "warning" : "muted"}
              >
                {DEPOSIT_STATUS_COPY[a.status].label}
              </Badge>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {DEPOSIT_STATUS_COPY[a.status].hint}
            </p>
            <dl className="mt-3 space-y-1 text-[11px]">
              <Row label="Issuer" value={a.issuer_name} />
              <Row label="Decimals" value={String(a.decimals)} />
              <Row
                label="Ledger unit"
                value={isAdaAsset(a) ? "lovelace (native ADA)" : depositAssetUnit(a)}
                mono
              />
            </dl>
            {a.docs_url && (
              <a
                href={a.docs_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Issuer documentation <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-all text-foreground${mono ? " font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
