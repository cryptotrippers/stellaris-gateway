/**
 * Sprint 2 E10 — scheduled integrity checks.
 *
 * Run nightly by .github/workflows/nightly-integrity.yml through the signed
 * endpoint /api/public/jobs/integrity. Each check re-proves something the
 * database alone can't: today, that every Meridian project's hash chain and
 * approved-period roots still verify (tampering by anyone with direct
 * database access shows up here). Further checks (chain reconciliation S5.4,
 * stale v2 pledges) are added to JOBS.
 */
import { loadLedger, type LedgerRepo } from "./ledger-store.server";

export interface IntegrityFailure {
  check: string;
  subject: string;
  code: string;
  message: string;
}

export interface IntegrityReport {
  ranAt: string;
  checks: Record<string, { checked: number; failed: number }>;
  failures: IntegrityFailure[];
  ok: boolean;
}

export interface IntegrityDeps {
  ledger: LedgerRepo;
}

/** Every Meridian project: hash chain, row/column agreement, approved roots. */
export async function checkLedgers(
  deps: IntegrityDeps,
): Promise<{ checked: number; failures: IntegrityFailure[] }> {
  const ids = await deps.ledger.listProjectIds();
  const failures: IntegrityFailure[] = [];
  for (const id of ids) {
    try {
      const r = await loadLedger(deps.ledger, id);
      if (!r.ok)
        failures.push({
          check: "ledger",
          subject: id,
          code: r.error.code,
          message: r.error.message,
        });
    } catch (e) {
      failures.push({
        check: "ledger",
        subject: id,
        code: "unreadable",
        message: (e as Error).message,
      });
    }
  }
  return { checked: ids.length, failures };
}

export const JOBS = {
  ledger: checkLedgers,
} as const;

export async function runIntegrityJobs(
  deps: IntegrityDeps,
  now: Date = new Date(),
): Promise<IntegrityReport> {
  const checks: IntegrityReport["checks"] = {};
  const failures: IntegrityFailure[] = [];
  for (const [name, job] of Object.entries(JOBS)) {
    const r = await job(deps);
    checks[name] = { checked: r.checked, failed: r.failures.length };
    failures.push(...r.failures);
  }
  return { ranAt: now.toISOString(), checks, failures, ok: failures.length === 0 };
}

/**
 * The endpoint's logic, separated from the route for testing: verify the
 * HMAC signature (`x-stellaris-signature: t=<unix>,v1=<hex>` over
 * `<t>.<body>`, 5-minute window, replay-protected), then run every job.
 * 200 = clean, 409 = drift found, 400/401/503 = refused before running.
 */
export async function handleIntegrityRequest(
  request: Request,
  opts: { secret: string | undefined; deps: () => Promise<IntegrityDeps> },
): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (!opts.secret) return json(503, { error: "Integrity jobs are not configured." });
  const rawBody = await request.text();
  if (rawBody.length > 1_000) return json(400, { error: "Body too large." });
  const { verifyHmacWebhook } = await import("./webhook-verify");
  try {
    await verifyHmacWebhook({
      signatureHeader: request.headers.get("x-stellaris-signature"),
      rawBody,
      secret: opts.secret,
      eventId: null,
    });
  } catch {
    return json(401, { error: "Signature verification failed." });
  }
  const report = await runIntegrityJobs(await opts.deps());
  if (!report.ok) {
    console.error(
      `[integrity] ${report.failures.length} failure(s)`,
      JSON.stringify(report.failures),
    );
  }
  return json(report.ok ? 200 : 409, report);
}
