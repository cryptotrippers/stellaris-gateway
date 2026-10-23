/**
 * Project document room server functions.
 *
 * Only imports, types and server-function declarations live here. Storage
 * access is in `documents.server.ts`, loaded inside handlers after the
 * caller has been checked; rules are in `document-rules.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ACCEPTED_SUMMARY,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_PROJECT,
  canRemove,
  canonicalMime,
  decisionNeedsNote,
  documentAccess,
  fileKindOf,
  reviewTransition,
} from "./document-rules";
import { findCategory, projectTypeOf, type ProjectType } from "./document-taxonomy";
import {
  ANONYMOUS_VIEWER,
  toProjectDocument,
  type DocumentMeta,
  type DocumentRoomViewer,
  type HistoryAction,
  type ProjectDocument,
} from "./document-types";

const projectInput = z.object({ fundingRequestId: z.string().uuid() });
const documentInput = projectInput.extend({ documentId: z.string().uuid() });

const uploadInput = projectInput.extend({
  categoryKey: z.string().trim().min(1).max(60),
  title: z.string().trim().min(3, "Give the document a title of at least 3 characters.").max(140),
  description: z.string().trim().max(500).optional(),
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().max(150),
  size: z.number().int().positive().max(MAX_DOCUMENT_BYTES, "Files can be at most 25 MB."),
  replacesId: z.string().uuid().optional(),
});

const reviewInput = documentInput.extend({
  decision: z.enum(["release", "reject", "withdraw", "reopen"]),
  note: z.string().trim().max(1000).optional(),
});

const linkInput = documentInput.extend({ download: z.boolean().optional() });

const present = (list: (ProjectDocument | null)[]) =>
  list.filter((d): d is ProjectDocument => d !== null);

/** Released documents for anyone, including signed-out visitors. Files still need sign-in to open. */
export const listReleasedDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => projectInput.parse(input))
  .handler(async ({ data }): Promise<{ documents: ProjectDocument[] }> => {
    const { readReleased } = await import("./documents.server");
    const metas = await readReleased(data.fundingRequestId);
    setResponseHeader("Cache-Control", "public, max-age=30");
    return { documents: present(metas.map((m) => toProjectDocument(m, ANONYMOUS_VIEWER))) };
  });

/** The document room as the signed-in caller may see it. */
export const getDocumentRoom = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => projectInput.parse(input))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      viewer: DocumentRoomViewer;
      projectType: ProjectType;
      documents: ProjectDocument[];
    }> => {
      const s = await import("./documents.server");
      const { project, viewer } = await s.resolveViewer(
        context.supabase,
        context.userId,
        data.fundingRequestId,
      );
      const metas =
        viewer.isOwner || viewer.isAdmin
          ? await s.listMetas(project.id)
          : await s.readReleased(project.id);
      setResponseHeader("Cache-Control", "private, no-store");
      return {
        viewer,
        projectType: projectTypeOf(project.category),
        documents: present(metas.map((m) => toProjectDocument(m, viewer))),
      };
    },
  );

/** Step 1 of an upload: checks everything about the file and returns a one-time upload ticket. */
export const createDocumentUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => uploadInput.parse(input))
  .handler(
    async ({
      data,
      context,
    }): Promise<{ documentId: string; path: string; token: string; contentType: string }> => {
      const s = await import("./documents.server");
      const { project, viewer } = await s.resolveViewer(
        context.supabase,
        context.userId,
        data.fundingRequestId,
      );
      if (!viewer.isOwner && !viewer.isAdmin) {
        throw new Error("Only the project's issuer or an administrator can upload documents.");
      }
      if (project.status === "rejected")
        throw new Error("This project was rejected, so it no longer accepts documents.");

      const kind = fileKindOf(data.fileName, data.mimeType);
      if (!kind) throw new Error(`That file type is not accepted. Use ${ACCEPTED_SUMMARY}.`);

      const existing = await s.listMetas(project.id);
      if (existing.length >= MAX_DOCUMENTS_PER_PROJECT) {
        throw new Error(
          `A project can hold at most ${MAX_DOCUMENTS_PER_PROJECT} documents. Remove drafts or rejected files first.`,
        );
      }

      let categoryKey = data.categoryKey;
      let version = 1;
      let replaces: string | null = null;
      if (data.replacesId) {
        const previous = existing.find((m) => m.id === data.replacesId);
        if (!previous || previous.status === "uploading" || previous.status === "superseded") {
          throw new Error("The document you are replacing is no longer available.");
        }
        categoryKey = previous.categoryKey;
        version = previous.version + 1;
        replaces = previous.id;
      }

      const found = findCategory(projectTypeOf(project.category), categoryKey);
      if (!found) throw new Error("Choose a document type that belongs to this kind of project.");

      const now = new Date().toISOString();
      const meta: DocumentMeta = {
        schema: 1,
        id: crypto.randomUUID(),
        fundingRequestId: project.id,
        sectionKey: found.section.key,
        categoryKey: found.category.key,
        title: data.title,
        description: data.description || null,
        fileName: data.fileName,
        kind,
        size: data.size,
        sha256: null,
        version,
        replaces,
        status: "uploading",
        uploadedBy: context.userId,
        uploadedAt: now,
        submittedAt: null,
        reviewedAt: null,
        reviewNote: null,
        releasedAt: null,
        history: [],
      };
      await s.writeMeta(meta);
      const ticket = await s.createUploadTicket(project.id, meta.id);
      return {
        documentId: meta.id,
        path: ticket.path,
        token: ticket.token,
        contentType: canonicalMime(kind),
      };
    },
  );

/** Step 2 of an upload: verifies the stored file and sends it for review. */
export const completeDocumentUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => documentInput.parse(input))
  .handler(async ({ data, context }): Promise<ProjectDocument> => {
    const s = await import("./documents.server");
    const { viewer } = await s.resolveViewer(
      context.supabase,
      context.userId,
      data.fundingRequestId,
    );
    if (!viewer.isOwner && !viewer.isAdmin)
      throw new Error("You cannot change this project's documents.");
    const meta = await s.readMeta(data.fundingRequestId, data.documentId);
    if (!meta) throw new Error("That upload was not found. Please start again.");
    if (meta.status !== "uploading") return toProjectDocument(meta, viewer)!;

    const check = await s.inspectUpload(meta.fundingRequestId, meta.id, meta.kind, meta.size);
    if (!check.ok) {
      await s.removeDocumentObjects(meta.fundingRequestId, meta.id);
      throw new Error(check.reason);
    }
    const now = new Date().toISOString();
    meta.sha256 = check.sha256;
    meta.status = "pending";
    meta.submittedAt = now;
    meta.history.push({
      at: now,
      action: "submitted",
      actor: viewer.isOwner ? "issuer" : "administrator",
      note: null,
    });
    await s.writeMeta(meta);
    await s.audit(context.userId, "project_document_submitted", {
      funding_request_id: meta.fundingRequestId,
      document_id: meta.id,
      category: meta.categoryKey,
      sha256: meta.sha256,
    });
    return toProjectDocument(meta, viewer)!;
  });

/** Administrator decision: release to investors, reject, withdraw, or return to review. */
export const reviewDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => reviewInput.parse(input))
  .handler(async ({ data, context }): Promise<ProjectDocument> => {
    const s = await import("./documents.server");
    const { viewer } = await s.resolveViewer(
      context.supabase,
      context.userId,
      data.fundingRequestId,
    );
    if (!viewer.isAdmin) throw new Error("Only an administrator can review documents.");
    const meta = await s.readMeta(data.fundingRequestId, data.documentId);
    if (!meta) throw new Error("That document was not found.");

    const step = reviewTransition(meta.status, data.decision);
    if (!step.ok) throw new Error(step.reason);
    const note = data.note?.trim() || null;
    if (decisionNeedsNote(data.decision) && (!note || note.length < 10)) {
      throw new Error(
        "Explain the decision in at least 10 characters so the issuer knows what to do next.",
      );
    }

    const now = new Date().toISOString();
    const action: Record<typeof data.decision, HistoryAction> = {
      release: "released",
      reject: "rejected",
      withdraw: "withdrawn",
      reopen: "reopened",
    };

    if (data.decision === "release" && meta.replaces) {
      const previous = await s.readMeta(meta.fundingRequestId, meta.replaces);
      if (previous && previous.status === "released") {
        previous.status = "superseded";
        previous.history.push({
          at: now,
          action: "superseded",
          actor: "system",
          note: `Replaced by version ${meta.version}.`,
        });
        await s.writeMeta(previous);
      }
    }

    meta.status = step.to;
    meta.reviewedAt = now;
    meta.reviewNote = note;
    if (step.to === "released") meta.releasedAt = now;
    meta.history.push({ at: now, action: action[data.decision], actor: "administrator", note });
    await s.writeMeta(meta);
    await s.rebuildReleasedIndex(meta.fundingRequestId);
    await s.audit(context.userId, `project_document_${action[data.decision]}`, {
      funding_request_id: meta.fundingRequestId,
      document_id: meta.id,
      status: meta.status,
    });
    return toProjectDocument(meta, viewer)!;
  });

/** Deletes a document the caller is allowed to remove. Released documents must be withdrawn first. */
export const removeDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => documentInput.parse(input))
  .handler(async ({ data, context }): Promise<{ removed: true }> => {
    const s = await import("./documents.server");
    const { viewer } = await s.resolveViewer(
      context.supabase,
      context.userId,
      data.fundingRequestId,
    );
    const meta = await s.readMeta(data.fundingRequestId, data.documentId);
    if (!meta) return { removed: true };
    if (!canRemove(viewer, meta.status)) {
      throw new Error(
        meta.status === "released"
          ? "Released documents stay on record. Ask an administrator to withdraw it first."
          : "You cannot remove this document.",
      );
    }
    await s.removeDocumentObjects(meta.fundingRequestId, meta.id);
    await s.rebuildReleasedIndex(meta.fundingRequestId);
    await s.audit(context.userId, "project_document_removed", {
      funding_request_id: meta.fundingRequestId,
      document_id: meta.id,
      previous_status: meta.status,
    });
    return { removed: true };
  });

/** A five-minute link to open or download a file the caller may see. */
export const getDocumentLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => linkInput.parse(input))
  .handler(async ({ data, context }): Promise<{ url: string; expiresAt: string }> => {
    const s = await import("./documents.server");
    const { viewer } = await s.resolveViewer(
      context.supabase,
      context.userId,
      data.fundingRequestId,
    );
    const meta = await s.readMeta(data.fundingRequestId, data.documentId);
    if (!meta || !documentAccess(viewer, meta.status).open) {
      throw new Error("This document is not available to you.");
    }
    const link = await s.signedLink(meta, Boolean(data.download));
    await s.audit(context.userId, "project_document_opened", {
      funding_request_id: meta.fundingRequestId,
      document_id: meta.id,
      as: viewer.isAdmin ? "administrator" : viewer.isOwner ? "issuer" : "investor",
    });
    setResponseHeader("Cache-Control", "private, no-store");
    return link;
  });

export interface ReviewQueueItem {
  fundingRequestId: string;
  projectName: string;
  projectSlug: string;
  projectType: ProjectType;
  document: ProjectDocument;
}

/** Administrator queue: every document awaiting review, oldest first, plus totals by status. */
export const listDocumentReviewQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({ context }): Promise<{ items: ReviewQueueItem[]; totals: Record<string, number> }> => {
      const s = await import("./documents.server");
      if (!(await s.isAdministrator(context.supabase, context.userId))) {
        throw new Error("Administrator access is required to review documents.");
      }
      const folders = await s.listProjectFolders();
      const metas = await s.listMetasForProjects(folders);
      const totals: Record<string, number> = {};
      for (const m of metas) totals[m.status] = (totals[m.status] ?? 0) + 1;

      const pending = metas.filter((m) => m.status === "pending");
      const ids = [...new Set(pending.map((m) => m.fundingRequestId))];
      const projects = new Map<string, { name: string; asset_slug: string; category: string }>();
      if (ids.length) {
        const { data: rows, error } = await context.supabase
          .from("funding_requests")
          .select("id, name, asset_slug, category")
          .in("id", ids);
        if (error) throw new Error("Project names could not be loaded.");
        for (const r of rows ?? []) projects.set(r.id, r);
      }
      const admin = { signedIn: true, isOwner: false, isAdmin: true };
      const items = pending
        .sort((a, b) =>
          (a.submittedAt ?? a.uploadedAt).localeCompare(b.submittedAt ?? b.uploadedAt),
        )
        .flatMap((m) => {
          const p = projects.get(m.fundingRequestId);
          const doc = toProjectDocument(m, admin);
          if (!p || !doc) return [];
          return [
            {
              fundingRequestId: m.fundingRequestId,
              projectName: p.name,
              projectSlug: p.asset_slug,
              projectType: projectTypeOf(p.category),
              document: doc,
            },
          ];
        });
      setResponseHeader("Cache-Control", "private, no-store");
      return { items, totals };
    },
  );
