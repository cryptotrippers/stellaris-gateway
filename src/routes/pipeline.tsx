import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, RefreshCw } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { Button } from "@/components/ui/button";
import { listPipeline } from "@/lib/accelerator.functions";
import type { PipelineProject } from "@/lib/accelerator.shared";
import { ReadinessMeter } from "@/components/accelerator/ReadinessMeter";
import { VerificationBadge } from "@/components/accelerator/ProjectToolkit";
import {
  PUBLIC_STAGES,
  publicStage,
  type PublicStageKey,
} from "@/components/marketplace/public-stage";

const TITLE = "Project Pipeline — real-world assets on Stellaris";
const DESCRIPTION =
  "How proposed real-world asset projects move through review, decision and funding on Stellaris — shown in the open, with confidential details kept private.";

export const Route = createFileRoute("/pipeline")({
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
  component: PipelinePage,
});

const ada = (lovelace: number) =>
  (lovelace / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 });

type Row = PipelineProject & { publicKey: PublicStageKey };

function PipelinePage() {
  const q = useQuery({ queryKey: ["pipeline"], queryFn: () => listPipeline() });
  const [stage, setStage] = useState<PublicStageKey | "all">("all");

  const rows: Row[] = useMemo(
    () =>
      (q.data?.projects ?? []).flatMap((p) => {
        const k = publicStage(p.stage);
        return k ? [{ ...p, publicKey: k }] : [];
      }),
    [q.data],
  );
  const counts = useMemo(() => {
    const c = new Map<PublicStageKey, number>();
    for (const r of rows) c.set(r.publicKey, (c.get(r.publicKey) ?? 0) + 1);
    return c;
  }, [rows]);
  const visible = rows.filter((r) => stage === "all" || r.publicKey === stage);

  return (
    <MarketingLayout>
      <div className="home-container py-12 md:py-16">
        <SectionHeader
          eyebrow="Project pipeline"
          title="How projects move from proposal to funding."
          description="Every stage a project passes through, in the open. Confidential issuer information, withdrawn and rejected applications are never shown here."
        />

        <ol
          className="mt-10 grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7"
          aria-label="Pipeline stages"
        >
          {PUBLIC_STAGES.map((s, i) => {
            const n = counts.get(s.key) ?? 0;
            const active = stage === s.key;
            return (
              <li key={s.key} className="min-w-0">
                <button
                  type="button"
                  onClick={() => setStage(active ? "all" : s.key)}
                  aria-pressed={active}
                  className={`flex h-full w-full flex-col rounded-xl border p-4 text-left transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:border-teal/50"}`}
                >
                  <span
                    className={`text-[11px] font-semibold ${active ? "text-primary-foreground/80" : "text-teal"}`}
                  >
                    Stage {i + 1}
                  </span>
                  <span className="mt-1 text-sm font-semibold">{s.label}</span>
                  <span
                    className={`mt-1 text-xs ${active ? "text-primary-foreground/80" : "text-muted-foreground"}`}
                  >
                    {s.blurb}
                  </span>
                  <span className="number-display mt-3 font-display text-2xl font-semibold">
                    {q.isLoading ? "…" : n}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="mt-10">
          {q.isLoading ? (
            <div
              className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
              aria-busy="true"
              aria-label="Loading pipeline"
            >
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-56 animate-pulse rounded-2xl bg-secondary" />
              ))}
            </div>
          ) : q.isError ? (
            <div role="alert" className="card-institutional p-8 text-center">
              <p className="font-medium text-foreground">The pipeline didn&apos;t load.</p>
              <Button variant="outline" className="mt-4" onClick={() => q.refetch()}>
                <RefreshCw /> Try again
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <div className="card-institutional p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {stage === "all"
                  ? "No projects are in the pipeline yet."
                  : "No projects are at this stage right now."}{" "}
                <Link to="/for-issuers" className="font-medium text-teal hover:underline">
                  Propose a project
                </Link>
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((p) => (
                <ProjectCard key={p.fundingRequestId} p={p} />
              ))}
            </div>
          )}
        </div>

        <p className="mt-10 text-xs text-muted-foreground">
          Source: the public project registry and on-chain vault records. Generated{" "}
          {q.data ? new Date(q.data.summary.generatedAt).toLocaleString() : "—"}.
        </p>
      </div>
    </MarketingLayout>
  );
}

function ProjectCard({ p }: { p: Row }) {
  const label = PUBLIC_STAGES.find((s) => s.key === p.publicKey)?.label ?? "";
  return (
    <article className="card-institutional flex min-w-0 flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-display text-base font-semibold text-foreground">
            {p.name}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {p.category}
            {p.location ? ` · ${p.location}` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-teal/30 bg-teal/10 px-2.5 py-0.5 text-[11px] font-medium text-teal">
          {label}
        </span>
      </div>
      {p.issuer && (
        <div className="mt-3">
          <Link to="/issuers/$id" params={{ id: p.issuer.id }} className="inline-flex">
            <VerificationBadge status={p.issuer.verification_status} />
          </Link>
        </div>
      )}
      <div className="mt-4">
        <ReadinessMeter score={p.readiness} compact />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Requested target</dt>
          <dd className="mt-0.5 tabular-nums text-foreground">{ada(p.targetLovelace)} ₳ (test)</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evidence reviewed</dt>
          <dd className="mt-0.5 tabular-nums text-foreground">{p.readiness}% of required</dd>
        </div>
      </dl>
      <div className="mt-auto pt-4">
        {p.assetId ? (
          <Link
            to="/marketplace/$id"
            params={{ id: p.assetId }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-teal"
          >
            Open Asset Passport <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : (
          <Link
            to="/funding/$id"
            params={{ id: p.slug }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-teal"
          >
            Review evidence <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}
