// Frontend-only referral system. Codes + counts persist in localStorage; the
// same call sites (getMyCode, trackVisit, etc.) can be swapped to a Cloud
// backend later without touching UI.
import { trackEvent } from "@/lib/analytics";

const CODE_KEY = "stellaris.referral.myCode";
const REFERRED_BY_KEY = "stellaris.referral.referredBy";
const INVITES_KEY = "stellaris.referral.invites"; // JSON: { count, lastAt }
const CONFIRMED_KEY = "stellaris.referral.confirmed"; // JSON: { code, reason, at }

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

function randomCode(len = 7): string {
  // Prefer crypto for uniqueness; fall back to Math.random.
  const bytes = new Uint8Array(len);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
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

export function regenerateMyCode(): string {
  const s = safeStorage();
  const code = randomCode(7);
  if (s) s.setItem(CODE_KEY, code);
  trackEvent("referral_code_regenerated");
  return code;
}

export function getReferredBy(): string | null {
  const s = safeStorage();
  return s?.getItem(REFERRED_BY_KEY) ?? null;
}

/** Call on every page load to snag ?ref=XXX from the URL and remember it. */
export function captureReferralFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get("ref");
    if (!ref) return null;
    const clean = ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!clean) return null;
    const s = safeStorage();
    const mine = s?.getItem(CODE_KEY);
    if (mine && clean === mine) return null; // ignore self-invites
    if (s && !s.getItem(REFERRED_BY_KEY)) {
      s.setItem(REFERRED_BY_KEY, clean);
      trackEvent("referral_captured", { code: clean });
    }
    return clean;
  } catch {
    return null;
  }
}

export interface InviteStats {
  count: number;
  lastAt: number | null;
}

export function getInviteStats(): InviteStats {
  const s = safeStorage();
  if (!s) return { count: 0, lastAt: null };
  try {
    const raw = s.getItem(INVITES_KEY);
    if (!raw) return { count: 0, lastAt: null };
    const parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, lastAt: parsed.lastAt ?? null };
  } catch {
    return { count: 0, lastAt: null };
  }
}

/** Local-only invite counter — increments when the user clicks a share action. */
export function bumpInviteSent(channel: string) {
  const s = safeStorage();
  if (!s) return;
  const cur = getInviteStats();
  const next = { count: cur.count + 1, lastAt: Date.now() };
  s.setItem(INVITES_KEY, JSON.stringify(next));
  trackEvent("referral_invite_sent", { channel });
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
 * wallet connect, first investment). No-op when there's no captured referrer,
 * when the referrer is the user's own code, or when already confirmed.
 * Returns the confirmation record (existing or newly written), or null when
 * nothing to confirm.
 */
export function confirmReferral(reason: ReferralConfirmReason): ReferralConfirmation | null {
  const s = safeStorage();
  if (!s) return null;

  const existing = getReferralConfirmation();
  if (existing) return existing; // immutable once set

  const referredBy = s.getItem(REFERRED_BY_KEY);
  if (!referredBy) return null;

  const mine = s.getItem(CODE_KEY);
  if (mine && referredBy === mine) return null; // self-invite guard

  const record: ReferralConfirmation = { code: referredBy, reason, at: Date.now() };
  s.setItem(CONFIRMED_KEY, JSON.stringify(record));
  trackEvent("referral_confirmed", { code: referredBy, reason });
  return record;
}

