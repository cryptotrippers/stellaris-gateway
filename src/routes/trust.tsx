import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BadgeCheck,
  Building2,
  FileCheck2,
  FileText,
  Landmark,
  LifeBuoy,
  Scale,
  ScrollText,
  ShieldCheck,
  Vault,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { StatusPill, type DisclosureStatus } from "@/components/brand/StatusPill";

const TITLE = "Trust Centre · Stellaris Finance";
const DESCRIPTION =
  "Evidence behind Stellaris: company and regulatory status, how issuers and assets are reviewed, token holder rights, contract audit status, escrow, reporting, risks and complaints.";

export const Route = createFileRoute("/trust")({
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
  component: TrustCentre,
});

type Evidence = { label: string; to?: string; href?: string };
type Item = {
  id: string;
  icon: LucideIcon;
  title: string;
  status: DisclosureStatus;
  statusLabel?: string;
  body: string;
  evidence: Evidence[];
  asOf: string | null;
};

/** Reviewed as of this date; update together with any statement below. */
const REVIEWED = "23 Oct 2026";

const ITEMS: Item[] = [
  {
    id: "company",
    icon: Building2,
    title: "Company information",
    status: "pending",
    body: "The legal entity, registered address and leadership team have not yet been published. They will be listed here with registry links before any real-money feature launches.",
    evidence: [{ label: "About Stellaris", to: "/about" }],
    asOf: REVIEWED,
  },
  {
    id: "regulatory",
    icon: Landmark,
    title: "Regulatory status",
    status: "pending",
    statusLabel: "No licence held",
    body: "Stellaris does not hold a financial services licence in any jurisdiction. The platform runs on the Cardano Preprod testnet only, and no real-money investment is offered.",
    evidence: [{ label: "Testnet notice", to: "/testnet" }, { label: "Platform terms", to: "/terms" }],
    asOf: REVIEWED,
  },
  {
    id: "issuer-verification",
    icon: BadgeCheck,
    title: "Issuer verification",
    status: "published",
    statusLabel: "Process published",
    body: "Issuers create a profile with their legal name, jurisdiction and wrapper type. Only an administrator can mark an issuer verified or rejected, and every decision is written to an audit log on the server.",
    evidence: [{ label: "For issuers", to: "/for-issuers" }, { label: "Project pipeline", to: "/pipeline" }],
    asOf: REVIEWED,
  },
  {
    id: "approval",
    icon: FileCheck2,
    title: "Investment approval methodology",
    status: "published",
    statusLabel: "Process published",
    body: "A project passes a fixed evidence checklist, then a governance vote, before an asset is created. Listing approval for real money also needs legal sign-off, which has not happened for any project.",
    evidence: [{ label: "How it works", to: "/how-it-works" }, { label: "Governance", to: "/governance" }],
    asOf: REVIEWED,
  },
  {
    id: "asset-standards",
    icon: ScrollText,
    title: "Asset verification standards",
    status: "published",
    body: "Every project is measured against the seven-part Clarity Standard. A published document is never shown as verified without a recorded independent review.",
    evidence: [{ label: "Example Asset Passport", to: "/marketplace" }],
    asOf: REVIEWED,
  },
  {
    id: "rights",
    icon: Scale,
    title: "Token holder rights",
    status: "pending",
    body: "No legal document grants token or vault-share holders rights over any real asset. Until one is approved, holding a test share is not ownership of anything.",
    evidence: [{ label: "Platform terms", to: "/terms" }],
    asOf: REVIEWED,
  },
  {
    id: "audit",
    icon: ShieldCheck,
    title: "Smart contract audit status",
    status: "pending",
    statusLabel: "Internal review only",
    body: "The vault contracts had an internal security scan in August 2026, re-verified in October 2026 with mutation tests. No independent third-party audit has been completed.",
    evidence: [{ label: "Security overview", to: "/security" }, { label: "Security contact", href: "/.well-known/security.txt" }],
    asOf: "17 Oct 2026",
  },
  {
    id: "wallet",
    icon: Wallet,
    title: "Wallet security",
    status: "published",
    body: "Stellaris never asks for your recovery phrase. Every transaction is shown in your own wallet before you sign it. Only connect on Preprod, and check the network badge.",
    evidence: [{ label: "Learn: wallets", to: "/learn" }],
    asOf: REVIEWED,
  },
  {
    id: "escrow",
    icon: Vault,
    title: "Funding escrow",
    status: "pending",
    statusLabel: "Not operating",
    body: "Escrow, refunds and milestone releases are designed but not built. Capital will only count as released when a confirmed on-chain transaction shows it.",
    evidence: [{ label: "Escrow explained", to: "/asset-to-yield" }],
    asOf: REVIEWED,
  },
  {
    id: "reporting",
    icon: FileText,
    title: "Financial reporting standards",
    status: "pending",
    body: "Distributions will be labelled Forecast, Approved, Funded or Paid, and only Paid carries a transaction reference. No project has submitted an operating report yet.",
    evidence: [{ label: "Distribution labels", to: "/asset-to-yield" }, { label: "Reserve transparency", to: "/transparency" }],
    asOf: REVIEWED,
  },
  {
    id: "complaints",
    icon: LifeBuoy,
    title: "Risk and complaint information",
    status: "published",
    body: "Every passport lists testnet, contract, issuer, legal and liquidity risks. A formal complaints process and external dispute body will be named before launch; until then use the security contact.",
    evidence: [{ label: "Platform terms", to: "/terms" }, { label: "Security contact", href: "/.well-known/security.txt" }],
    asOf: REVIEWED,
  },
];

function TrustCentre() {
  const counts = ITEMS.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <MarketingLayout>
      <section className="protocol border-b border-border bg-background">
        <div className="home-container py-14 md:py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-aqua">Trust Centre</p>
          <h1 className="mt-3 max-w-3xl font-display text-4xl font-semibold leading-tight text-foreground md:text-5xl">
            What is in place, what is pending, and the evidence for each.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground">
            Stellaris is a testnet preview. This page states plainly what exists today and links to
            the evidence. Nothing here is a claim of a licence, an audit or a partnership that does
            not exist.
          </p>
          <dl className="mt-8 flex flex-wrap gap-3">
            <Count label="Published" n={counts.published ?? 0} />
            <Count label="Pending" n={counts.pending ?? 0} />
            <Count label="Verified by a third party" n={counts.verified ?? 0} />
          </dl>
        </div>
      </section>

      <section className="home-container py-14">
        <SectionHeader eyebrow="Evidence" title="Eleven areas, reviewed together." description={`Statements reviewed ${REVIEWED} unless another date is shown.`} />
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {ITEMS.map((i) => (
            <li key={i.id} id={i.id} className="card-institutional flex scroll-mt-28 flex-col p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal/10 text-teal">
                    <i.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h2 className="font-display text-lg font-semibold text-foreground">{i.title}</h2>
                </div>
                <StatusPill status={i.status} label={i.statusLabel} className="shrink-0" />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-foreground">{i.body}</p>
              <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-5 text-xs">
                {i.evidence.map((e) =>
                  e.to ? (
                    <Link key={e.label} to={e.to} className="font-medium text-teal hover:underline">
                      {e.label}
                    </Link>
                  ) : (
                    <a key={e.label} href={e.href} className="font-medium text-teal hover:underline">
                      {e.label}
                    </a>
                  ),
                )}
                <span className="ml-auto text-muted-foreground">As of {i.asOf ?? "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </MarketingLayout>
  );
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-2xl font-semibold text-foreground">{n}</dd>
    </div>
  );
}
