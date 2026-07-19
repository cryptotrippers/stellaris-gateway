import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Shield, ExternalLink } from "lucide-react";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { ShareRow } from "@/components/landing/ShareRow";
import { DepositVaultCard } from "@/components/vault/DepositVaultCard";
import { WithdrawVaultCard } from "@/components/vault/WithdrawVaultCard";
import { MyVaultHoldingsCard } from "@/components/vault/MyVaultHoldingsCard";
import { supabase } from "@/integrations/supabase/client";
import { formatAda, lovelaceToAda } from "@/lib/format";

interface AssetRow {
  id: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  description: string | null;
  target_lovelace: number;
  raised_lovelace: number;
  min_deposit_lovelace: number;
  maturity_months: number | null;
  funding_status: string;
  audit_report_url: string | null;
  data_source: string;
}

const assetQuery = (id: string) =>
  queryOptions({
    queryKey: ["asset", id],
    queryFn: async (): Promise<AssetRow> => {
      const { data, error } = await supabase
        .from("assets")
        .select(
          "id,name,category,issuer,location,description,target_lovelace,raised_lovelace,min_deposit_lovelace,maturity_months,funding_status,audit_report_url,data_source",
        )
        .eq("id", id)
        .maybeSingle<AssetRow>();
      if (error) throw error;
      if (!data) throw notFound();
      return data;
    },
  });

export const Route = createFileRoute("/marketplace/$id")({
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(assetQuery(params.id)),
  head: ({ params }) => ({
    meta: [
      { title: `Vault ${params.id} · Stellaris Finance` },
      {
        name: "description",
        content:
          "On-chain vault detail. Live issuer, funding, and audit data pulled from the registry.",
      },
    ],
  }),
  notFoundComponent: () => (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Vault not registered</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No issuer has registered a vault under this identifier yet. Once the
        registry is populated, its full disclosure will appear here.
      </p>
      <Link
        to="/marketplace"
        className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Back to marketplace
      </Link>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="py-24 text-center text-sm text-muted-foreground">
      Couldn't load this vault. {error.message}
    </div>
  ),
  pendingComponent: () => (
    <div className="py-24 text-center text-sm text-muted-foreground">Loading vault…</div>
  ),
  component: AssetDetail,
});

function AssetDetail() {
  const { id } = Route.useParams();
  const { data: asset } = useSuspenseQuery(assetQuery(id));

  const targetAda = lovelaceToAda(asset.target_lovelace);
  const raisedAda = lovelaceToAda(asset.raised_lovelace);
  const minAda = lovelaceToAda(asset.min_deposit_lovelace);
  const fundedPct =
    asset.target_lovelace > 0
      ? Math.min(100, Math.round((asset.raised_lovelace / asset.target_lovelace) * 100))
      : 0;

  return (
    <div>
      <Link
        to="/marketplace"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Marketplace
      </Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{asset.category}</Badge>
            <Badge tone="accent">{asset.funding_status}</Badge>
            <Badge tone="default">Source: {asset.data_source}</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
            {asset.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {asset.issuer}
            {asset.location ? ` · ${asset.location}` : ""}
          </p>

          <div className="mt-5">
            <ShareRow
              url={`/marketplace/${asset.id}`}
              text={`On-chain vault: ${asset.name} by ${asset.issuer}.`}
              eventName="asset_share_click"
              label="Share this vault"
            />
          </div>

          <div className="mt-6 card-institutional p-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <BigStat
                label="Target"
                value={formatAda(targetAda)}
                accent
              />
              <BigStat label="Raised" value={formatAda(raisedAda)} />
              <BigStat label="Min. Deposit" value={formatAda(minAda)} />
              <BigStat
                label="Maturity"
                value={asset.maturity_months ? `${asset.maturity_months}mo` : "—"}
              />
            </div>
            <div className="mt-6">
              <FundingBar pct={fundedPct} />
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>{fundedPct}% funded</span>
                <span>
                  {formatAda(raisedAda)} / {formatAda(targetAda)}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-6 card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground">About this vault</h2>
            {asset.description ? (
              <p className="mt-3 text-sm leading-relaxed text-foreground/85">
                {asset.description}
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                The issuer has not published a description for this vault yet.
              </p>
            )}
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <DetailRow label="Issuer" value={asset.issuer} />
              <DetailRow label="Jurisdiction" value={asset.location ?? "—"} />
              <DetailRow label="Data source" value={asset.data_source} />
              <DetailRow label="Funding status" value={asset.funding_status} />
            </div>
          </div>

          <div className="mt-6 card-institutional p-6">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Shield className="h-4 w-4 text-accent" /> Audit &amp; disclosures
            </h2>
            {asset.audit_report_url ? (
              <a
                href={asset.audit_report_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary"
              >
                View audit report <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                No audit report is on file for this vault yet. APY, risk band, and
                ESG rating will appear here once the issuer publishes verified
                attestations.
              </p>
            )}
          </div>
        </div>

        {/* Right rail — real vault cards only when a compiled validator is wired */}
        <aside className="h-fit space-y-4 lg:sticky lg:top-24">
          {asset.id === "sfm-01" ? (
            <>
              <MyVaultHoldingsCard />
              <DepositVaultCard />
              <WithdrawVaultCard />
            </>
          ) : (
            <div className="card-institutional p-6">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Investment
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Deposits open once the issuer wires a compiled validator to this
                vault. No transactions can be signed against a placeholder
                address.
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={`number-display mt-1 text-2xl font-semibold ${
          accent ? "text-primary" : "text-foreground"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
