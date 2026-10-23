/**
 * Document room rules shared by the browser and the server: file limits,
 * review statuses, who may see or change a document, and file-type checks.
 * The server applies these on every request; the browser only mirrors them.
 */

export const DOCUMENT_BUCKET = "project-documents";
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_PROJECT = 60;
export const SIGNED_LINK_SECONDS = 300;

export type DocumentStatus =
  | "uploading"
  | "pending"
  | "released"
  | "rejected"
  | "withdrawn"
  | "superseded";

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploading: "Upload not finished",
  pending: "Awaiting review",
  released: "Released to investors",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  superseded: "Replaced by newer version",
};

export type FileKind = "pdf" | "png" | "jpeg" | "docx" | "xlsx" | "csv" | "txt";

const FILE_TYPES: Record<FileKind, { ext: string[]; mime: string[]; label: string }> = {
  pdf: { ext: ["pdf"], mime: ["application/pdf"], label: "PDF" },
  png: { ext: ["png"], mime: ["image/png"], label: "PNG image" },
  jpeg: { ext: ["jpg", "jpeg"], mime: ["image/jpeg"], label: "JPEG image" },
  docx: {
    ext: ["docx"],
    mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    label: "Word document",
  },
  xlsx: {
    ext: ["xlsx"],
    mime: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    label: "Excel spreadsheet",
  },
  csv: {
    ext: ["csv"],
    mime: ["text/csv", "application/csv", "application/vnd.ms-excel"],
    label: "CSV",
  },
  txt: { ext: ["txt"], mime: ["text/plain"], label: "Text" },
};

export const ACCEPT_ATTRIBUTE = Object.values(FILE_TYPES)
  .flatMap((t) => [...t.ext.map((e) => `.${e}`), ...t.mime])
  .join(",");

export const ACCEPTED_SUMMARY = "PDF, Word, Excel, CSV, text, PNG or JPEG, up to 25 MB";

/** Content type the file is stored and served with — always the canonical one for its kind. */
export function canonicalMime(kind: FileKind): string {
  return FILE_TYPES[kind].mime[0]!;
}

/**
 * Identifies an allowed file from its name and declared type. The extension
 * decides; a declared browser type that contradicts it is refused. Browsers
 * often send an empty type, which is accepted and re-checked from the bytes.
 */
export function fileKindOf(fileName: string, declaredMime: string): FileKind | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const mime = declaredMime.toLowerCase().split(";")[0]!.trim();
  for (const [kind, t] of Object.entries(FILE_TYPES) as [
    FileKind,
    (typeof FILE_TYPES)[FileKind],
  ][]) {
    if (!t.ext.includes(ext)) continue;
    if (mime && mime !== "application/octet-stream" && !t.mime.includes(mime)) return null;
    return kind;
  }
  return null;
}

/** Checks the first bytes of an uploaded file really are the type it claims to be. */
export function bytesMatchKind(kind: FileKind, head: Uint8Array): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => head[i] === b);
  switch (kind) {
    case "pdf":
      return starts([0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "png":
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "jpeg":
      return starts([0xff, 0xd8, 0xff]);
    case "docx":
    case "xlsx":
      return starts([0x50, 0x4b, 0x03, 0x04]);
    case "csv":
    case "txt": {
      if (head.length === 0) return false;
      const sample = head.subarray(0, 4096);
      if (sample.includes(0)) return false;
      const lower = new TextDecoder().decode(sample.subarray(0, 512)).trimStart().toLowerCase();
      return !(
        lower.startsWith("<!doctype html") ||
        lower.startsWith("<html") ||
        lower.startsWith("<svg") ||
        lower.startsWith("<script")
      );
    }
  }
}

/** Keeps a download filename readable and safe in a Content-Disposition header. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.\- ()]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-120);
  return cleaned.replace(/^[.\s]+/, "") || "document";
}

export interface Viewer {
  signedIn: boolean;
  isOwner: boolean;
  isAdmin: boolean;
}

/** Whether a viewer may see a document in the list, and open its file. */
export function documentAccess(
  viewer: Viewer,
  status: DocumentStatus,
): { list: boolean; open: boolean } {
  if (viewer.isAdmin || viewer.isOwner) return { list: true, open: status !== "uploading" };
  if (status !== "released") return { list: false, open: false };
  return { list: true, open: viewer.signedIn };
}

/** Released documents stay on record until an administrator withdraws them. */
export function canRemove(viewer: Viewer, status: DocumentStatus): boolean {
  if (viewer.isAdmin) return status !== "released";
  if (viewer.isOwner)
    return status === "uploading" || status === "pending" || status === "rejected";
  return false;
}

export type ReviewDecision = "release" | "reject" | "withdraw" | "reopen";

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  release: "Approve and release",
  reject: "Reject",
  withdraw: "Withdraw from investors",
  reopen: "Return to review",
};

/** The status an administrator decision moves a document to, or an explanation of why it cannot. */
export function reviewTransition(
  from: DocumentStatus,
  decision: ReviewDecision,
): { ok: true; to: DocumentStatus } | { ok: false; reason: string } {
  const allowed: Record<ReviewDecision, DocumentStatus[]> = {
    release: ["pending", "withdrawn"],
    reject: ["pending"],
    withdraw: ["released"],
    reopen: ["rejected", "withdrawn"],
  };
  const to: Record<ReviewDecision, DocumentStatus> = {
    release: "released",
    reject: "rejected",
    withdraw: "withdrawn",
    reopen: "pending",
  };
  if (!allowed[decision].includes(from)) {
    return {
      ok: false,
      reason: `A document that is "${STATUS_LABEL[from]}" cannot be changed with "${DECISION_LABEL[decision]}".`,
    };
  }
  return { ok: true, to: to[decision] };
}

/** Decisions an administrator can take from a status, in display order. */
export function decisionsFor(status: DocumentStatus): ReviewDecision[] {
  return (["release", "reject", "withdraw", "reopen"] as ReviewDecision[]).filter(
    (d) => reviewTransition(status, d).ok,
  );
}

/** Notes are required where the issuer needs to know what to fix or why access changed. */
export function decisionNeedsNote(decision: ReviewDecision): boolean {
  return decision === "reject" || decision === "withdraw";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
