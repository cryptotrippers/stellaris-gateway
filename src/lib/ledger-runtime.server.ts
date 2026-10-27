/**
 * Sprint 2 E04 — per-call setup for the ledger server functions: the caller's
 * roles (looked up server-side, never trusted from the client), the rate
 * limit, and a ledger repo over the service role.
 */
import { enforceRateLimit, RATE_RULES } from "./rate-limit.server";
import { supabaseLedgerRepo, type LedgerRepo } from "./ledger-store.server";
import type { LedgerActor, LedgerRole } from "./ledger-service.server";

type RpcClient = {
  rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function ledgerCall(
  context: { supabase: RpcClient; userId: string },
  limit: "ledgerRead" | "ledgerWrite",
): Promise<{ actor: LedgerActor; repo: LedgerRepo }> {
  await enforceRateLimit(RATE_RULES[limit], context.userId);
  const roles: LedgerRole[] = [];
  for (const role of ["admin", "operator"] as const) {
    const { data, error } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: role,
    });
    if (error) throw new Error(error.message);
    if (data === true) roles.push(role);
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    actor: { userId: context.userId, roles },
    repo: supabaseLedgerRepo(supabaseAdmin as never),
  };
}
