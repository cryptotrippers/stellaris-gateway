import { createFileRoute } from "@tanstack/react-router";

/**
 * Sprint 2 E10 — nightly integrity checks (see src/lib/integrity-jobs.server.ts).
 *
 * Public path so the scheduler can reach it (CSRF-exempt like the other
 * /api/public webhooks); it is authenticated inside by an HMAC signature
 * with INTEGRITY_JOB_SECRET, and refuses everything unsigned, stale or
 * replayed before any check runs. It only reads.
 */
export const Route = createFileRoute("/api/public/jobs/integrity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleIntegrityRequest } = await import("@/lib/integrity-jobs.server");
        return handleIntegrityRequest(request, {
          secret: process.env.INTEGRITY_JOB_SECRET,
          deps: async () => {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { supabaseLedgerRepo } = await import("@/lib/ledger-store.server");
            return { ledger: supabaseLedgerRepo(supabaseAdmin as never) };
          },
        });
      },
    },
  },
});
