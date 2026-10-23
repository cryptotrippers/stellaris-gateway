import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getAssetVault } from "@/lib/asset-vaults.functions";
import { getVaultChainState, listVaultReturns } from "@/lib/yield-chain.functions";
import { listFundingRequests } from "@/lib/funding-requests.functions";
import { getProjectToolkit } from "@/lib/accelerator.functions";
import { useDerivedVaultAddress } from "@/hooks/useDerivedVaultAddress";
import { supabase } from "@/integrations/supabase/client";
import { RefreshVaultDataButton } from "@/components/vault/RefreshVaultDataButton";
import { LegacyVaultCard } from "@/components/vault/LegacyVaultCard";
import { VaultTxHistoryCard } from "@/components/vault/VaultTxHistoryCard";
import { AssetVaultPanel } from "@/components/vault/AssetVaultPanel";
import { YieldVaultActionsCard } from "@/components/vault/YieldVaultActionsCard";
import { AllocationFlow } from "@/components/vault/AllocationFlow";
import { MARKET_ASSET_COLUMNS } from "@/components/marketplace/marketplace-query";
import { PassportHeader } from "@/components/passport/PassportHeader";
import { ClarityChecklist } from "@/components/passport/ClarityStandard";
import { clarityItems } from "@/components/passport/clarity";
import { passportStage } from "@/components/passport/stage";
import {
  ContractsSection,
  DocumentsSection,
  FinancialSection,
  FundingSection,
  PassportSection,
  RisksSection,
  StructureSection,
  SupportSection,
  UpdatesSection,
} from "@/components/passport/PassportSections";
import type { PassportAsset, PassportRequest, PassportVault } from "@/components/passport/types";

const assetQuery = (id: string) =>
  queryOptions({
    queryKey: ["asset", id, "passport"],
    queryFn: async (): Promise<PassportAsset> => {
      const { data, error } = await supabase
        .from("assets")
        .select(MARKET_ASSET_COLUMNS)
        .eq("id", id)
        .maybeSingle<PassportAsset>();
      if (error) throw error;
      if (!data) throw notFound();
      return data;
    },
  });

export const Route = createFileRoute("/marketplace/$id")({
  loader: ({ params, context }) => context.queryClient.ensureQueryData(assetQuery(params.id)),
  head: ({ params, loaderData }) => {
    const a = loaderData as PassportAsset | undefined;
    if (!a) {
      // No loader data means the asset is missing or the load failed — never index it.
      return {
        meta: [
          { title: `Asset ${params.id} · Unavailable · Stellaris` },
          { name: "description", content: "This asset is not available in the registry." },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const title = `${a.name} · Asset Passport · Stellaris`;
    const description = `${a.name} by ${a.issuer}${a.location ? ` · ${a.location}` : ""}. Identity, structure, funding, disclosures, documents, risks and on-chain records.`;
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
      <h1 className="font-display text-2xl font-semibold text-foreground">Asset not listed</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No project is registered under this identifier. Listed projects each have a Stellaris
        Asset Passport.
      </p>
      <Link
        to="/marketplace"
        className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Back to assets
      </Link>
    </div>
  ),
  errorComponent: ({ error, reset }) => (
    <div role="alert" className="mx-auto max-w-md py-24 text-center">
      <h1 className="font-display text-xl font-semibold text-foreground">This passport didn&apos;t load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "A connection problem stopped the registry from loading."}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Try again
      </button>
    </div>
  ),
  pendingComponent: () => (
    <div className="space-y-4 py-6" aria-busy="true" aria-label="Loading passport">
      <div className="h-[420px] animate-pulse rounded-3xl bg-secondary" />
      <div className="h-48 animate-pulse rounded-2xl bg-secondary" />
    </div>
  ),
  component: AssetPassport,
});

const SECTIONS = [
  ["identity", "A · Asset identity"],
  ["structure", "B · Investment structure"],
  ["funding", "C · Funding overview"],
  ["clarity", "D · Clarity Standard"],
  ["financials", "E · Financial information"],
  ["documents", "F · Documents"],
  ["updates", "G · Project updates"],
  ["summary", "Underlying business"],
  ["risks", "Risk factors"],
  ["contracts", "Blockchain records"],
  ["participate", "Take part"],
  ["support", "Support"],
] as const;

function AssetPassport() {
  const { id } = Route.useParams();
  const { data: asset } = useSuspenseQuery(assetQuery(id));
  const isDemo = asset.funding_status === "demo";

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
  const returnsQ = useQuery({
    queryKey: ["vault-returns"],
    queryFn: () => listVaultReturns(),
    staleTime: 300_000,
    retry: 0,
  });
  const requestsQ = useQuery({
    queryKey: ["funding-requests"],
    queryFn: () => listFundingRequests(),
    staleTime: 300_000,
  });
  const fr = (requestsQ.data ?? []).find((r) => r.asset_id === id) ?? null;
  const toolkitQ = useQuery({
    queryKey: ["project-toolkit", fr?.asset_slug],
    queryFn: () => getProjectToolkit({ data: { slug: fr!.asset_slug } }),
    enabled: !!fr,
    staleTime: 300_000,
  });

  const v = vaultQ.data;
  const vault: PassportVault = v
    ? {
        script_address: v.script_address,
        script_hash: v.script_hash,
        bootstrap_tx_hash: v.bootstrap_tx_hash,
        bootstrapped_at: v.bootstrapped_at,
        signature_threshold: v.signature_threshold,
        operator_key_hashes: v.operator_key_hashes ?? [],
        reporting_cadence: v.reporting_cadence,
      }
    : null;
  const request: PassportRequest = fr
    ? {
        id: fr.id,
        category: fr.category,
        asset_slug: fr.asset_slug,
        created_at: fr.created_at,
        status: fr.status,
        evidence_urls: fr.evidence_urls ?? [],
        reporting_cadence: fr.reporting_cadence,
        proposed_fee_bps: fr.proposed_fee_bps,
        proposal_id: fr.proposal_id,
      }
    : null;
  const ret = returnsQ.data?.vaults.find((x) => x.assetId === id);
  const returns = ret ? { apyPct: ret.apyPct, accrualCount: ret.accrualCount } : null;
  const vaultLive = !!vault?.bootstrap_tx_hash;
  const heldOnChain = chainQ.data?.found ? Number(chainQ.data.lockedLovelace) : null;
  const clarity = clarityItems({ ...asset, vaultLive });
  const stage = passportStage({ funding_status: asset.funding_status, vaultLive, payouts: returns?.accrualCount ?? 0 });
  const scriptAddress = effectiveAddress ?? vault?.script_address ?? null;

  return (
    <div>
      <Link to="/marketplace" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All assets
      </Link>

      <div className="mt-4">
        <PassportHeader asset={asset} stage={stage} clarity={clarity} />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Passport contents" className="hidden h-fit lg:sticky lg:top-24 lg:block">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Passport contents</p>
          <ul className="mt-3 space-y-1.5 border-l border-border text-sm">
            {SECTIONS.filter(([k]) => !(isDemo && k === "participate")).map(([k, l]) => (
              <li key={k}>
                <a href={`#${k}`} className="-ml-px block border-l border-transparent pl-3 text-muted-foreground transition-colors hover:border-teal hover:text-foreground">
                  {l}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          <StructureSection asset={asset} vault={vault} />
          <FundingSection asset={asset} heldOnChain={heldOnChain} action={<RefreshVaultDataButton />} />
          <PassportSection id="clarity" letter="D" title="The Stellaris Clarity Standard">
            <ClarityChecklist items={clarity} />
          </PassportSection>
          <FinancialSection asset={asset} returns={returns} />
          <DocumentsSection asset={asset} request={request} />
          <UpdatesSection asset={asset} vault={vault} request={request} checklist={toolkitQ.data?.checklist ?? []} returns={returns}>
            <VaultTxHistoryCard assetId={asset.id} />
          </UpdatesSection>
          <PassportSection id="summary" title="Summary and underlying business">
            {asset.description ? (
              <p className="text-sm leading-relaxed text-foreground">{asset.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">The issuer has not published a description yet.</p>
            )}
          </PassportSection>
          <RisksSection isDemo={isDemo} />
          <ContractsSection address={scriptAddress} vault={vault} />
          {!isDemo && (
            <PassportSection id="participate" title="Take part (Cardano Preprod test ADA)">
              <p className="mb-4 text-sm text-muted-foreground">
                These panels sign real Preprod transactions with test ADA from your wallet. They do
                not move real money and give no legal claim on the asset.
              </p>
              <div className="space-y-4">
                <AllocationFlow assetId={asset.id} />
                <YieldVaultActionsCard assetId={asset.id} />
                <LegacyVaultCard assetId={asset.id} />
                <AssetVaultPanel assetId={asset.id} />
              </div>
            </PassportSection>
          )}
          <SupportSection />
        </div>
      </div>
    </div>
  );
}
