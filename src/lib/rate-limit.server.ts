/**
 * Security Suite S3.2 — rate limits for server functions.
 *
 * Counts live in the database (`hit_rate_limit`, fixed windows), so the limit
 * holds across every server instance, not just one. Subjects are a user id
 * for signed-in calls or the client IP for public ones; the IP is hashed
 * before it is stored, so the table never holds a raw address.
 *
 * Failure policy: if the database cannot be reached the call is allowed and a
 * warning is logged (an outage must not lock everyone out). Call sites that
 * must fail closed pass { failClosed: true }.
 */

export interface RateRule {
  /** Short bucket name, e.g. "wallet-nonce". */
  readonly bucket: string;
  readonly max: number;
  readonly windowSeconds: number;
  readonly failClosed?: boolean;
}

export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(
      `Too many requests. Please wait ${
        retryAfterSeconds >= 120
          ? `${Math.ceil(retryAfterSeconds / 60)} minutes`
          : `${retryAfterSeconds} seconds`
      } and try again.`,
    );
    this.name = "RateLimited";
  }
}

export type HitFn = (key: string, windowSeconds: number, max: number) => Promise<boolean>;

async function hitWithSupabase(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (
    supabaseAdmin as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message?: string } | null }>;
    }
  ).rpc("hit_rate_limit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) throw new Error(error.message ?? "rate limit check failed");
  return data === true;
}

/** SHA-256 of the subject, hex, truncated: stable per subject, not reversible to an IP. */
export async function subjectHash(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`stellaris-rl:${subject}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Throws RateLimited when the subject is over the rule's limit. */
export async function enforceRateLimit(
  rule: RateRule,
  subject: string,
  hit: HitFn = hitWithSupabase,
): Promise<void> {
  const key = `${rule.bucket}:${await subjectHash(subject)}`;
  let allowed: boolean;
  try {
    allowed = await hit(key, rule.windowSeconds, rule.max);
  } catch (e) {
    console.warn(
      `[rate-limit] ${rule.bucket}: check unavailable (${e instanceof Error ? e.message : e})`,
    );
    if (rule.failClosed) throw new RateLimited(rule.windowSeconds);
    return;
  }
  if (!allowed) throw new RateLimited(rule.windowSeconds);
}

/** The calling client's IP inside a server function (Cloudflare header first). */
export async function clientIp(): Promise<string> {
  const { getRequestHeader, getRequestIP } = await import("@tanstack/react-start/server");
  return getRequestHeader("cf-connecting-ip") ?? getRequestIP({ xForwardedFor: true }) ?? "unknown";
}

/** Host of the current request, lower-case, without port. */
export async function requestDomain(): Promise<string> {
  const { getRequestHost } = await import("@tanstack/react-start/server");
  return (getRequestHost({ xForwardedHost: false }) ?? "unknown")
    .toLowerCase()
    .replace(/:\d+$/, "");
}

/** The limits used across the app, in one place so they can be reviewed together. */
export const RATE_RULES = {
  walletNonce: { bucket: "wallet-nonce", max: 10, windowSeconds: 600 },
  walletConfirm: { bucket: "wallet-confirm", max: 20, windowSeconds: 600 },
  fundingSubmit: { bucket: "funding-submit", max: 5, windowSeconds: 3_600 },
  fractionEvent: { bucket: "fraction-event", max: 30, windowSeconds: 600 },
  checkout: { bucket: "checkout", max: 10, windowSeconds: 600 },
  vaultTx: { bucket: "vault-tx", max: 60, windowSeconds: 600 },
  /** E13: one wallet transaction makes ~10–30 Blockfrost calls through the proxy. */
  blockfrostProxy: { bucket: "bf-proxy", max: 600, windowSeconds: 600 },
  /** E04: Meridian ledger reads and writes, per signed-in user. */
  ledgerRead: { bucket: "ledger-read", max: 120, windowSeconds: 600 },
  ledgerWrite: { bucket: "ledger-write", max: 30, windowSeconds: 600, failClosed: true },
} as const satisfies Record<string, RateRule>;
