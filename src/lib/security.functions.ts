import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SecurityEventInput = {
  action: string;
  detail?: Record<string, unknown>;
};

/**
 * Log a security event to security_audit_log for the current user.
 * Use for: new device login, transaction signed, MFA challenge, whitelist edits, etc.
 * Settings-toggle events are logged automatically by a DB trigger — do not double-log those.
 */
export const logSecurityEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SecurityEventInput) => {
    if (!input || typeof input.action !== "string" || input.action.length === 0) {
      throw new Error("action is required");
    }
    return {
      action: input.action.slice(0, 128),
      detail: input.detail ?? null,
    };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("security_audit_log").insert({
      user_id: userId,
      action: data.action,
      detail: data.detail as never,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
