/**
 * Server-only storage access for project document rooms.
 *
 * The bucket is private with no storage policies, so only this module (using
 * the service role) can touch it. Every caller must have authorised the
 * request first; nothing here decides who may do what.
 *
 * Layout per funding request:
 *   {requestId}/{documentId}/file       the uploaded file
 *   {requestId}/{documentId}/meta.json  status, classification and history
 *   {requestId}/_released.json          public index of released documents
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  DOCUMENT_BUCKET,
  SIGNED_LINK_SECONDS,
  bytesMatchKind,
  safeFileName,
  type FileKind,
  type Viewer,
} from "./document-rules";
import type { DocumentMeta } from "./document-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bucket = () => supabaseAdmin.storage.from(DOCUMENT_BUCKET);
const metaPath = (rid: string, did: string) => `${rid}/${did}/meta.json`;
const filePath = (rid: string, did: string) => `${rid}/${did}/file`;
const indexPath = (rid: string) => `${rid}/_released.json`;

export interface ProjectRef {
  id: string;
  name: string;
  asset_slug: string;
  category: string;
  status: string;
}

/** Works out who the caller is for one project, reading as the caller so normal access rules apply. */
export async function resolveViewer(
  sb: SupabaseClient,
  userId: string,
  fundingRequestId: string,
): Promise<{ project: ProjectRef; viewer: Viewer }> {
  const { data: req, error } = await sb
    .from("funding_requests")
    .select("id, name, asset_slug, category, status, submitted_by, issuer_id")
    .eq("id", fundingRequestId)
    .maybeSingle();
  if (error) throw new Error("The project could not be loaded.");
  if (!req) throw new Error("That project does not exist.");
  const row = req as ProjectRef & { submitted_by: string; issuer_id: string | null };

  let isOwner = row.submitted_by === userId;
  if (!isOwner && row.issuer_id) {
    const { data: issuer } = await sb
      .from("issuers")
      .select("owner_user_id")
      .eq("id", row.issuer_id)
      .maybeSingle();
    isOwner = (issuer as { owner_user_id?: string } | null)?.owner_user_id === userId;
  }
  const { data: isAdmin, error: roleErr } = await sb.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  } as never);
  if (roleErr) throw new Error("Your access could not be checked. Please try again.");

  return {
    project: {
      id: row.id,
      name: row.name,
      asset_slug: row.asset_slug,
      category: row.category,
      status: row.status,
    },
    viewer: { signedIn: true, isOwner, isAdmin: Boolean(isAdmin) },
  };
}

export async function isAdministrator(sb: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await sb.rpc("has_role", { _user_id: userId, _role: "admin" } as never);
  if (error) throw new Error("Your access could not be checked. Please try again.");
  return Boolean(data);
}

function isMeta(value: unknown, rid: string, did: string): value is DocumentMeta {
  const m = value as Partial<DocumentMeta> | null;
  return (
    !!m &&
    m.schema === 1 &&
    m.id === did &&
    m.fundingRequestId === rid &&
    typeof m.status === "string"
  );
}

export async function readMeta(rid: string, did: string): Promise<DocumentMeta | null> {
  if (!UUID.test(rid) || !UUID.test(did)) return null;
  const { data, error } = await bucket().download(metaPath(rid, did));
  if (error || !data) return null;
  try {
    const parsed: unknown = JSON.parse(await data.text());
    return isMeta(parsed, rid, did) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeMeta(meta: DocumentMeta): Promise<void> {
  const body = new Blob([JSON.stringify(meta)], { type: "application/json" });
  const { error } = await bucket().upload(metaPath(meta.fundingRequestId, meta.id), body, {
    upsert: true,
    contentType: "application/json",
    cacheControl: "no-cache",
  });
  if (error) {
    console.error("[documents] meta write failed", error.message);
    throw new Error("The document record could not be saved. Please try again.");
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Every document record stored for one project, newest first. */
export async function listMetas(rid: string): Promise<DocumentMeta[]> {
  if (!UUID.test(rid)) return [];
  const { data, error } = await bucket().list(rid, { limit: 500 });
  if (error) {
    console.error("[documents] list failed", error.message);
    throw new Error("Documents could not be loaded.");
  }
  const ids = (data ?? []).filter((e) => e.id === null && UUID.test(e.name)).map((e) => e.name);
  const metas = await mapLimit(ids, 8, (did) => readMeta(rid, did));
  return metas
    .filter((m): m is DocumentMeta => m !== null)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Project folders that hold documents. */
export async function listProjectFolders(): Promise<string[]> {
  const { data, error } = await bucket().list("", { limit: 1000 });
  if (error) {
    console.error("[documents] folder list failed", error.message);
    throw new Error("Documents could not be loaded.");
  }
  return (data ?? []).filter((e) => e.id === null && UUID.test(e.name)).map((e) => e.name);
}

export async function listMetasForProjects(rids: string[]): Promise<DocumentMeta[]> {
  const all = await mapLimit(rids, 4, (rid) => listMetas(rid));
  return all.flat();
}

/** Released documents only, from the public index. Falls back to a full scan if the index is missing. */
export async function readReleased(rid: string): Promise<DocumentMeta[]> {
  if (!UUID.test(rid)) return [];
  const { data, error } = await bucket().download(indexPath(rid));
  if (!error && data) {
    try {
      const parsed = JSON.parse(await data.text()) as { documents?: unknown[] };
      const docs = (parsed.documents ?? []).filter(
        (m): m is DocumentMeta =>
          isMeta(m, rid, (m as DocumentMeta)?.id) && (m as DocumentMeta).status === "released",
      );
      return docs;
    } catch {
      /* rebuild below */
    }
  }
  return (await listMetas(rid)).filter((m) => m.status === "released");
}

/** Rewrites the public index after any change that can affect what investors see. */
export async function rebuildReleasedIndex(rid: string): Promise<void> {
  const released = (await listMetas(rid)).filter((m) => m.status === "released");
  const body = new Blob(
    [JSON.stringify({ updatedAt: new Date().toISOString(), documents: released })],
    {
      type: "application/json",
    },
  );
  const { error } = await bucket().upload(indexPath(rid), body, {
    upsert: true,
    contentType: "application/json",
    cacheControl: "no-cache",
  });
  if (error) console.error("[documents] index write failed", error.message);
}

export async function createUploadTicket(
  rid: string,
  did: string,
): Promise<{ path: string; token: string }> {
  const { data, error } = await bucket().createSignedUploadUrl(filePath(rid, did));
  if (error || !data) {
    console.error("[documents] upload ticket failed", error?.message);
    throw new Error("The upload could not be started. Please try again.");
  }
  return { path: data.path, token: data.token };
}

/** Confirms the uploaded file exists, matches the declared size and type, and fingerprints it. */
export async function inspectUpload(
  rid: string,
  did: string,
  kind: FileKind,
  expectedSize: number,
): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const { data, error } = await bucket().download(filePath(rid, did));
  if (error || !data)
    return { ok: false, reason: "The file did not arrive. Please upload it again." };
  if (data.size !== expectedSize) {
    return {
      ok: false,
      reason: "The uploaded file is not the one that was announced. Please upload it again.",
    };
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (!bytesMatchKind(kind, bytes.subarray(0, 4096))) {
    return {
      ok: false,
      reason:
        "The file's contents do not match its type. Export it again as a genuine file of that type.",
    };
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return { ok: true, sha256 };
}

export async function removeDocumentObjects(rid: string, did: string): Promise<void> {
  const { error } = await bucket().remove([filePath(rid, did), metaPath(rid, did)]);
  if (error) {
    console.error("[documents] remove failed", error.message);
    throw new Error("The document could not be removed. Please try again.");
  }
}

/** A short-lived link to the file, addressed to the browser-facing storage host. */
export async function signedLink(
  meta: DocumentMeta,
  download: boolean,
): Promise<{ url: string; expiresAt: string }> {
  const { data, error } = await bucket().createSignedUrl(
    filePath(meta.fundingRequestId, meta.id),
    SIGNED_LINK_SECONDS,
    {
      download: download ? safeFileName(meta.fileName) : undefined,
    },
  );
  if (error || !data) {
    console.error("[documents] signed link failed", error?.message);
    throw new Error("The document could not be opened. Please try again.");
  }
  const base = process.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"] || "";
  const signed = new URL(data.signedUrl);
  const url = base
    ? `${base.replace(/\/$/, "")}${signed.pathname}${signed.search}`
    : data.signedUrl;
  return { url, expiresAt: new Date(Date.now() + SIGNED_LINK_SECONDS * 1000).toISOString() };
}

/** Records who did what. A logging failure is reported but never blocks the action itself. */
export async function audit(
  userId: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("security_audit_log")
    .insert({ user_id: userId, action, detail: detail as never });
  if (error) console.error("[documents] audit write failed", action, error.message);
}
