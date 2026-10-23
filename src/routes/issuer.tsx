import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  Building2,
  CalendarClock,
  FileCheck2,
  FilePlus2,
  FileWarning,
  Loader2,
  LogIn,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { Button } from "@/components/ui/button";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { listPipeline } from "@/lib/accelerator.functions";
import { CHECKLIST_ITEMS, PIPELINE_STAGES } from "@/lib/accelerator.shared";
import { issuerWorkspaceQuery, type WorkspaceIssuer } from "@/components/issuers/issuer-workspace.query";
import { buildJourney, nextStep } from "@/components/issuers/journey/journey";
import { IssuerJourney } from "@/components/issuers/journey/IssuerJourney";
import { DataRoomPreview } from "@/components/issuers/journey/DataRoomPreview";

export const Route = createFileRoute("/issuer")({
  head: () => ({
    meta: [
      { title: "Issuer workspace · Stellaris" },
      {
        name: "description",
        content: "Track your organisation's verification, funding requests, evidence review and reporting on Stellaris.",
      },
      { property: "og:title", content: "Issuer workspace · Stellaris" },
      { property: "og:description", content: "Verification, review progress and evidence for project issuers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: IssuerWorkspace,
});

const REQUIRED = CHECKLIST_ITEMS.filter((c) => c.required).map((c) => ({ key: c.key, label: c.label }));

const VERIFY_LABEL: Record<WorkspaceIssuer["verification_status"], string> = {
  unverified: "Not yet submitted for review",
  pending: "Under review",
  verified: "Verified by administrator",
  rejected: "Rejected",
};

function IssuerWorkspace() {
  const { user, loading } = useSupabaseUser();
  return (
    <MarketingLayout>
      <div className="home-container py-10 md:py-14">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking your session…
          </p>
        ) : !user ? (
          <SignedOut />
        ) : (
          <Workspace userId={user.id} email={user.email ?? ""} />
        )}
      </div>
    </MarketingLayout>
  );
}

function SignedOut() {
  return (
    <div className="mx-auto max-w-xl card-institutional p-8 text-center">
      <Building2 className="mx-auto h-8 w-8 text-teal" aria-hidden="true" />
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground">Issuer workspace</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in to see your organisation&apos;s verification, funding requests and review progress.
        New to Stellaris? Start with an enquiry.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link to="/auth">
            <LogIn /> Sign in
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/for-issuers">For issuers</Link>
        </Button>
      </div>
    </div>
  );
}

function Workspace({ userId, email }: { userId: string; email: string }) {
  const ws = useQuery(issuerWorkspaceQuery(userId));
  const pipeline = useQuery({ queryKey: ["pipeline"], queryFn: () => listPipeline(), staleTime: 60_000 });
  const requests = ws.data?.requests ?? [];
  const issuers = ws.data?.issuers ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = requests.find((r) => r.id === selectedId) ?? requests[0] ?? null;
  const project = pipeline.data?.projects.find((p) => p.fundingRequestId === selected?.id) ?? null;
  const issuer = issuers.find((i) => i.id === selected?.issuer_id) ?? issuers[0] ?? null;

  const stages = useMemo(
    () =>
      selected
        ? buildJourney({
            requestCreatedAt: selected.created_at,
            requestStatus: selected.status,
            issuer,
            checklist: project?.checklist ?? [],
            required: REQUIRED,
            proposalId: selected.proposal_id,
            assetId: selected.asset_id,
            vaultLive: !!project?.vaultAddress,
            vaultBootstrappedAt: project?.vaultBootstrappedAt ?? null,
            hasAccruals: project?.stage === "reporting",
          })
        : [],
    [selected, issuer, project],
  );

  const outstanding = (pipeline.data?.projects ?? [])
    .filter((p) => requests.some((r) => r.id === p.fundingRequestId))
    .reduce((n, p) => n + REQUIRED.filter((req) => !p.checklist.some((c) => c.item_key === req.key && c.status === "verified")).length, 0);
  const listed = requests.filter((r) => r.asset_id).length;

  if (ws.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading workspace">
        <div className="h-24 animate-pulse rounded-2xl bg-secondary" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-secondary" />
          ))}
        </div>
      </div>
    );
  }
  if (ws.isError) {
    return (
      <div role="alert" className="card-institutional p-8 text-center">
        <p className="font-medium text-foreground">Your workspace didn&apos;t load.</p>
        <p className="mt-1 text-sm text-muted-foreground">{(ws.error as Error).message}</p>
        <Button className="mt-4" variant="outline" onClick={() => ws.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  }

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="home-eyebrow">Issuer workspace</p>
          <h1 className="mt-2 font-display text-3xl font-semibold text-foreground md:text-4xl">
            {issuer?.legal_name ?? "Your organisation"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {issuer ? `${issuer.jurisdiction} · ${issuer.wrapper_type.toUpperCase()}` : "No issuer profile yet"} · Signed in as {email}
          </p>
        </div>
        <Button asChild>
          <Link to="/funding/new">
            <FilePlus2 /> New funding request
          </Link>
        </Button>
      </header>

      <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile icon={Building2} label="Verification status" value={issuer ? VERIFY_LABEL[issuer.verification_status] : "No issuer profile"} />
        <Tile icon={FileCheck2} label="Active funding requests" value={String(requests.filter((r) => r.status !== "rejected").length)} />
        <Tile icon={FileWarning} label="Outstanding required evidence" value={pipeline.isLoading ? "…" : String(outstanding)} />
        <Tile icon={ArrowRight} label="Approved listings (testnet)" value={String(listed)} />
        <Tile icon={CalendarClock} label="Upcoming milestones" value="None published" badge={<FeatureStatus stage="awaiting_backend" />} />
        <Tile icon={Bell} label="Notifications" value="None" badge={<FeatureStatus stage="awaiting_backend" />} />
      </dl>

      {requests.length === 0 ? (
        <div className="mt-10 card-institutional p-8 text-center">
          <p className="font-display text-lg font-semibold text-foreground">No funding requests yet</p>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
            Submit your first project to start the review journey. Everything you enter in a request is
            public; confidential files go in the project&apos;s private document room once it exists.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link to="/funding/new">Start a funding request</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/how-it-works">See the nine stages</Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          {requests.length > 1 && (
            <div className="mt-10 flex flex-wrap gap-2" role="tablist" aria-label="Your funding requests">
              {requests.map((r) => (
                <button
                  key={r.id}
                  role="tab"
                  aria-selected={r.id === selected?.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`rounded-full border px-3 py-1.5 text-sm ${r.id === selected?.id ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <div className="mt-8 grid gap-8 lg:grid-cols-[1.25fr_1fr]">
              <section id="journey" aria-labelledby="journey-h" className="scroll-mt-28">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="journey-h" className="font-display text-xl font-semibold text-foreground">
                    Review progress · {selected.name}
                  </h2>
                  <Link to="/funding/$id" params={{ id: selected.asset_slug }} className="text-sm font-medium text-teal hover:underline">
                    Open request
                  </Link>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Stage: {PIPELINE_STAGES.find((s) => s.key === project?.stage)?.label ?? selected.status} · submitted{" "}
                  {new Date(selected.created_at).toLocaleDateString("en-AU")}
                </p>
                <div className="mt-4 rounded-xl border border-teal/30 bg-teal/5 p-4 text-sm">
                  <p className="font-medium text-foreground">Next permitted step</p>
                  <p className="mt-1 text-muted-foreground">{nextStep(stages)}</p>
                </div>
                <div className="mt-6">
                  {pipeline.isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading review records…</p>
                  ) : (
                    <IssuerJourney stages={stages} />
                  )}
                </div>
              </section>

              <div className="space-y-8">
                <section id="data-room" aria-labelledby="dr-h" className="scroll-mt-28 card-institutional p-5">
                  <h2 id="dr-h" className="font-display text-lg font-semibold text-foreground">Data room</h2>
                  <div className="mt-4">
                    <DataRoomPreview checklist={project?.checklist ?? []} slug={selected.asset_slug} fundingRequestId={selected.id} category={selected.category} />
                  </div>
                </section>
                <section id="reports" aria-labelledby="rp-h" className="scroll-mt-28 card-institutional p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="rp-h" className="font-display text-lg font-semibold text-foreground">Reports</h2>
                    <FeatureStatus stage="awaiting_backend" />
                  </div>
                  <dl className="mt-4 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Committed reporting cadence</dt>
                      <dd className="font-medium text-foreground">{selected.reporting_cadence ?? "Not stated"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Reports submitted</dt>
                      <dd className="font-medium text-foreground">None</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Operating and income report submission opens with the reporting service. Nothing
                    is due while the project is not operating with real capital.
                  </p>
                </section>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Tile({ icon: Icon, label, value, badge }: { icon: LucideIcon; label: string; value: string; badge?: React.ReactNode }) {
  return (
    <div className="card-institutional p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-teal/10 text-teal">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        {badge}
      </div>
      <dt className="mt-3 text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-display text-lg font-semibold text-foreground">{value}</dd>
    </div>
  );
}
