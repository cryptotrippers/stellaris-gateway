import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, FileText, LogIn, RefreshCw, ShieldAlert } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { Button } from "@/components/ui/button";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import { listDocumentReviewQueue } from "@/components/documents/documents.functions";
import { formatBytes } from "@/components/documents/document-rules";
import { PROJECT_TYPE_LABEL, findCategory } from "@/components/documents/document-taxonomy";

export const Route = createFileRoute("/document-review")({
  head: () => ({
    meta: [
      { title: "Document Review Queue · Stellaris" },
      {
        name: "description",
        content:
          "Administrator queue of project documents awaiting a release or rejection decision.",
      },
      { property: "og:title", content: "Document Review Queue · Stellaris" },
      { property: "og:description", content: "Administrator-only document review queue." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DocumentReviewPage,
});

function DocumentReviewPage() {
  const { user, loading } = useSupabaseUser();
  const fetchQueue = useServerFn(listDocumentReviewQueue);
  const q = useQuery({
    queryKey: ["document-review-queue", user?.id],
    queryFn: () => fetchQueue(),
    enabled: Boolean(user),
    retry: 0,
  });

  return (
    <MarketingLayout>
      <div className="home-container py-10 md:py-14">
        <p className="home-eyebrow">Administrator</p>
        <h1 className="mt-2 font-display text-3xl font-semibold text-foreground">
          Document review queue
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Files issuers have uploaded that are waiting for a decision, oldest first. Open a
          project&apos;s document room to read the file and approve its release to investors or
          reject it with a reason.
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-muted-foreground">Checking your session…</p>
        ) : !user ? (
          <div className="mt-8 card-institutional p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Sign in with an administrator account to review documents.
            </p>
            <Button asChild className="mt-4">
              <Link to="/auth" search={{ mode: "signin", redirect: "/document-review" }}>
                <LogIn /> Sign in
              </Link>
            </Button>
          </div>
        ) : q.isPending ? (
          <div className="mt-8 space-y-3" aria-busy="true" aria-label="Loading review queue">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-secondary" />
            ))}
          </div>
        ) : q.isError ? (
          <div role="alert" className="mt-8 card-institutional p-6">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden="true" />{" "}
              {q.error.message}
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => q.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        ) : (
          <>
            <dl className="mt-8 grid gap-3 sm:grid-cols-4">
              {[
                ["Awaiting review", q.data.totals.pending ?? 0],
                ["Released", q.data.totals.released ?? 0],
                ["Rejected", q.data.totals.rejected ?? 0],
                ["Withdrawn", q.data.totals.withdrawn ?? 0],
              ].map(([label, n]) => (
                <div key={label} className="card-institutional p-4">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-display text-2xl font-semibold tabular-nums text-foreground">
                    {n}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 flex items-center justify-between gap-3">
              <h2 className="font-display text-lg font-semibold text-foreground">
                Awaiting a decision
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.refetch()}
                disabled={q.isFetching}
              >
                <RefreshCw className={q.isFetching ? "animate-spin" : ""} /> Refresh
              </Button>
            </div>
            {q.data.items.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                Nothing is waiting for review.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {q.data.items.map((item) => {
                  const cat = findCategory(item.projectType, item.document.categoryKey);
                  return (
                    <li
                      key={item.document.id}
                      className="card-institutional flex flex-wrap items-center justify-between gap-4 p-4"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <FileText
                          className="mt-0.5 h-5 w-5 shrink-0 text-teal"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="break-words text-sm font-medium text-foreground">
                            {item.document.title}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.projectName} · {PROJECT_TYPE_LABEL[item.projectType]} ·{" "}
                            {cat?.category.label ?? item.document.categoryKey}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.document.kind.toUpperCase()} · {formatBytes(item.document.size)} ·
                            submitted{" "}
                            {new Date(
                              item.document.submittedAt ?? item.document.uploadedAt,
                            ).toLocaleString()}
                            {item.document.version > 1 ? ` · version ${item.document.version}` : ""}
                          </p>
                        </div>
                      </div>
                      <Button asChild size="sm">
                        <Link to="/funding/$id" params={{ id: item.projectSlug }} hash="documents">
                          Review <ArrowRight />
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </MarketingLayout>
  );
}
