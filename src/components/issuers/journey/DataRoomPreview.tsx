import { Link } from "@tanstack/react-router";
import { ExternalLink, FileText, FolderLock, Lock } from "lucide-react";
import { CHECKLIST_ITEMS, type ChecklistRow } from "@/lib/accelerator.shared";
import { useDocumentRoom } from "@/components/documents/use-document-room";
import {
  documentSectionsFor,
  projectTypeOf,
  PROJECT_TYPE_LABEL,
} from "@/components/documents/document-taxonomy";

const STATUS: Record<string, { label: string; cls: string }> = {
  missing: { label: "Not submitted", cls: "border-border bg-muted text-muted-foreground" },
  submitted: { label: "Under review", cls: "border-teal/30 bg-teal/10 text-teal" },
  verified: {
    label: "Verified by administrator",
    cls: "border-success/30 bg-success/10 text-success",
  },
  rejected: { label: "Rejected", cls: "border-destructive/30 bg-destructive/10 text-destructive" },
};

/**
 * The issuer's private evidence overview: document room totals, plus each
 * verification check with the files uploaded as evidence for it. Check
 * statuses come from the checklist records; file counts from the document room.
 */
export function DataRoomPreview({
  checklist,
  slug,
  fundingRequestId,
  category,
}: {
  checklist: ChecklistRow[];
  slug: string;
  fundingRequestId: string;
  category: string;
}) {
  const byKey = new Map(checklist.map((c) => [c.item_key, c]));
  const { query } = useDocumentRoom(fundingRequestId, category);
  const docs = query.data?.documents ?? [];
  const type = query.data?.projectType ?? projectTypeOf(category);
  const supportsOf = new Map<string, string | undefined>(
    documentSectionsFor(type).flatMap((s) => s.categories.map((c) => [c.key, c.supports] as const)),
  );
  const count = (status: string) => docs.filter((d) => d.status === status).length;
  const filesFor = (checkKey: string) =>
    docs.filter((d) => supportsOf.get(d.categoryKey) === checkKey && d.status !== "superseded");

  return (
    <div>
      <div className="rounded-xl border border-teal/30 bg-teal/5 p-4">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FolderLock className="h-4 w-4 text-teal" aria-hidden="true" /> Private document room ·{" "}
          {PROJECT_TYPE_LABEL[type]}
        </p>
        {query.isLoading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading documents…</p>
        ) : query.isError ? (
          <p className="mt-2 text-xs text-destructive">Document totals didn&apos;t load.</p>
        ) : (
          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            {[
              ["Awaiting review", count("pending")],
              ["Released", count("released")],
              ["Rejected", count("rejected")],
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg bg-card p-2">
                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                <dd className="font-display text-lg font-semibold tabular-nums text-foreground">
                  {n}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Link
          to="/funding/$id"
          params={{ id: slug }}
          hash="documents"
          className="mt-3 inline-flex text-sm font-medium text-teal hover:underline"
        >
          Open the document room to upload or review
        </Link>
      </div>

      <ul className="mt-4 grid gap-3 md:grid-cols-2">
        {CHECKLIST_ITEMS.map((item) => {
          const row = byKey.get(item.key);
          const st = STATUS[row?.status ?? "missing"] ?? STATUS.missing!;
          const files = filesFor(item.key);
          return (
            <li key={item.key} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Verification check{item.required ? " · required" : ""}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <FileText className="h-4 w-4 text-teal" aria-hidden="true" /> {item.label}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${st.cls}`}
                >
                  {st.label}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Last reviewed</dt>
                  <dd className="text-foreground">
                    {row?.verified_at ? new Date(row.verified_at).toLocaleDateString("en-AU") : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Supporting files</dt>
                  <dd className="text-foreground">
                    {query.isLoading
                      ? "…"
                      : files.length === 0
                        ? "None uploaded"
                        : `${files.length} (${files.filter((f) => f.status === "released").length} released)`}
                  </dd>
                </div>
              </dl>
              {row?.note && (
                <p
                  className={`mt-2 rounded-lg px-2.5 py-1.5 text-xs ${row.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-secondary/70 text-foreground"}`}
                >
                  {row.status === "rejected" ? "Rejection reason: " : "Reviewer note: "}
                  {row.note}
                </p>
              )}
              {row?.evidence_url && (
                <a
                  href={row.evidence_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 break-all text-xs text-teal hover:underline"
                >
                  Public evidence link{" "}
                  <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Files in the document room stay private to you and administrators until one is approved for
        release. Evidence links on the verification checklist are public — use the document room for
        anything confidential. A check is only marked verified when an administrator verifies it.
      </p>
    </div>
  );
}
