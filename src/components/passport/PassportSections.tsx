import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { formatAda, lovelaceToAda } from "@/lib/format";
import { cardanoscanAddress, cardanoscanTx, short } from "@/lib/chain-format";
import { MetricCard } from "@/components/brand/MetricCard";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { StatusPill } from "@/components/brand/StatusPill";
import { Timeline, type TimelineItem } from "@/components/brand/Timeline";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EscrowStatusPanel } from "@/components/finance/EscrowViews";
import { DocumentRoom } from "@/components/documents/DocumentRoom";
import type {
  PassportAsset,
  PassportChecklist,
  PassportRequest,
  PassportReturns,
  PassportVault,
} from "./types";

export function PassportSection({
  id,
  letter,
  title,
  action,
  children,
}: {
  id: string;
  letter?: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="card-institutional scroll-mt-28 p-5 md:p-7">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-h`} className="flex items-center gap-3 font-display text-lg font-semibold text-foreground">
          {letter && (
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground" aria-hidden="true">
              {letter}
            </span>
          )}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, muted }: { label: string; value: ReactNode; muted?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={`text-sm font-medium sm:max-w-[60%] sm:text-right ${muted ? "text-muted-foreground" : "text-foreground"}`}>{value}</dd>
    </div>
  );
}

const ada = (l: number) => formatAda(lovelaceToAda(Number(l)));

/** Section B — investment structure. */
export function StructureSection({ asset, vault }: { asset: PassportAsset; vault: PassportVault }) {
  const isDemo = asset.funding_status === "demo";
  const live = !!vault?.bootstrap_tx_hash;
  return (
    <PassportSection id="structure" letter="B" title="Investment structure">
      <dl>
        <Row label="Legal wrapper" value="Not documented" muted />
        <Row
          label="Unit type"
          value={isDemo ? "Not applicable — demo listing" : live ? "Vault shares recorded on Cardano Preprod (test only)" : "Not published"}
          muted={isDemo || !live}
        />
        <Row label="Total units" value="Not published" muted />
        <Row label="Unit price" value="Not published" muted />
        <Row
          label="Investor rights summary"
          value="No rights document is on file. Holding a test share gives no legal claim on the asset or its income."
        />
        <Row label="Transfer restrictions" value="Not published" muted />
        <Row
          label="Liquidity conditions"
          value={live ? "Withdrawals follow the public vault contract's rules (unaudited). No secondary market." : "No live vault — no liquidity terms apply."}
          muted={!live}
        />
        <Row label="Document links" value="None on file" muted />
      </dl>
      <p className="mt-4 rounded-xl bg-secondary/60 px-4 py-3 text-xs text-muted-foreground">
        A token or vault share is not described as direct ownership of the asset unless approved
        legal documents establish that right. None have been approved for this project.
      </p>
    </PassportSection>
  );
}

/** Section C — funding overview. Only stored or on-chain values are shown. */
export function FundingSection({
  asset,
  heldOnChain,
  action,
}: {
  asset: PassportAsset;
  heldOnChain: number | null;
  action?: ReactNode;
}) {
  const isDemo = asset.funding_status === "demo";
  const target = Number(asset.target_lovelace);
  const raised = heldOnChain ?? Number(asset.raised_lovelace);
  const pctFunded = target > 0 ? Math.min(100, (raised / target) * 100) : 0;
  const pending = <FeatureStatus stage="awaiting_backend" />;
  return (
    <PassportSection id="funding" letter="C" title="Funding overview" action={action}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label={isDemo ? "Target capital (illustrative)" : "Target capital"} value={target > 0 ? ada(target) : null} />
        <MetricCard
          label={heldOnChain != null ? "Held in vault (on chain)" : isDemo ? "Raised (illustrative)" : "Subscriptions (registry)"}
          value={ada(raised)}
          hint={heldOnChain != null ? "Read live from Cardano Preprod" : "From the project registry"}
        />
        <MetricCard label="Minimum participation" value={ada(asset.min_deposit_lovelace)} />
        <MetricCard label="Term" value={asset.maturity_months ? `${asset.maturity_months} months` : null} />
        <MetricCard label="Soft cap" value={null} />
        <MetricCard label="Hard cap" value={null} />
        <MetricCard label="Funding deadline" value={null} />
        <MetricCard label="Restricted reserves" value={null} badge={pending} />
        <MetricCard label="Unreleased escrow" value={null} badge={pending} />
        <MetricCard label="Approved released amounts" value={null} badge={pending} />
      </div>
      {!isDemo && target > 0 && (
        <div className="mt-5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Funding progress</span>
            <span className="number-display font-medium text-foreground">{pctFunded.toFixed(1)}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round(pctFunded)} aria-valuemin={0} aria-valuemax={100} aria-label="Funding progress">
            <div className="h-full rounded-full bg-teal" style={{ width: `${pctFunded}%` }} />
          </div>
        </div>
      )}
      <div className="mt-5">
        <EscrowStatusPanel current={null} />
      </div>
    </PassportSection>
  );
}

const TABS = [
  ["revenue", "Revenue Model"],
  ["opex", "Operating Expenses"],
  ["waterfall", "Cashflow Waterfall"],
  ["distributions", "Distributions"],
  ["scenarios", "Scenario Analysis"],
  ["history", "Historical Reporting"],
] as const;

/** Section E — financial information. */
export function FinancialSection({ asset, returns }: { asset: PassportAsset; returns: PassportReturns }) {
  const isDemo = asset.funding_status === "demo";
  const demoLink = (
    <Link to="/asset-to-yield" className="font-medium text-teal hover:underline">
      See how this will be presented (illustrative example)
    </Link>
  );
  const body: Record<(typeof TABS)[number][0], ReactNode> = {
    revenue: (
      <Empty>
        {asset.description ? (
          <>The issuer&apos;s description is in the summary above. No revenue model, offtake terms or pricing assumptions are published.</>
        ) : (
          <>No revenue model is published.</>
        )}
      </Empty>
    ),
    opex: <Empty>No operating expense budget or actuals are published.</Empty>,
    waterfall: (
      <Empty>
        No cashflow waterfall is published for this project. {demoLink}.
      </Empty>
    ),
    distributions: (
      <Empty>
        {returns && returns.accrualCount > 0 ? (
          <>
            {returns.accrualCount} yield payout{returns.accrualCount === 1 ? "" : "s"} recorded on
            Cardano Preprod (test ADA)
            {returns.apyPct != null ? `, equivalent to ${returns.apyPct.toFixed(1)}% a year on settled payouts` : ""}.
            These are testnet accruals, not distributions of real income.
          </>
        ) : (
          <>No distributions have been declared, funded or paid.</>
        )}
      </Empty>
    ),
    scenarios: <Empty>No scenario analysis is published. Scenarios will come from the approved calculation engine. {demoLink}.</Empty>,
    history: <Empty>No operating or financial reports have been submitted.</Empty>,
  };
  return (
    <PassportSection id="financials" letter="E" title="Financial information">
      {isDemo && (
        <p className="mb-4 text-xs text-muted-foreground">
          <StatusPill status="illustrative" /> Any figures on this demo listing are illustrative.
        </p>
      )}
      <Tabs defaultValue="revenue">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-secondary/70 p-1">
          {TABS.map(([k, l]) => (
            <TabsTrigger key={k} value={k} className="text-xs sm:text-sm">
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(([k]) => (
          <TabsContent key={k} value={k} className="mt-4">
            {body[k]}
          </TabsContent>
        ))}
      </Tabs>
    </PassportSection>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">{children}</p>;
}

/** Section F — documents approved for release to investors, plus links the issuer published. */
export function DocumentsSection({ asset, request }: { asset: PassportAsset; request: PassportRequest }) {
  const evidence = request?.evidence_urls ?? [];
  return (
    <PassportSection id="documents" letter="F" title="Documents">
      {request ? (
        <DocumentRoom fundingRequestId={request.id} category={request.category} audience="investor" />
      ) : (
        <Empty>
          This asset was listed without a funding request, so it has no document room. No documents have
          been released for it.
        </Empty>
      )}
      {(asset.audit_report_url || evidence.length > 0) && (
        <div className="mt-4 rounded-xl border border-border p-4">
          <p className="text-sm font-semibold text-foreground">Links published by the issuer</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These are public web links, not files reviewed in the document room.
          </p>
          <ul className="mt-2 space-y-1.5">
            {asset.audit_report_url && (
              <li className="flex flex-wrap items-center gap-2 text-xs">
                <a href={asset.audit_report_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-teal hover:underline">
                  Audit report <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
                <StatusPill status="published" label="Published · not verified" />
              </li>
            )}
            {evidence.map((u) => (
              <li key={u} className="flex flex-wrap items-center gap-2 text-xs">
                <a href={u} target="_blank" rel="noopener noreferrer" className="break-all text-teal hover:underline">{u}</a>
                <StatusPill status="published" label="Published · not verified" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </PassportSection>
  );
}

/** Section G — project updates timeline with source and timestamp per event. */
export function UpdatesSection({
  asset,
  vault,
  request,
  checklist,
  returns,
  children,
}: {
  asset: PassportAsset;
  vault: PassportVault;
  request: PassportRequest;
  checklist: PassportChecklist;
  returns: PassportReturns;
  children?: ReactNode;
}) {
  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : null;
  const reviewed = checklist.filter((c) => c.status === "verified" || c.status === "rejected");
  const submitted = checklist.filter((c) => c.status !== "missing");
  const lastReview = reviewed.map((c) => c.verified_at).filter(Boolean).sort().pop() ?? null;
  const src = (source: string, date: string | null) => (
    <p className="text-xs text-muted-foreground">
      Source: {source}
      {date ? ` · ${date}` : ""}
    </p>
  );
  const none = (label = "No event recorded") => <p className="text-xs text-muted-foreground">{label}</p>;

  const items: TimelineItem[] = [
    {
      title: "Submission",
      state: request ? "done" : "upcoming",
      description: request ? "Funding request submitted by the issuer." : asset.funding_status === "demo" ? "Demo listing — no funding request." : undefined,
      meta: request ? src("Funding request registry", fmt(request.created_at)) : none(),
    },
    {
      title: "Review",
      state: reviewed.length > 0 ? "done" : submitted.length > 0 ? "current" : "upcoming",
      description:
        reviewed.length > 0
          ? `${reviewed.length} checklist item${reviewed.length === 1 ? "" : "s"} reviewed by an administrator.`
          : submitted.length > 0
            ? `${submitted.length} evidence item${submitted.length === 1 ? "" : "s"} awaiting review.`
            : undefined,
      meta: reviewed.length > 0 ? src("Review checklist", fmt(lastReview)) : none(),
    },
    {
      title: "Approval",
      state: request?.status === "asset_created" || asset.funding_status !== "demo" ? "done" : "upcoming",
      description: asset.funding_status === "demo" ? "Added as a demo listing — not an approval." : "Listed in the asset registry.",
      meta: src("Asset registry", fmt(asset.created_at)),
    },
    {
      title: "Funding",
      state: vault?.bootstrap_tx_hash ? "done" : "upcoming",
      description: vault?.bootstrap_tx_hash ? "Vault set up on Cardano Preprod (test deposits only)." : undefined,
      meta: vault?.bootstrap_tx_hash ? (
        <div className="space-y-1">
          {src("Cardano Preprod", fmt(vault.bootstrapped_at))}
          <a href={cardanoscanTx(vault.bootstrap_tx_hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-teal">
            {short(vault.bootstrap_tx_hash)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </div>
      ) : (
        none()
      ),
    },
    { title: "Milestones", state: "upcoming", meta: none("No milestones published") },
    {
      title: "Operations",
      state: returns && returns.accrualCount > 0 ? "done" : "upcoming",
      description: returns && returns.accrualCount > 0 ? `${returns.accrualCount} on-chain yield accrual${returns.accrualCount === 1 ? "" : "s"} recorded (test ADA).` : undefined,
      meta: returns && returns.accrualCount > 0 ? src("Cardano Preprod accrual records", null) : none(),
    },
    { title: "Income reports", state: "upcoming", meta: none("No reports submitted") },
    { title: "Distributions", state: "upcoming", meta: none("No distributions declared") },
    { title: "Material events", state: "upcoming", meta: none() },
    { title: "Exit", state: "upcoming", meta: none() },
  ];

  return (
    <PassportSection id="updates" letter="G" title="Project updates">
      <Timeline items={items} />
      {children && <div className="mt-6">{children}</div>}
    </PassportSection>
  );
}

export function RisksSection({ isDemo }: { isDemo: boolean }) {
  const risks = [
    "Testnet only: runs on Cardano Preprod with test ADA. Nothing here has real-world value.",
    "Smart contracts have not been independently audited. An internal security review exists.",
    "Issuer risk: the project may not perform, and the issuer may fail to report.",
    "Legal risk: no legal wrapper links shares to the underlying asset.",
    "Liquidity risk: there may be no way to exit at the time or price you want.",
    "You could lose some or all of the amount you put in.",
  ];
  return (
    <PassportSection id="risks" title="Risk factors">
      <ul className="space-y-2.5 text-sm text-foreground">
        {isDemo && (
          <li className="flex gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            This is a demo listing. It is not a real offering and cannot be invested in.
          </li>
        )}
        {risks.map((r) => (
          <li key={r} className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            {r}
          </li>
        ))}
      </ul>
    </PassportSection>
  );
}

export function ContractsSection({ address, vault }: { address: string | null; vault: PassportVault }) {
  return (
    <PassportSection id="contracts" title="Contract and blockchain records">
      <dl>
        <Row label="Network" value="Cardano Preprod (testnet)" />
        <Row
          label="Vault address"
          value={
            address ? (
              <a href={cardanoscanAddress(address)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-teal">
                {short(address)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : (
              "Not set up"
            )
          }
          muted={!address}
        />
        <Row label="Script hash" value={vault?.script_hash ? <span className="font-mono text-xs">{short(vault.script_hash)}</span> : "Not set up"} muted={!vault?.script_hash} />
        <Row
          label="Operator signatures required"
          value={vault ? `${vault.signature_threshold} of ${vault.operator_key_hashes.length}` : "Not set up"}
          muted={!vault}
        />
        <Row label="Reporting cadence" value={vault?.reporting_cadence ?? "Not stated"} muted={!vault?.reporting_cadence} />
        <Row label="Independent contract audit" value="Not yet — internal review only" muted />
      </dl>
    </PassportSection>
  );
}

export function SupportSection() {
  return (
    <PassportSection id="support" title="Support and complaints">
      <p className="text-sm text-foreground">
        Questions or concerns about this listing? Read the{" "}
        <Link to="/trust" className="font-medium text-teal hover:underline">Trust Centre</Link>{" "}
        for how complaints are handled, or report a security issue through our{" "}
        <a href="/.well-known/security.txt" className="font-medium text-teal hover:underline">security contact</a>.
      </p>
    </PassportSection>
  );
}
