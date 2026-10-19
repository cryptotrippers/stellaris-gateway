import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Shield, ExternalLink, AlertTriangle } from "lucide-react";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getAssetVault } from "@/lib/asset-vaults.functions";
import { getVaultChainState } from "@/lib/yield-chain.functions";
import { useDerivedVaultAddress } from "@/hooks/useDerivedVaultAddress";
import { Badge } from "@/components/ui/StatusBadge";
import { FundingBar } from "@/components/ui/funding-bar";
import { ShareRow } from "@/components/landing/ShareRow";
import { RefreshVaultDataButton } from "@/components/vault/RefreshVaultDataButton";
import { LegacyVaultCard } from "@/components/vault/LegacyVaultCard";
import { VaultTxHistoryCard } from "@/components/vault/VaultTxHistoryCard";
import { AssetVaultPanel } from "@/components/vault/AssetVaultPanel";
import { YieldVaultActionsCard } from "@/components/vault/YieldVaultActionsCard";
import { AllocationFlow } from "@/components/vault/AllocationFlow";

import { supabase } from "@/integrations/supabase/client";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { cardanoscanAddress, short } from "@/lib/chain-format";
import { categoryImage, riskLabel, STATUS_TONE } from "@/components/marketplace/asset-meta";

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
  head: ({ params, loaderData }) => {
    const a = loaderData as AssetRow | undefined;
    if (!a) {
      // No loader data means the vault is missing or the load failed — never index it.
      return {
        meta: [
          { title: `Vault ${params.id} · Unavailable · Stellaris` },
          { name: "description", content: "This vault is not available in the registry." },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const title = `${a.name} · Real-world asset · Stellaris`;
    const description = `${a.name} by ${a.issuer}${a.location ? ` · ${a.location}` : ""}. Structure, risks, verification status and on-chain activity.`;
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
      Couldn't load this vault. {error instanceof Error ? error.message : String(error)}
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

  // "Raised" is what the shared vault actually holds on chain, not a stored
  // number, so the headline figure can never disagree with the ledger below.
  const vaultQ = useQuery({
    queryKey: ["asset-vault", id],
    queryFn: () => getAssetVault({ data: { assetId: id } }),
    staleTime: 60_000,
  });
  const { effectiveAddress } = useDerivedVaultAddress(id, vaultQ.data?.script_address ?? null);
  const chainQ = useQuery({
    queryKey: ["vault-chain-state", effectiveAddress],
    queryFn: () => getVaultChainState({ data: { address: effectiveAddress! } }),
    enabled: !!effectiveAddress,
    refetchInterval: 60_000,
    retry: 0,
  });

  const lockedLovelace = chainQ.data?.found ? Number(chainQ.data.lockedLovelace) : null;
  const raisedLovelace = lockedLovelace ?? asset.raised_lovelace;

  const isDemo = asset.funding_status === "demo";
  const targetAda = lovelaceToAda(asset.target_lovelace);
  const raisedAda = lovelaceToAda(raisedLovelace);
  const minAda = lovelaceToAda(asset.min_deposit_lovelace);
  const fundedPct =
    asset.target_lovelace > 0
      ? Math.min(100, Math.round((raisedLovelace / asset.target_lovelace) * 100))
      : 0;

  const SECTIONS = [
    ["summary", "Summary"],
    ["structure", "Ownership & structure"],
    ["financials", "Financial information"],
    ["fees", "Fees & costs"],
    ["risks", "Risk factors"],
    ["liquidity", "Liquidity & transfers"],
    ["contracts", "Contract references"],
    ["verification", "Documents & verification"],
    ["participate", "Take part"],
    ["updates", "Latest updates"],
    ["support", "Support"],
  ] as const;
  const scriptAddress = effectiveAddress ?? vaultQ.data?.script_address ?? null;

  return (
    <div>
      <Link to="/marketplace" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Marketplace
      </Link>

      <section className="relative mt-4 overflow-hidden rounded-2xl border border-border">
        <img src={categoryImage(asset.category)} alt="" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/50" />
        <div className="relative p-6 md:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{asset.category}</Badge>
            <Badge tone={STATUS_TONE[asset.funding_status] ?? "primary"}>{asset.funding_status}</Badge>
            <Badge>Source: {asset.data_source}</Badge>
          </div>
          <h1 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">{asset.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">Issued by <span className="text-foreground">{asset.issuer}</span>{asset.location ? ` · ${asset.location}` : ""}</p>
          <div className={`mt-4 inline-flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${isDemo ? "border-warning/40 bg-warning/10 text-warning" : "border-border bg-background/70 text-muted-foreground"}`} role={isDemo ? "alert" : undefined}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {isDemo ? <span><strong>Demo project</strong> — illustrative only. Nothing can be invested.</span> : <span>{riskLabel(asset.funding_status)}. Cardano Preprod — no real money.</span>}
          </div>
          <div className="mt-5">
            <ShareRow url={`/marketplace/${asset.id}`} text={`${asset.name} by ${asset.issuer} on Stellaris.`} eventName="asset_share_click" label="Share this project" />
          </div>
          <span className="absolute bottom-2 right-3 rounded bg-background/80 px-1.5 py-0.5 text-[9px] text-muted-foreground">Illustrative category image — not a photo of this asset</span>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav aria-label="On this page" className="hidden h-fit lg:sticky lg:top-24 lg:block">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">On this page</div>
          <ul className="mt-2 space-y-1 text-sm">
            {SECTIONS.filter(([k]) => !(isDemo && k === "participate")).map(([k, l]) => (
              <li key={k}><a href={`#${k}`} className="text-muted-foreground hover:text-foreground">{l}</a></li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          <Section id="summary" title="Summary & underlying business">
            {asset.description ? <p className="text-sm leading-relaxed text-foreground/85">{asset.description}</p> : <Missing>The issuer has not published a description yet.</Missing>}
          </Section>

          <Section id="structure" title="Ownership & legal structure">
            <div className="grid gap-2 md:grid-cols-2">
              <DetailRow label="Issuer" value={asset.issuer} />
              <DetailRow label="Jurisdiction" value={asset.location ?? "Not stated"} />
              <DetailRow label="Legal wrapper" value="Not yet documented" muted />
              <DetailRow label="Management" value="Not yet documented" muted />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Holding a share on this testnet does not give you any legal ownership of the underlying asset. A legal structure (for example a trust or SPV) must be published before that can change.</p>
          </Section>

          <Section id="financials" title="Financial information" action={<RefreshVaultDataButton />}>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <BigStat label="Target" value={formatAda(targetAda)} accent />
              <BigStat label={lockedLovelace != null ? "Held on chain" : "Raised"} value={formatAda(raisedAda)} />
              <BigStat label="Min. entry" value={formatAda(minAda)} />
              <BigStat label="Term" value={asset.maturity_months ? `${asset.maturity_months} mo` : "—"} />
            </div>
            {!isDemo && (
              <div className="mt-6">
                <FundingBar pct={fundedPct} />
                <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                  <span>{fundedPct}% funded</span>
                  <span>{formatAda(raisedAda)} / {formatAda(targetAda)}</span>
                </div>
              </div>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{lockedLovelace != null ? "Raised figure read live from the project's vault on Cardano Preprod." : "Raised figure from the project registry; no on-chain vault reading is available."} No audited financial statements are on file.</p>
          </Section>

          <Section id="fees" title="Fees & costs">
            <Missing>Fees for this project are not published yet. Any on-chain fee is shown in your wallet before you sign.</Missing>
          </Section>

          <Section id="risks" title="Risk factors">
            <ul className="space-y-2 text-sm text-foreground/85">
              {isDemo && <Risk strong>This is a demo listing. It is not a real offering and cannot be invested in.</Risk>}
              <Risk>Testnet only: runs on Cardano Preprod with test ADA. Nothing here has real-world value.</Risk>
              <Risk>Smart contracts have not been independently audited.</Risk>
              <Risk>Issuer risk: the project may not perform, and the issuer may fail to report.</Risk>
              <Risk>Legal risk: no legal wrapper links shares to the underlying asset yet.</Risk>
              <Risk>Liquidity risk: there may be no buyer when you want to exit.</Risk>
              <Risk>You can lose some or all of the amount you put in.</Risk>
            </ul>
          </Section>

          <Section id="liquidity" title="Liquidity & transfer rules">
            <p className="text-sm text-foreground/85">Withdrawals follow the vault's on-chain rules shown in the "Take part" panels. There is no secondary market run by Stellaris, and no guarantee you can sell or exit at a given time or price.</p>
          </Section>

          <Section id="contracts" title="Contract & blockchain references">
            <div className="space-y-2">
              <DetailRow label="Network" value="Cardano Preprod" />
              {scriptAddress ? (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">Vault address</span>
                  <a href={cardanoscanAddress(scriptAddress)} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 font-mono text-xs text-primary">
                    <span className="truncate">{short(scriptAddress)}</span> <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              ) : (
                <DetailRow label="Vault address" value="Not bootstrapped" muted />
              )}
            </div>
          </Section>

          <Section id="verification" title="Documents & verification">
            {asset.audit_report_url ? (
              <a href={asset.audit_report_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary">
                <Shield className="h-4 w-4" /> View audit report <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <Missing>No independent audit and no supporting documents are on file for this project yet.</Missing>
            )}
          </Section>

          {!isDemo && (
            <Section id="participate" title="Take part">
              <div className="space-y-4">
                <AllocationFlow assetId={asset.id} />
                <YieldVaultActionsCard assetId={asset.id} />
                <LegacyVaultCard assetId={asset.id} />
                <AssetVaultPanel assetId={asset.id} />
              </div>
            </Section>
          )}

          <Section id="updates" title="Latest updates">
            <VaultTxHistoryCard assetId={asset.id} />
          </Section>

          <Section id="support" title="Support & complaints">
            <p className="text-sm text-foreground/85">Questions or concerns about this listing? See our <Link to="/security" className="text-primary">security & disclosure page</Link> for how to reach the team.</p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ id, title, action, children }: { id: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="card-institutional scroll-mt-24 p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Risk({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <li className={`flex gap-2 ${strong ? "font-medium text-warning" : ""}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> <span>{children}</span>
    </li>
  );
}

function BigStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display mt-1 text-2xl font-semibold ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function DetailRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-secondary/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right font-medium ${muted ? "text-muted-foreground" : "text-foreground"}`}>{value}</span>
    </div>
  );
}
