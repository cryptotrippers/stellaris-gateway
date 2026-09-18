import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { listOfferings } from "@/lib/offerings.functions";
import { OFFERING_STATUS_COPY } from "@/lib/offerings.shared";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import { formatDepositAmount } from "@/lib/deposit-assets.shared";

const TITLE = "Own a fraction of a real asset — Stellaris";
const DESCRIPTION =
  "Buy a fraction of a real, working asset on Cardano. Every fraction is a token in your own wallet: you can see what you own, send it, or sell it, and check the whole register on chain.";

export const Route = createFileRoute("/offerings/")({
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
  component: OfferingsPage,
});

function OfferingsPage() {
  const offeringsQ = useQuery({ queryKey: ["offerings"], queryFn: () => listOfferings() });
  const assetsQ = useQuery({ queryKey: ["deposit-assets"], queryFn: () => listDepositAssets() });
  const rows = offeringsQ.data ?? [];

  return (
    <AppShell>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Fractions on offer
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Each listing splits one real asset into a fixed number of equal fractions. Buy as many as
          you like; they land in your own wallet as tokens you can hold, send or sell. Nothing here
          promises a return — what you can check is how many fractions exist, who holds them, and
          what has actually been paid in.
        </p>
      </header>

      {offeringsQ.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading listings…
        </p>
      ) : offeringsQ.isError ? (
        <p className="mt-8 text-sm text-destructive">{(offeringsQ.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <p className="mt-8 max-w-xl text-sm text-muted-foreground">
          No asset has been opened for fractional ownership yet. When one is, it appears here with
          its price per fraction and its on-chain address.
        </p>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {rows.map((o) => {
            const denom =
              (assetsQ.data ?? []).find((a) => a.id === o.deposit_asset_id) ??
              (assetsQ.data ?? []).find((a) => a.policy_id === "");
            return (
              <li key={o.id} className="card-institutional p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{o.asset_id}</div>
                    <div className="text-xs text-muted-foreground">{o.issuer_name}</div>
                  </div>
                  <Badge tone={o.status === "open" ? "success" : "muted"}>
                    {OFFERING_STATUS_COPY[o.status].label}
                  </Badge>
                </div>
                <dl className="mt-4 space-y-1 text-xs">
                  <Row label="Fractions" value={o.total_fractions.toLocaleString()} />
                  <Row
                    label="Price each"
                    value={
                      denom
                        ? formatDepositAmount(o.price_per_fraction, denom, 6)
                        : `${o.price_per_fraction} base units`
                    }
                  />
                  <Row label="Policy id" value={o.fraction_policy_id} mono />
                </dl>
                <Link
                  to="/offerings/$id"
                  params={{ id: o.asset_id }}
                  className="mt-4 inline-block text-xs font-medium text-primary hover:underline"
                >
                  View this listing →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppShell>
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
