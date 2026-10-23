import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertCircle,
  ChevronDown,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  RefreshCw,
  Replace,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useSupabaseUser } from "@/hooks/useSupabaseUser";
import {
  ACCEPTED_SUMMARY,
  ACCEPT_ATTRIBUTE,
  DECISION_LABEL,
  DOCUMENT_BUCKET,
  MAX_DOCUMENT_BYTES,
  STATUS_LABEL,
  decisionNeedsNote,
  fileKindOf,
  formatBytes,
  type DocumentStatus,
  type ReviewDecision,
} from "./document-rules";
import {
  CHECKLIST_LABEL,
  PROJECT_TYPE_LABEL,
  documentSectionsFor,
  findCategory,
  projectTypeOf,
  type DocumentSection,
  type ProjectType,
} from "./document-taxonomy";
import type { DocumentRoomViewer, ProjectDocument } from "./document-types";
import {
  completeDocumentUpload,
  createDocumentUpload,
  getDocumentLink,
  getDocumentRoom,
  listReleasedDocuments,
  removeDocument,
  reviewDocument,
} from "./documents.functions";

type Audience = "room" | "investor";
type Filter = "all" | "pending" | "released" | "rejected" | "inactive";

const SIGNED_OUT: DocumentRoomViewer = { signedIn: false, isOwner: false, isAdmin: false };

const STATUS_CLASS: Record<DocumentStatus, string> = {
  released: "border-success/30 bg-success/10 text-success",
  pending: "border-gold/40 bg-gold/15 text-foreground",
  rejected: "border-destructive/30 bg-destructive/10 text-destructive",
  withdrawn: "border-border bg-muted text-muted-foreground",
  superseded: "border-border bg-muted text-muted-foreground",
  uploading: "border-dashed border-border bg-surface text-muted-foreground",
};

const FILTERS: { key: Filter; label: string; match: (s: DocumentStatus) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "pending", label: "Awaiting review", match: (s) => s === "pending" },
  { key: "released", label: "Released", match: (s) => s === "released" },
  { key: "rejected", label: "Rejected", match: (s) => s === "rejected" },
  { key: "inactive", label: "Withdrawn or replaced", match: (s) => s === "withdrawn" || s === "superseded" || s === "uploading" },
];

const dateText = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

export const documentRoomKey = (fundingRequestId: string) => ["document-room", fundingRequestId] as const;

/** Loads the document room as the current visitor may see it. */
export function useDocumentRoom(fundingRequestId: string, category: string) {
  const { user, loading } = useSupabaseUser();
  const fetchRoom = useServerFn(getDocumentRoom);
  const fetchReleased = useServerFn(listReleasedDocuments);
  const query = useQuery({
    queryKey: [...documentRoomKey(fundingRequestId), user?.id ?? "signed-out"],
    enabled: !loading,
    staleTime: 30_000,
    queryFn: async (): Promise<{ viewer: DocumentRoomViewer; projectType: ProjectType; documents: ProjectDocument[] }> => {
      if (user) return fetchRoom({ data: { fundingRequestId } });
      const res = await fetchReleased({ data: { fundingRequestId } });
      return { viewer: SIGNED_OUT, projectType: projectTypeOf(category), documents: res.documents };
    },
  });
  return { query, authLoading: loading };
}

export function DocumentRoom({
  fundingRequestId,
  category,
  audience = "room",
}: {
  fundingRequestId: string;
  category: string;
  audience?: Audience;
}) {
  const qc = useQueryClient();
  const { query, authLoading } = useDocumentRoom(fundingRequestId, category);
  const [upload, setUpload] = useState<{ categoryKey?: string; replaces?: ProjectDocument } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const type = query.data?.projectType ?? projectTypeOf(category);
  const viewer = query.data?.viewer ?? SIGNED_OUT;
  const insider = audience === "room" && (viewer.isOwner || viewer.isAdmin);
  const all = useMemo(
    () => (query.data?.documents ?? []).filter((d) => insider || d.status === "released"),
    [query.data, insider],
  );
  const match = FILTERS.find((f) => f.key === filter)!.match;
  const shown = insider ? all.filter((d) => match(d.status)) : all;
  const counts = useMemo(() => {
    const c: Partial<Record<DocumentStatus, number>> = {};
    for (const d of all) c[d.status] = (c[d.status] ?? 0) + 1;
    return c;
  }, [all]);

  const refresh = () => qc.invalidateQueries({ queryKey: documentRoomKey(fundingRequestId) });

  if (authLoading || query.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading documents">
        <div className="h-10 animate-pulse rounded-lg bg-secondary" />
        <div className="h-24 animate-pulse rounded-xl bg-secondary" />
        <div className="h-24 animate-pulse rounded-xl bg-secondary" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" /> Documents didn&apos;t load.
        </p>
        <p className="mt-1 text-muted-foreground">{errorText(query.error)}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  }

  const sections = documentSectionsFor(type);
  const visibleSections = sections
    .map((s) => ({ section: s, docs: shown.filter((d) => d.sectionKey === s.key) }))
    .filter(({ docs }) => insider ? filter === "all" || docs.length > 0 : docs.length > 0);
  const emptyForInvestors = sections.length - visibleSections.length;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-teal">{PROJECT_TYPE_LABEL[type]} document profile</p>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {insider && viewer.isAdmin
              ? "You hold the administrator role. Approve documents for release to investors, reject them with a reason, or withdraw them."
              : insider
                ? "You are this project's issuer. Upload supporting documents; nothing is shown to investors until an administrator approves its release."
                : viewer.signedIn
                  ? "Documents an administrator has approved for release to investors."
                  : "Documents an administrator has approved for release to investors. Sign in to open them."}
          </p>
        </div>
        {insider && (
          <Button onClick={() => setUpload({})} disabled={upload !== null}>
            <Upload /> Upload document
          </Button>
        )}
      </div>

      {insider && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter documents by status">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? all.length : all.filter((d) => f.match(d.status)).length;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.key ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label} <span className="tabular-nums">({n})</span>
              </button>
            );
          })}
        </div>
      )}

      {upload && (
        <UploadPanel
          fundingRequestId={fundingRequestId}
          type={type}
          initialCategory={upload.categoryKey}
          replaces={upload.replaces}
          onClose={() => setUpload(null)}
          onDone={() => {
            setUpload(null);
            void refresh();
          }}
        />
      )}

      <div className="mt-5 space-y-4">
        {visibleSections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {insider ? "No documents match this filter." : "No documents have been released to investors yet."}
          </div>
        ) : (
          visibleSections.map(({ section, docs }) => (
            <SectionBlock
              key={section.key}
              section={section}
              docs={docs}
              insider={insider}
              showEmptyCategories={insider && filter === "all"}
              fundingRequestId={fundingRequestId}
              onUpload={(categoryKey) => setUpload({ categoryKey })}
              onReplace={(doc) => setUpload({ replaces: doc })}
              onChanged={refresh}
            />
          ))
        )}
      </div>

      {!insider && emptyForInvestors > 0 && visibleSections.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          {emptyForInvestors} other document {emptyForInvestors === 1 ? "section has" : "sections have"} nothing released yet.
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-start gap-2 rounded-xl bg-secondary/50 p-3 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          Files are stored privately. Each open creates a personal link that expires after five minutes, and
          every open is recorded. The fingerprint shown for each file lets you confirm the copy you hold is the
          one that was reviewed.
          {!viewer.signedIn && (
            <>
              {" "}
              <Link to="/auth" className="font-medium text-teal hover:underline">
                Sign in
              </Link>{" "}
              to open released documents.
            </>
          )}
        </p>
      </div>
      {insider && counts.pending ? (
        <p className="sr-only" aria-live="polite">
          {counts.pending} documents awaiting review.
        </p>
      ) : null}
    </div>
  );
}

function SectionBlock({
  section,
  docs,
  insider,
  showEmptyCategories,
  fundingRequestId,
  onUpload,
  onReplace,
  onChanged,
}: {
  section: DocumentSection;
  docs: ProjectDocument[];
  insider: boolean;
  showEmptyCategories: boolean;
  fundingRequestId: string;
  onUpload: (categoryKey: string) => void;
  onReplace: (doc: ProjectDocument) => void;
  onChanged: () => void;
}) {
  const categories = section.categories.filter(
    (c) => showEmptyCategories || docs.some((d) => d.categoryKey === c.key),
  );
  // Empty sections start folded for the issuer and administrators so files stand out.
  const [open, setOpen] = useState(!insider || docs.length > 0);
  const panelId = `doc-section-${section.key}`;
  return (
    <div className="rounded-xl border border-border p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="block font-display text-sm font-semibold text-foreground">{section.label}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{section.description}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {docs.length === 0 ? "Nothing uploaded" : `${docs.length} ${docs.length === 1 ? "file" : "files"}`}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
        </span>
      </button>
      <ul id={panelId} hidden={!open} className="mt-3 space-y-3">
        {categories.map((c) => {
          const inCat = docs.filter((d) => d.categoryKey === c.key);
          return (
            <li key={c.key} className="rounded-lg bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{c.label}</p>
                  {insider && <p className="text-xs text-muted-foreground">{c.hint}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {c.supports && (
                    <span className="rounded-full border border-teal/30 bg-teal/10 px-2 py-0.5 text-[11px] text-teal">
                      Evidence for: {CHECKLIST_LABEL[c.supports]}
                    </span>
                  )}
                  {insider && (
                    <Button variant="ghost" size="sm" onClick={() => onUpload(c.key)} aria-label={`Upload ${c.label}`}>
                      <Upload /> Upload
                    </Button>
                  )}
                </div>
              </div>
              {inCat.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">Nothing uploaded yet.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {inCat.map((d) => (
                    <DocumentRow
                      key={d.id}
                      doc={d}
                      insider={insider}
                      fundingRequestId={fundingRequestId}
                      onReplace={() => onReplace(d)}
                      onChanged={onChanged}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DocumentRow({
  doc,
  insider,
  fundingRequestId,
  onReplace,
  onChanged,
}: {
  doc: ProjectDocument;
  insider: boolean;
  fundingRequestId: string;
  onReplace: () => void;
  onChanged: () => void;
}) {
  const linkFn = useServerFn(getDocumentLink);
  const reviewFn = useServerFn(reviewDocument);
  const removeFn = useServerFn(removeDocument);
  const [busy, setBusy] = useState<string | null>(null);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  async function open(download: boolean) {
    // Open the tab synchronously so pop-up blockers allow it, then point it at the signed link.
    const tab = download ? null : window.open("", "_blank");
    setBusy(download ? "download" : "open");
    try {
      const { url } = await linkFn({ data: { fundingRequestId, documentId: doc.id, download } });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {
      tab?.close();
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function decide() {
    if (!decision) return;
    setBusy("review");
    try {
      await reviewFn({ data: { fundingRequestId, documentId: doc.id, decision, note: note.trim() || undefined } });
      toast.success(
        decision === "release"
          ? "Released. Signed-in investors can now open this document."
          : decision === "reject"
            ? "Rejected. The issuer can see your reason."
            : decision === "withdraw"
              ? "Withdrawn. Investors can no longer open this document."
              : "Returned to review.",
      );
      setDecision(null);
      setNote("");
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      await removeFn({ data: { fundingRequestId, documentId: doc.id } });
      toast.success("Document removed.");
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  }

  const noteRequired = decision ? decisionNeedsNote(decision) : false;
  const canReplace = insider && ["released", "pending", "rejected", "withdrawn"].includes(doc.status);

  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-teal" aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-foreground">
              {doc.title}
              {doc.version > 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">Version {doc.version}</span>}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {doc.kind.toUpperCase()} · {formatBytes(doc.size)} · Uploaded {dateText(doc.uploadedAt)}
              {doc.releasedAt && doc.status === "released" ? ` · Released ${dateText(doc.releasedAt)}` : ""}
            </p>
            {doc.sha256 && (
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground" title={doc.sha256}>
                Fingerprint {doc.sha256.slice(0, 12)}…{doc.sha256.slice(-6)}
              </p>
            )}
            {doc.description && <p className="mt-1 text-xs text-foreground">{doc.description}</p>}
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[doc.status]}`}>
          {STATUS_LABEL[doc.status]}
        </span>
      </div>

      {insider && doc.reviewNote && (
        <p
          className={`mt-2 rounded-md p-2 text-xs ${
            doc.status === "rejected" ? "bg-destructive/10 text-destructive" : "bg-secondary text-foreground"
          }`}
        >
          <span className="font-medium">Administrator note:</span> {doc.reviewNote}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {doc.canOpen ? (
          <>
            <Button size="sm" variant="outline" onClick={() => open(false)} disabled={busy !== null}>
              {busy === "open" ? <Loader2 className="animate-spin" /> : <ExternalLink />} Open
            </Button>
            <Button size="sm" variant="ghost" onClick={() => open(true)} disabled={busy !== null}>
              {busy === "download" ? <Loader2 className="animate-spin" /> : <Download />} Download
            </Button>
          </>
        ) : doc.status === "released" ? (
          <Button size="sm" variant="outline" asChild>
            <Link to="/auth">
              <Lock /> Sign in to open
            </Link>
          </Button>
        ) : null}
        {canReplace && (
          <Button size="sm" variant="ghost" onClick={onReplace} disabled={busy !== null}>
            <Replace /> Upload new version
          </Button>
        )}
        {doc.decisions.map((d) => (
          <Button
            key={d}
            size="sm"
            variant={d === "release" ? "default" : d === "reject" || d === "withdraw" ? "outline" : "ghost"}
            onClick={() => {
              setDecision(d);
              setNote("");
            }}
            disabled={busy !== null}
            aria-pressed={decision === d}
          >
            {DECISION_LABEL[d]}
          </Button>
        ))}
        {doc.canRemove && (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
            <Trash2 /> Remove
          </Button>
        )}
        {insider && doc.history && doc.history.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            <ChevronDown className={showHistory ? "rotate-180 transition-transform" : "transition-transform"} /> History
          </Button>
        )}
      </div>

      {decision && (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <p className="text-sm font-medium text-foreground">{DECISION_LABEL[decision]}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {decision === "release"
              ? "Every signed-in investor will be able to open and download this file. Check it contains nothing confidential that should stay private."
              : decision === "reject"
                ? "Tell the issuer what is wrong or missing. They will see this note."
                : decision === "withdraw"
                  ? "Investors lose access immediately. Explain why for the record."
                  : "The document goes back to awaiting review."}
          </p>
          <label className="mt-2 block text-xs text-muted-foreground">
            {noteRequired ? "Reason (required)" : "Note (optional)"}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={1000}
              className="input mt-1 resize-y"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={decide} disabled={busy !== null || (noteRequired && note.trim().length < 10)}>
              {busy === "review" && <Loader2 className="animate-spin" />} Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDecision(null)} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {showHistory && doc.history && (
        <ol className="mt-3 space-y-1 border-l border-border pl-3 text-xs text-muted-foreground">
          {doc.history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <span className="text-foreground">{dateText(h.at)}</span> · {historyLabel(h.action)} by{" "}
              {h.actor === "system" ? "the system" : h.actor === "issuer" ? "the issuer" : "an administrator"}
              {h.note ? ` — “${h.note}”` : ""}
            </li>
          ))}
        </ol>
      )}

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{doc.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The file and its review history are deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "remove"}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
              disabled={busy === "remove"}
            >
              {busy === "remove" && <Loader2 className="animate-spin" />} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function historyLabel(action: NonNullable<ProjectDocument["history"]>[number]["action"]): string {
  switch (action) {
    case "submitted":
      return "Submitted for review";
    case "released":
      return "Approved and released";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
    case "reopened":
      return "Returned to review";
    case "superseded":
      return "Replaced";
  }
}

type UploadStep = "idle" | "preparing" | "uploading" | "verifying";

const STEP_LABEL: Record<UploadStep, string> = {
  idle: "Upload",
  preparing: "Checking…",
  uploading: "Uploading…",
  verifying: "Verifying file…",
};

function UploadPanel({
  fundingRequestId,
  type,
  initialCategory,
  replaces,
  onClose,
  onDone,
}: {
  fundingRequestId: string;
  type: ProjectType;
  initialCategory?: string;
  replaces?: ProjectDocument;
  onClose: () => void;
  onDone: () => void;
}) {
  const sections = documentSectionsFor(type);
  const createFn = useServerFn(createDocumentUpload);
  const completeFn = useServerFn(completeDocumentUpload);
  const removeFn = useServerFn(removeDocument);
  const [categoryKey, setCategoryKey] = useState(replaces?.categoryKey ?? initialCategory ?? "");
  const [title, setTitle] = useState(replaces?.title ?? "");
  const [description, setDescription] = useState(replaces?.description ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<UploadStep>("idle");
  const [error, setError] = useState<string | null>(null);

  const chosen = categoryKey ? findCategory(type, categoryKey) : null;
  const busy = step !== "idle";

  function validate(): string | null {
    if (!chosen) return "Choose what kind of document this is.";
    if (title.trim().length < 3) return "Give the document a title of at least 3 characters.";
    if (!file) return "Choose a file to upload.";
    if (file.size === 0) return "That file is empty.";
    if (file.size > MAX_DOCUMENT_BYTES) return "Files can be at most 25 MB.";
    if (!fileKindOf(file.name, file.type)) return `That file type is not accepted. Use ${ACCEPTED_SUMMARY}.`;
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem || !file) return;
    let documentId: string | null = null;
    try {
      setStep("preparing");
      const ticket = await createFn({
        data: {
          fundingRequestId,
          categoryKey,
          title: title.trim(),
          description: description.trim() || undefined,
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          replacesId: replaces?.id,
        },
      });
      documentId = ticket.documentId;
      setStep("uploading");
      const { error: upErr } = await supabase.storage
        .from(DOCUMENT_BUCKET)
        .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: ticket.contentType });
      if (upErr) throw new Error("The upload did not finish. Check your connection and try again.");
      setStep("verifying");
      await completeFn({ data: { fundingRequestId, documentId } });
      documentId = null;
      toast.success("Uploaded. An administrator will review it before investors can see it.");
      onDone();
    } catch (err) {
      setError(errorText(err));
      if (documentId) {
        // Clear the unfinished record so it does not linger in the room.
        await removeFn({ data: { fundingRequestId, documentId } }).catch(() => undefined);
      }
    } finally {
      setStep("idle");
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 rounded-xl border border-teal/30 bg-teal/5 p-4" aria-label="Upload a document">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-sm font-semibold text-foreground">
            {replaces ? `New version of “${replaces.title}”` : "Upload a supporting document"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {replaces
              ? "The current version stays available until an administrator releases this one."
              : "Administrators review every file. Investors only see it after it is approved for release."}
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} disabled={busy} aria-label="Close upload form">
          <X />
        </Button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted-foreground">Document type</span>
          <select
            value={categoryKey}
            onChange={(e) => setCategoryKey(e.target.value)}
            disabled={busy || Boolean(replaces)}
            className="input mt-1"
            required
          >
            <option value="">Choose…</option>
            {sections.map((s) => (
              <optgroup key={s.key} label={s.label}>
                {s.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {chosen && <span className="mt-1 block text-[11px] text-muted-foreground">{chosen.category.hint}</span>}
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={140}
            disabled={busy}
            placeholder="e.g. Land lease — Plot 14, signed March 2026"
            className="input mt-1"
            required
          />
        </label>
        <label className="block text-sm md:col-span-2">
          <span className="text-muted-foreground">What it shows (optional)</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={busy}
            className="input mt-1 resize-y"
          />
        </label>
        <label className="block text-sm md:col-span-2">
          <span className="text-muted-foreground">File</span>
          <input
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            disabled={busy}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {file ? `${file.name} · ${formatBytes(file.size)}` : ACCEPTED_SUMMARY}
          </span>
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Upload />} {STEP_LABEL[step]}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
