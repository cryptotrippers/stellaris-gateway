import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { BuyFractionsCard } from "@/components/fractions/BuyFractionsCard";
import { getOffering, readFractionHolders, readOfferingChainState } from "@/lib/offerings.functions";
import { OFFERING_STATUS_COPY, soldPercent } from "@/lib/offerings.shared";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import { depositAssetUnit, formatDepositAmount } from "@/lib/deposit-assets.shared";
import { backingPerFraction } from "@/lib/offering-chain";
import { cardanoscanTx, short } from "@/lib/chain-format";

export const Route = createFileRoute("/offerings/$id")({
  head: ({ params }) => {
    const title = `Fractions of ${params.id} — Stellaris`;
    const description = `Buy a fraction of ${params.id} on Cardano. See how many fractions exist, who holds them, and what has actually been paid in — all read from the chain.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: OfferingDetailPage,
});

function OfferingDetailPage() {
  const { id } = Route.useParams();

  const offeringQ = useQuery({
    queryKey: ["offering", id],
    queryFn: () => getOffering({ data: { assetId: id } }),
  });
  const assetsQ = useQuery({ queryKey: ["deposit-assets"], queryFn: () => listDepositAssets() });
  const offering = offeringQ.data ?? null;

  const denom =
    (assetsQ.data ?? []).find((a) => a.id === offering?.deposit_asset_id) ??
    (assetsQ.data ?? []).find((a) => a.policy_id === "") ??
    null;

  const chainQ = useQuery({
    queryKey: ["offering-chain", offering?.script_address, denom?.id],
    enabled: Boolean(offering && denom),
    refetchInterval: 30_000,
    queryFn: () =>
      readOfferingChainState({
        data: {
          address: offering!.script_address,
          unit: denom ? depositAssetUnit(denom) : "lovelace",
        },
      }),
  });

  const holdersQ = useQuery({
    queryKey: ["fraction-holders", offering?.fraction_policy_id],
    enabled: Boolean(offering),
    queryFn: () =>
      readFractionHolders({
        data: {
          fractionUnit: `${offering!.fraction_policy_id}${offering!.fraction_asset_name_hex}`,
        },
      }),
  });

  if (offeringQ.isLoading) {
    return (
      <AppShell>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading this listing…
        </p>
      </AppShell>
    );
  }

  if (!offering) {
    return (
      <AppShell>
        <h1 className="text-2xl font-semibold text-foreground">Listing not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No asset with the id “{id}” has been opened for fractional ownership.
        </p>
        <Link to="/offerings" className="mt-4 inline-block text-sm text-primary hover:underline">
          Back to all listings
        </Link>
      </AppShell>
    );
  }

  const datum = chainQ.data?.datum ?? null;

  return (
    <AppShell>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {offering.asset_id}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Listed by {offering.issuer_name}</p>
        </div>
        <Badge tone={(datum?.status ?? offering.status) === "open" ? "success" : "muted"}>
          {OFFERING_STATUS_COPY[datum?.status ?? offering.status].label}
        </Badge>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="space-y-6">
          <div className="card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground">What the chain says right now</h2>
            {chainQ.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading the offering…
              </p>
            ) : chainQ.isError ? (
              <p className="mt-3 text-sm text-destructive">{(chainQ.error as Error).message}</p>
            ) : !datum ? (
              <p className="mt-3 text-sm text-muted-foreground">
                This listing is registered but has not been opened on chain yet, so there is nothing
                to buy.
              </p>
            ) : (
              <>
                <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${soldPercent(datum)}%` }}
                  />
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
                  <Stat label="Fractions total" value={Number(datum.totalFractions).toLocaleString()} />
                  <Stat label="Taken" value={Number(datum.minted).toLocaleString()} />
                  <Stat label="In circulation" value={Number(datum.outstanding).toLocaleString()} />
                  <Stat
                    label="Price each"
                    value={denom ? formatDepositAmount(datum.price, denom, 6) : datum.price}
                  />
                  <Stat
                    label="Paid in so far"
                    value={denom ? formatDepositAmount(datum.pool, denom, 2) : datum.pool}
                  />
                  <Stat
                    label="Backing per fraction"
                    value={
                      denom
                        ? formatDepositAmount(backingPerFraction(datum), denom, 6)
                        : backingPerFraction(datum).toString()
                    }
                  />
                </dl>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Read from Cardano via Blockfrost at{" "}
                  {new Date(chainQ.data!.readAt).toLocaleTimeString()}. Anyone can re-derive these
                  numbers from the address below.
                </p>
                {chainQ.data?.warning && (
                  <p className="mt-2 text-xs text-destructive">{chainQ.data.warning}</p>
                )}
              </>
            )}
          </div>

          <div className="card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground">Who holds the fractions</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              The full register, straight from the chain — not a list we keep.
            </p>
            {holdersQ.isLoading ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading holders…
              </p>
            ) : holdersQ.isError ? (
              <p className="mt-3 text-sm text-destructive">{(holdersQ.error as Error).message}</p>
            ) : (holdersQ.data?.holders.length ?? 0) === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No fractions have been bought yet.</p>
            ) : (
              <>
                <ul className="mt-3 divide-y divide-border/60 text-xs">
                  {holdersQ.data!.holders.map((h) => (
                    <li key={h.address} className="flex items-center justify-between gap-3 py-2">
                      <span className="break-all font-mono text-[11px] text-muted-foreground">
                        {short(h.address)}
                      </span>
                      <span className="text-foreground">{h.fractions}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Held in wallets: {holdersQ.data!.total}
                  {datum ? ` · in circulation per the offering: ${datum.outstanding}` : ""}.
                  {datum && holdersQ.data!.total !== datum.outstanding
                    ? " These differ while a recent transaction is still settling."
                    : " These match, so every fraction is accounted for."}
                </p>
              </>
            )}
          </div>

          <div className="card-institutional p-6 text-xs">
            <h2 className="text-sm font-semibold text-foreground">Verify it yourself</h2>
            <dl className="mt-3 space-y-1">
              <Row label="Offering address" value={offering.script_address} mono />
              <Row label="Fraction policy" value={offering.fraction_policy_id} mono />
              <Row label="Script hash" value={offering.script_hash} mono />
            </dl>
            {offering.bootstrap_tx_hash && (
              <a
                href={cardanoscanTx(offering.bootstrap_tx_hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-primary hover:underline"
              >
                Opening transaction on Cardanoscan →
              </a>
            )}
          </div>
        </section>

        <aside className="space-y-6">
          {denom ? (
            <BuyFractionsCard
              assetId={offering.asset_id}
              depositAsset={denom}
              registryAddress={offering.script_address}
            />
          ) : (
            <div className="card-institutional p-6 text-sm text-muted-foreground">
              The denomination for this listing is not registered yet.
            </div>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 break-all text-foreground${mono ? " font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
