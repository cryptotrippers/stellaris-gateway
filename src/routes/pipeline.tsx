import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { listPipeline } from "@/lib/accelerator.functions";
import { PIPELINE_STAGES, type PipelineProject } from "@/lib/accelerator.shared";
import { ReadinessMeter } from "@/components/accelerator/ReadinessMeter";
import { VerificationBadge } from "@/components/accelerator/ProjectToolkit";
import { formatFeeBps } from "@/lib/vault-fees";

const TITLE = "Project Pipeline — real-world assets on Stellaris";
const DESCRIPTION =
  "Every real-world asset proposed on Stellaris, from first submission to a live on-chain vault: verified issuers, evidence checklists, impact attestations and where the money actually is.";

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

function PipelinePage() {
  const q = useQuery({ queryKey: ["pipeline"], queryFn: () => listPipeline() });
  const [stage, setStage] = useState<string>("all");
  const [category, setCategory] = useState<string>("all");

  const projects = q.data?.projects ?? [];
  const categories = useMemo(
    () => [...new Set(projects.map((p) => p.category))].sort(),
    [projects],
  );
  const filtered = projects.filter(
    (p) => (stage === "all" || p.stage === stage) && (category === "all" || p.category === category),
  );

  const s = q.data?.summary;

  return (
    <AppShell>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Project pipeline</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Everything proposed on Stellaris, in the open — including the projects that have verified
          nothing yet. A project only reaches a live vault after governance votes it through and an
          operator bootstraps it on chain.
        </p>
      </header>

      <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Counter label="Projects in pipeline" value={s ? String(s.projects) : "—"} />
        <Counter label="Verified issuers" value={s ? String(s.verifiedIssuers) : "—"} />
        <Counter label="Live vaults" value={s ? String(s.liveVaults) : "—"} />
        <Counter
          label="Accounted on chain"
          value={s ? `${ada(s.accountedLovelace)} ₳` : "—"}
          hint="Sum of the latest accounted assets recorded by on-chain accruals."
        />
      </dl>

      <div className="mt-8 flex flex-wrap gap-2">
        <Chip active={stage === "all"} onClick={() => setStage("all")}>
          All stages
        </Chip>
        {PIPELINE_STAGES.map((st) => (
          <Chip key={st.key} active={stage === st.key} onClick={() => setStage(st.key)}>
            {st.label}
          </Chip>
        ))}
      </div>

      {categories.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip active={category === "all"} onClick={() => setCategory("all")}>
            All categories
          </Chip>
          {categories.map((c) => (
            <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
      )}

      {q.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the pipeline…
        </p>
      ) : q.isError ? (
        <p className="mt-8 text-sm text-destructive">{(q.error as Error).message}</p>
      ) : filtered.length === 0 ? (
        <div className="mt-8 card-institutional p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Nothing in this view yet.{" "}
            <Link to="/funding/new" className="text-primary underline">
              Submit a project
            </Link>{" "}
            to be the first.
          </p>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => (
            <ProjectCard key={p.fundingRequestId} p={p} />
          ))}
        </div>
      )}

      <p className="mt-10 text-[11px] text-muted-foreground">
        Data source: the platform database for submissions and verification, and on-chain accrual
        records for vault state. Generated {s ? new Date(s.generatedAt).toLocaleString() : "—"}.
      </p>
    </AppShell>
  );
}

function ProjectCard({ p }: { p: PipelineProject }) {
  const stageLabel = PIPELINE_STAGES.find((s) => s.key === p.stage)?.label ?? p.stage;
  return (
    <article className="card-institutional flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-medium text-foreground">
            <Link to="/funding/$id" params={{ id: p.slug }} className="hover:text-primary">
              {p.name}
            </Link>
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {p.category} · {p.issuerName}
            {p.location ? ` · ${p.location}` : ""}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground">
          {stageLabel}
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

      <dl className="mt-4 grid grid-cols-3 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Target</dt>
          <dd className="mt-0.5 tabular-nums text-foreground">{ada(p.targetLovelace)} ₳</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Fee</dt>
          <dd className="mt-0.5 text-foreground">{formatFeeBps(p.proposedFeeBps)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Impact metrics</dt>
          <dd className="mt-0.5 tabular-nums text-foreground">{p.attestedMetrics}</dd>
        </div>
      </dl>

      <p className="mt-4 text-[11px] text-muted-foreground">
        {p.vaultAddress
          ? "Vault live on chain — deposits accepted."
          : p.assetId
            ? "Approved by governance; no vault derived yet."
            : "No vault, no capital: this is a claim under review."}
      </p>

      <div className="mt-auto pt-4">
        {p.assetId ? (
          <Link
            to="/marketplace/$id"
            params={{ id: p.assetId }}
            className="inline-flex items-center gap-1.5 text-xs text-primary"
          >
            Open project <ArrowRight className="h-3 w-3" />
          </Link>
        ) : (
          <Link
            to="/funding/$id"
            params={{ id: p.slug }}
            className="inline-flex items-center gap-1.5 text-xs text-primary"
          >
            Review evidence <ArrowRight className="h-3 w-3" />
          </Link>
        )}
      </div>
    </article>
  );
}

function Counter({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card-institutional p-4">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</dd>
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
