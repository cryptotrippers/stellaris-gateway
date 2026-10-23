import {
  canRemove,
  decisionsFor,
  documentAccess,
  type DocumentStatus,
  type FileKind,
  type ReviewDecision,
  type Viewer,
} from "./document-rules";

export type HistoryAction = "submitted" | "released" | "rejected" | "withdrawn" | "reopened" | "superseded";

export interface DocumentHistoryEntry {
  at: string;
  action: HistoryAction;
  actor: "issuer" | "administrator" | "system";
  note: string | null;
}

/** What the server stores beside each file. Never sent to the browser as-is. */
export interface DocumentMeta {
  schema: 1;
  id: string;
  fundingRequestId: string;
  sectionKey: string;
  categoryKey: string;
  title: string;
  description: string | null;
  fileName: string;
  kind: FileKind;
  size: number;
  sha256: string | null;
  version: number;
  replaces: string | null;
  status: DocumentStatus;
  uploadedBy: string;
  uploadedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  releasedAt: string | null;
  history: DocumentHistoryEntry[];
}

/** A document as one particular viewer is allowed to see it. */
export interface ProjectDocument {
  id: string;
  sectionKey: string;
  categoryKey: string;
  title: string;
  description: string | null;
  fileName: string;
  kind: FileKind;
  size: number;
  sha256: string | null;
  version: number;
  replaces: string | null;
  status: DocumentStatus;
  uploadedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  releasedAt: string | null;
  /** Review notes and history are shown to the issuer and administrators only. */
  reviewNote: string | null;
  history: DocumentHistoryEntry[] | null;
  canOpen: boolean;
  canRemove: boolean;
  decisions: ReviewDecision[];
}

export interface DocumentRoomViewer {
  signedIn: boolean;
  isOwner: boolean;
  isAdmin: boolean;
}

export const ANONYMOUS_VIEWER: Viewer = { signedIn: false, isOwner: false, isAdmin: false };

/** Strips everything a viewer may not see. Returns null when the document is hidden from them. */
export function toProjectDocument(meta: DocumentMeta, viewer: Viewer): ProjectDocument | null {
  const access = documentAccess(viewer, meta.status);
  if (!access.list) return null;
  const insider = viewer.isOwner || viewer.isAdmin;
  return {
    id: meta.id,
    sectionKey: meta.sectionKey,
    categoryKey: meta.categoryKey,
    title: meta.title,
    description: meta.description,
    fileName: meta.fileName,
    kind: meta.kind,
    size: meta.size,
    sha256: meta.sha256,
    version: meta.version,
    replaces: meta.replaces,
    status: meta.status,
    uploadedAt: meta.uploadedAt,
    submittedAt: meta.submittedAt,
    reviewedAt: meta.reviewedAt,
    releasedAt: meta.releasedAt,
    reviewNote: insider ? meta.reviewNote : null,
    history: insider ? meta.history : null,
    canOpen: access.open,
    canRemove: canRemove(viewer, meta.status),
    decisions: viewer.isAdmin ? decisionsFor(meta.status) : [],
  };
}
