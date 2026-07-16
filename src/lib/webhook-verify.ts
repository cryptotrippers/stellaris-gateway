/**
 * Shared HMAC-SHA256 webhook verification with replay protection.
 *
 * Supports the Stripe / Blockfrost / GitHub-style header format:
 *   `t=<unix-seconds>,v1=<hex hmac>[,v1=<hex hmac>...]`
 * The signed payload is always `<timestamp>.<raw-body>`.
 *
 * Defenses:
 *  1. Constant-time signature comparison across every provided `v1` value
 *     (multiple during secret rotation).
 *  2. Timestamp freshness — reject events outside ±5 minutes of `Date.now()`.
 *  3. In-memory replay cache — reject any event whose stable ID we've seen
 *     within the freshness window. Cache is per-worker isolate, which is
 *     sufficient given the freshness check is the primary defense.
 */

const FRESHNESS_WINDOW_S = 300; // 5 minutes, matches Stripe's tolerance.
const REPLAY_TTL_MS = FRESHNESS_WINDOW_S * 1000;
const REPLAY_MAX_ENTRIES = 5000;

const seenEventIds = new Map<string, number>();

function rememberEventId(id: string): boolean {
  const now = Date.now();
  // Sweep expired entries opportunistically.
  if (seenEventIds.size > REPLAY_MAX_ENTRIES) {
    for (const [k, ts] of seenEventIds) {
      if (now - ts > REPLAY_TTL_MS) seenEventIds.delete(k);
      if (seenEventIds.size <= REPLAY_MAX_ENTRIES / 2) break;
    }
  }
  const existing = seenEventIds.get(id);
  if (existing !== undefined && now - existing < REPLAY_TTL_MS) return false;
  seenEventIds.set(id, now);
  return true;
}

function parseSigHeader(header: string): { timestamp: number | null; v1: string[] } {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    if (key.trim() === "t") {
      const n = Number(value.trim());
      if (Number.isFinite(n)) timestamp = n;
    } else if (key.trim() === "v1") {
      v1.push(value.trim());
    }
  }
  return { timestamp, v1 };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class WebhookVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: "missing" | "malformed" | "stale" | "signature" | "replay",
  ) {
    super(message);
  }
}

export interface VerifyOptions {
  signatureHeader: string | null;
  rawBody: string;
  secret: string;
  /** Stable event identifier used for replay detection (e.g. Stripe `evt_…`). */
  eventId: string | null;
  /** Override freshness window (seconds). Defaults to 300s. */
  toleranceSeconds?: number;
}

/**
 * Verify an HMAC-SHA256 webhook signature and reject stale / replayed events.
 * Throws `WebhookVerificationError` on any failure.
 */
export async function verifyHmacWebhook(opts: VerifyOptions): Promise<void> {
  const { signatureHeader, rawBody, secret, eventId } = opts;
  const tolerance = opts.toleranceSeconds ?? FRESHNESS_WINDOW_S;

  if (!signatureHeader) throw new WebhookVerificationError("Missing signature header", "missing");
  if (!rawBody) throw new WebhookVerificationError("Empty request body", "malformed");
  if (!secret) throw new WebhookVerificationError("Verifier misconfigured: empty secret", "missing");

  const { timestamp, v1 } = parseSigHeader(signatureHeader);
  if (timestamp === null || v1.length === 0) {
    throw new WebhookVerificationError("Malformed signature header", "malformed");
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      `Signature timestamp outside tolerance (${nowS - timestamp}s)`,
      "stale",
    );
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  const match = v1.some((candidate) => timingSafeEqualHex(candidate, expected));
  if (!match) throw new WebhookVerificationError("Signature mismatch", "signature");

  // Replay protection — key off provider event id when available, else the
  // (timestamp, signature) pair which is unique within the freshness window.
  const replayKey = eventId ?? `${timestamp}.${v1[0]}`;
  if (!rememberEventId(replayKey)) {
    throw new WebhookVerificationError(`Replay detected for ${replayKey}`, "replay");
  }
}
