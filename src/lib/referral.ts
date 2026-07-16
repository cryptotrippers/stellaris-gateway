// Frontend-only referral system with anti-abuse guards. Codes + counts persist
// in localStorage; the same call sites (getMyCode, confirmReferral, etc.) can
// be swapped to a Cloud backend later without touching UI. All checks below
// are best-effort client-side — the same shape MUST be re-enforced server-side
// once persistence lands. Never trust these guards alone in production.
import { trackEvent } from "@/lib/analytics";

const CODE_KEY = "stellaris.referral.myCode";
const REFERRED_BY_KEY = "stellaris.referral.referredBy";
const INVITES_KEY = "stellaris.referral.invites"; // JSON: { count, lastAt, sends: number[] }
const CONFIRMED_KEY = "stellaris.referral.confirmed"; // JSON: { code, reason, at }
const DEVICE_ID_KEY = "stellaris.referral.deviceId";
const DEVICE_CLAIMED_KEY = "stellaris.referral.deviceClaimedCodes"; // JSON string[]
const REGEN_HISTORY_KEY = "stellaris.referral.regenHistory"; // JSON number[] (ms timestamps)
const AUDIT_LOG_KEY = "stellaris.referral.auditLog"; // JSON AuditEvent[]
const AUDIT_LOG_MAX = 100;


// Anti-abuse thresholds — mirror these server-side when Cloud is wired.
const MAX_REGEN_PER_HOUR = 5;
const MAX_INVITES_PER_HOUR = 30;
const MIN_MS_BETWEEN_INVITES = 800;
const CODE_REGEX = /^[A-Z0-9]{4,12}$/;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function randomCode(len = 7): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJSON<T>(s: Storage, key: string, fallback: T): T {
  try {
    const raw = s.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---- Audit log -------------------------------------------------------------
// Transparent, tamper-visible record of every referral-relevant event on this
// device. Purely client-side (localStorage), capped at AUDIT_LOG_MAX entries.
// When Cloud lands, mirror the same shape server-side; the UI stays identical.
export type AuditEventType =
  | "capture_ok"
  | "capture_blocked"
  | "confirm_ok"
  | "confirm_blocked"
  | "regenerate_ok"
  | "regenerate_blocked"
  | "invite_sent"
  | "invite_blocked";

export type AuditOutcome = "ok" | "blocked";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  outcome: AuditOutcome;
  at: number;
  code?: string;
  channel?: string;
  reason?: string;
}

function appendAudit(ev: Omit<AuditEvent, "id" | "at"> & { at?: number }): void {
  const s = safeStorage();
  if (!s) return;
  try {
    const list = readJSON<AuditEvent[]>(s, AUDIT_LOG_KEY, []);
    const entry: AuditEvent = {
      id: Array.from(randomBytes(6), b => b.toString(16).padStart(2, "0")).join(""),
      at: ev.at ?? Date.now(),
      type: ev.type,
      outcome: ev.outcome,
      code: ev.code,
      channel: ev.channel,
      reason: ev.reason,
    };
    const next = [entry, ...list].slice(0, AUDIT_LOG_MAX);
    s.setItem(AUDIT_LOG_KEY, JSON.stringify(next));
  } catch { /* swallow — audit must never break UX */ }
}

export function getAuditLog(): AuditEvent[] {
  const s = safeStorage();
  if (!s) return [];
  return readJSON<AuditEvent[]>(s, AUDIT_LOG_KEY, []);
}

export function clearAuditLog(): void {
  const s = safeStorage();
  if (!s) return;
  s.removeItem(AUDIT_LOG_KEY);
}


/** Stable per-browser device ID. Not a fingerprint — just a local pseudonym
 *  used to spot the same device claiming multiple invite codes. Trivially
 *  bypassed by clearing storage; re-enforce server-side. */
export function getDeviceId(): string {
  const s = safeStorage();
  if (!s) return "anon";
  let id = s.getItem(DEVICE_ID_KEY);
  if (!id) {
    const bytes = randomBytes(16);
    id = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    s.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getMyCode(): string {
  const s = safeStorage();
  if (!s) return "STELLAR";
  let code = s.getItem(CODE_KEY);
  if (!code) {
    code = randomCode(7);
    s.setItem(CODE_KEY, code);
  }
  return code;
}

export type RegenerateResult =
  | { ok: true; code: string }
  | { ok: false; reason: "rate_limited"; retryAfterMs: number };

export function regenerateMyCode(): RegenerateResult {
  const s = safeStorage();
  if (!s) return { ok: true, code: randomCode(7) };

  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const history = readJSON<number[]>(s, REGEN_HISTORY_KEY, []).filter(t => t > hourAgo);

  if (history.length >= MAX_REGEN_PER_HOUR) {
    const retryAfterMs = Math.max(0, history[0] + 60 * 60 * 1000 - now);
    trackEvent("referral_regenerate_blocked", { reason: "rate_limited" });
    appendAudit({ type: "regenerate_blocked", outcome: "blocked", reason: "rate_limited" });
    return { ok: false, reason: "rate_limited", retryAfterMs };
  }

  const code = randomCode(7);
  s.setItem(CODE_KEY, code);
  s.setItem(REGEN_HISTORY_KEY, JSON.stringify([...history, now]));
  trackEvent("referral_code_regenerated");
  appendAudit({ type: "regenerate_ok", outcome: "ok", code });
  return { ok: true, code };
}

export function getReferredBy(): string | null {
  const s = safeStorage();
  return s?.getItem(REFERRED_BY_KEY) ?? null;
}

export type CaptureReason =
  | "invalid"
  | "self_invite"
  | "already_referred"
  | "already_confirmed"
  | "device_already_claimed";

export type CaptureResult =
  | { ok: true; code: string; alreadyStored?: boolean }
  | { ok: false; reason: CaptureReason; attempted?: string };

/** Call on every page load to snag ?ref=XXX from the URL. Returns a
 *  discriminated result so callers can surface the specific abuse reason. */
export function captureReferralFromUrl(): CaptureResult | null {
  if (typeof window === "undefined") return null;
  let clean: string;
  try {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get("ref");
    if (!ref) return null;
    clean = ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  } catch {
    return null;
  }
  if (!CODE_REGEX.test(clean)) {
    trackEvent("referral_capture_blocked", { reason: "invalid" });
    appendAudit({ type: "capture_blocked", outcome: "blocked", reason: "invalid", code: clean });
    return { ok: false, reason: "invalid", attempted: clean };
  }

  const s = safeStorage();
  if (!s) return { ok: true, code: clean };

  const mine = s.getItem(CODE_KEY);
  if (mine && clean === mine) {
    trackEvent("referral_capture_blocked", { reason: "self_invite" });
    appendAudit({ type: "capture_blocked", outcome: "blocked", reason: "self_invite", code: clean });
    return { ok: false, reason: "self_invite", attempted: clean };
  }

  // If this device has already confirmed an invite (or claimed a different
  // code before), reject additional claims — one referral per device.
  const claimed = readJSON<string[]>(s, DEVICE_CLAIMED_KEY, []);
  if (claimed.length > 0 && !claimed.includes(clean)) {
    trackEvent("referral_capture_blocked", { reason: "device_already_claimed" });
    appendAudit({ type: "capture_blocked", outcome: "blocked", reason: "device_already_claimed", code: clean });
    return { ok: false, reason: "device_already_claimed", attempted: clean };
  }

  const existing = s.getItem(REFERRED_BY_KEY);
  if (existing && existing !== clean) {
    trackEvent("referral_capture_blocked", { reason: "already_referred" });
    appendAudit({ type: "capture_blocked", outcome: "blocked", reason: "already_referred", code: clean });
    return { ok: false, reason: "already_referred", attempted: clean };
  }

  if (getReferralConfirmation()) {
    appendAudit({ type: "capture_blocked", outcome: "blocked", reason: "already_confirmed", code: clean });
    return { ok: false, reason: "already_confirmed", attempted: clean };
  }

  if (!existing) {
    s.setItem(REFERRED_BY_KEY, clean);
    trackEvent("referral_captured", { code: clean });
    appendAudit({ type: "capture_ok", outcome: "ok", code: clean });
    return { ok: true, code: clean };
  }
  return { ok: true, code: clean, alreadyStored: true };
}

export interface InviteStats {
  count: number;
  lastAt: number | null;
}

interface InviteRecord {
  count: number;
  lastAt: number | null;
  sends: number[]; // recent send timestamps for rate-limit window
}

function readInviteRecord(s: Storage): InviteRecord {
  const raw = readJSON<Partial<InviteRecord>>(s, INVITES_KEY, {});
  return {
    count: Number(raw.count) || 0,
    lastAt: raw.lastAt ?? null,
    sends: Array.isArray(raw.sends) ? raw.sends.filter(n => typeof n === "number") : [],
  };
}

export function getInviteStats(): InviteStats {
  const s = safeStorage();
  if (!s) return { count: 0, lastAt: null };
  const r = readInviteRecord(s);
  return { count: r.count, lastAt: r.lastAt };
}

export type InviteSendResult =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "too_fast"; retryAfterMs: number };

/** Local-only invite counter — increments when the user clicks a share action.
 *  Enforces a burst cap (min gap between clicks) + hourly cap to blunt farming. */
export function bumpInviteSent(channel: string): InviteSendResult {
  const s = safeStorage();
  if (!s) return { ok: true };

  const now = Date.now();
  const rec = readInviteRecord(s);
  const hourAgo = now - 60 * 60 * 1000;
  const recentSends = rec.sends.filter(t => t > hourAgo);

  if (rec.lastAt && now - rec.lastAt < MIN_MS_BETWEEN_INVITES) {
    trackEvent("referral_invite_blocked", { channel, reason: "too_fast" });
    return { ok: false, reason: "too_fast", retryAfterMs: MIN_MS_BETWEEN_INVITES - (now - rec.lastAt) };
  }

  if (recentSends.length >= MAX_INVITES_PER_HOUR) {
    const retryAfterMs = Math.max(0, recentSends[0] + 60 * 60 * 1000 - now);
    trackEvent("referral_invite_blocked", { channel, reason: "rate_limited" });
    return { ok: false, reason: "rate_limited", retryAfterMs };
  }

  const next: InviteRecord = {
    count: rec.count + 1,
    lastAt: now,
    sends: [...recentSends, now],
  };
  s.setItem(INVITES_KEY, JSON.stringify(next));
  trackEvent("referral_invite_sent", { channel });
  return { ok: true };
}

export function buildInviteUrl(code: string, path = "/"): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://stellaris-gateway.lovable.app";
  return `${origin}${path}?ref=${encodeURIComponent(code)}`;
}

// ---- Attribution / confirmation --------------------------------------------
// A referral is *captured* the moment a visitor lands with ?ref=CODE, but that
// alone is cheap to fake. We only *confirm* (and count as a completed invite)
// after a real conversion signal: signup or first wallet connect. Once
// confirmed, the record is immutable so later disconnect/re-connect doesn't
// double-count.

export type ReferralConfirmReason = "signup" | "wallet_connect" | "first_investment";

export interface ReferralConfirmation {
  code: string;
  reason: ReferralConfirmReason;
  at: number;
}

export type ConfirmResult =
  | { ok: true; confirmation: ReferralConfirmation; alreadyConfirmed?: boolean }
  | { ok: false; reason: "no_referrer" | "self_invite" | "device_already_claimed" };

export function getReferralConfirmation(): ReferralConfirmation | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(CONFIRMED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.code || !parsed?.reason) return null;
    return { code: String(parsed.code), reason: parsed.reason, at: Number(parsed.at) || Date.now() };
  } catch {
    return null;
  }
}

export function isReferralConfirmed(): boolean {
  return getReferralConfirmation() !== null;
}

/**
 * Confirm the captured referral after a real conversion event (signup, first
 * wallet connect, first investment). Enforces: no self-invites, one claim per
 * device (based on device history), immutable once written. Returns a
 * discriminated result so UI can surface the specific failure.
 */
export function confirmReferral(reason: ReferralConfirmReason): ConfirmResult {
  const s = safeStorage();
  if (!s) return { ok: false, reason: "no_referrer" };

  const existing = getReferralConfirmation();
  if (existing) return { ok: true, confirmation: existing, alreadyConfirmed: true };

  const referredBy = s.getItem(REFERRED_BY_KEY);
  if (!referredBy) return { ok: false, reason: "no_referrer" };

  const mine = s.getItem(CODE_KEY);
  if (mine && referredBy === mine) {
    trackEvent("referral_confirm_blocked", { reason: "self_invite" });
    return { ok: false, reason: "self_invite" };
  }

  const claimed = readJSON<string[]>(s, DEVICE_CLAIMED_KEY, []);
  if (claimed.length > 0 && !claimed.includes(referredBy)) {
    trackEvent("referral_confirm_blocked", { reason: "device_already_claimed" });
    return { ok: false, reason: "device_already_claimed" };
  }

  const record: ReferralConfirmation = { code: referredBy, reason, at: Date.now() };
  s.setItem(CONFIRMED_KEY, JSON.stringify(record));
  s.setItem(DEVICE_CLAIMED_KEY, JSON.stringify([...new Set([...claimed, referredBy])]));
  trackEvent("referral_confirmed", { code: referredBy, reason, deviceId: getDeviceId() });
  return { ok: true, confirmation: record };
}

/** Human-readable error messages for surfacing in the UI. */
export const REFERRAL_ERROR_COPY: Record<CaptureReason | "rate_limited" | "too_fast" | "no_referrer", string> = {
  invalid: "That invite code doesn't look right. Ask your friend to resend the link.",
  self_invite: "You can't invite yourself — nice try. Share your code with a friend instead.",
  already_referred: "You've already been invited by someone else. Only the first invite counts.",
  already_confirmed: "Your invite reward is already locked in. Rewards can't be re-claimed.",
  device_already_claimed: "This device already claimed a referral. One invite per device.",
  rate_limited: "You're going a bit fast. Try again in a few minutes.",
  too_fast: "Slow down — wait a moment before sharing again.",
  no_referrer: "No invite code was captured for this session.",
};
