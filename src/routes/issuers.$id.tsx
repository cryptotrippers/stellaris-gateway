import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, Loader2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { getIssuer } from "@/lib/accelerator.functions";
import { VerificationBadge } from "@/components/accelerator/ProjectToolkit";

export const Route = createFileRoute("/issuers/$id")({
  head: () => {
    const title = "Issuer profile | Stellaris Accelerator";
    const description =
      "Legal entity, jurisdiction, wrapper type and verification history for an issuer bringing real-world assets onto Stellaris.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "profile" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: IssuerPage,
});

function IssuerPage() {
  const { id } = Route.useParams();
  const q = useQuery({ queryKey: ["issuer", id], queryFn: () => getIssuer({ data: { id } }) });

  return (
    <AppShell>
      <Link to="/pipeline" className="text-xs text-muted-foreground hover:text-foreground">
        ← Back to the pipeline
      </Link>

      {q.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading issuer…
        </p>
      ) : q.isError ? (
        <p className="mt-8 text-sm text-destructive">{(q.error as Error).message}</p>
      ) : !q.data?.issuer ? (
        <p className="mt-8 text-sm text-muted-foreground">No such issuer.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight text-foreground">
              <Building2 className="h-6 w-6 text-muted-foreground" />
              {q.data.issuer.legal_name}
            </h1>
            <VerificationBadge status={q.data.issuer.verification_status} />
          </div>

          <dl className="mt-6 grid gap-4 sm:grid-cols-4">
            <Stat label="Jurisdiction" value={q.data.issuer.jurisdiction} />
            <Stat label="Legal wrapper" value={q.data.issuer.wrapper_type} />
            <Stat label="Registration" value={q.data.issuer.registration_number ?? "—"} />
            <Stat
              label="Verified"
              value={
                q.data.issuer.verified_at
                  ? new Date(q.data.issuer.verified_at).toLocaleDateString()
                  : "Not yet"
              }
            />
          </dl>

          {q.data.issuer.website && (
            <a
              href={q.data.issuer.website}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block break-all text-xs text-primary underline"
            >
              {q.data.issuer.website}
            </a>
          )}

          <section className="card-institutional mt-8 p-5">
            <h2 className="text-sm font-medium text-foreground">Projects</h2>
            {q.data.projects.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                This issuer has not filed a funding request yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {q.data.projects.map((p) => (
                  <li key={p.slug}>
                    <Link
                      to="/funding/$id"
                      params={{ id: p.slug }}
                      className="inline-flex items-center gap-1.5 text-sm text-primary"
                    >
                      {p.name} <span className="text-muted-foreground">({p.status})</span>
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card-institutional mt-6 p-5">
            <h2 className="text-sm font-medium text-foreground">Verification history</h2>
            {q.data.history.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No verification decision has been recorded.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-xs">
                {q.data.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2">
                    <span className="capitalize text-foreground">{h.status}</span>
                    <span className="text-muted-foreground">
                      {new Date(h.created_at).toLocaleString()}
                    </span>
                    {h.note && <span className="text-muted-foreground">— {h.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-institutional p-4">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm capitalize text-foreground">{value}</dd>
    </div>
  );
}
