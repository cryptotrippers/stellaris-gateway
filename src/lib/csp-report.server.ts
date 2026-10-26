/**
 * Security Suite S2.1 — receive CSP reports and record them.
 *
 * Server-only. Called from src/server.ts for POST /api/public/csp-report.
 * Records are already sanitised (csp-report.shared.ts) and are written
 * through the `record_csp_report` database function, which aggregates by
 * day and caps the number of distinct rows per day, so a flood of reports
 * cannot grow the table without bound. The table has no client policies:
 * only the server (service role) writes, only admins read.
 */
import { MAX_BODY_BYTES, parseCspReports, type CspRecord } from "./csp-report.shared";

/** Per-isolate limit: reports accepted per client per minute. */
const PER_MINUTE = 30;
const seen = new Map<string, { minute: number; count: number }>();

export function allowReport(clientKey: string, now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  const s = seen.get(clientKey);
  if (!s || s.minute !== minute) {
    if (seen.size > 5_000) seen.clear();
    seen.set(clientKey, { minute, count: 1 });
    return true;
  }
  s.count += 1;
  return s.count <= PER_MINUTE;
}

type Recorder = (r: CspRecord) => Promise<void>;

async function recordWithSupabase(r: CspRecord): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await (
    supabaseAdmin as unknown as {
      rpc: (fn: string, args: Record<string, string>) => Promise<{ error: unknown }>;
    }
  ).rpc("record_csp_report", {
    p_directive: r.directive,
    p_blocked: r.blocked,
    p_document_path: r.documentPath,
    p_disposition: r.disposition,
  });
  if (error)
    console.warn("[csp-report] not recorded:", (error as { message?: string }).message ?? error);
}

/**
 * Handle one report request. Always answers 204 so browsers do not retry and
 * nothing about storage leaks to the caller.
 */
export async function handleCspReport(
  request: Request,
  record: Recorder = recordWithSupabase,
): Promise<Response> {
  const done = new Response(null, { status: 204 });
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_BODY_BYTES) return done;
  const client =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
  if (!allowReport(client.split(",")[0].trim())) return done;

  let body = "";
  try {
    body = await request.text();
  } catch {
    return done;
  }
  const records = parseCspReports(body);
  for (const r of records) {
    try {
      await record(r);
    } catch (e) {
      console.warn("[csp-report] not recorded:", e instanceof Error ? e.message : e);
    }
  }
  return done;
}
