import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { listFundingRequests } from "@/lib/funding-requests.functions";
import { formatFeeBps } from "@/lib/vault-fees";

export const Route = createFileRoute("/funding/")({
  head: () => ({
    meta: [
      { title: "Funding Requests · Stellaris Asset Onboarding" },
      {
        name: "description",
        content:
          "Every real-world asset proposed for funding on Stellaris, with its issuer, target raise, evidence links and proposed management fee. Governance decides what gets a vault.",
      },
      { property: "og:title", content: "Funding Requests · Stellaris Asset Onboarding" },
      {
        property: "og:description",
        content:
          "Open pipeline of real-world assets proposed for on-chain funding. Governance decides what gets a vault.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FundingPage,
});

const ada = (lovelace: number) => (lovelace / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 });

function FundingPage() {
  const q = useQuery({ queryKey: ["funding-requests"], queryFn: () => listFundingRequests() });
  const rows = q.data ?? [];

  return (
    <AppShell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Funding requests</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Anyone can propose a real-world asset. A request is a claim, not an approval: no vault is
            derived and no capital moves until governance votes it through and operators bootstrap
            the vault on chain.
          </p>
        </div>
        <Link
          to="/funding/new"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          <FileText className="h-4 w-4" /> Submit a request
        </Link>
      </div>

      {q.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the pipeline…
        </p>
      ) : q.isError ? (
        <p className="mt-8 text-sm text-destructive">{(q.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="mt-8 card-institutional p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No funding requests have been submitted yet. Yours would be the first.
          </p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {rows.map((r) => (
            <article key={r.id} className="card-institutional p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-medium text-foreground">{r.name}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.category} · {r.issuer}
                    {r.location ? ` · ${r.location}` : ""}
                  </p>
                </div>
                <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px] capitalize text-muted-foreground">
                  {r.status}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Target</dt>
                  <dd className="mt-0.5 tabular-nums text-foreground">{ada(r.target_lovelace)} ₳</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Min deposit</dt>
                  <dd className="mt-0.5 tabular-nums text-foreground">
                    {ada(r.min_deposit_lovelace)} ₳
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Proposed fee</dt>
                  <dd className="mt-0.5 text-foreground">{formatFeeBps(r.proposed_fee_bps)}</dd>
                </div>
              </dl>

              {r.evidence_urls.length > 0 && (
                <p className="mt-4 text-xs text-muted-foreground">
                  {r.evidence_urls.length} evidence link{r.evidence_urls.length === 1 ? "" : "s"} —{" "}
                  <a
                    href={r.evidence_urls[0]}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-foreground"
                  >
                    open first
                  </a>
                </p>
              )}

              {r.proposal_id ? (
                <Link
                  to="/governance"
                  className="mt-4 inline-flex items-center gap-1.5 text-xs text-primary"
                >
                  Under governance review <ArrowRight className="h-3 w-3" />
                </Link>
              ) : (
                <p className="mt-4 text-[11px] text-muted-foreground">
                  Not yet linked to a governance proposal.
                </p>
              )}
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
