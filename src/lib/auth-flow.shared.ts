export const AUTH_FALLBACK = "/app";

/** A return path is navigation, never a credential or an external URL. */
export function safeAuthReturn(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) return AUTH_FALLBACK;
  let decoded = value;
  try {
    for (let i = 0; i < 5; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return AUTH_FALLBACK;
  }
  const controlCharacter = Array.from(decoded).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\s]/.test(decoded) || controlCharacter) {
    return AUTH_FALLBACK;
  }
  const url = new URL(decoded, "https://internal.invalid");
  if (
    url.origin !== "https://internal.invalid" ||
    /^\/(auth(?:\/|$)|forgot-password(?:\/|$)|reset-password(?:\/|$)|~oauth(?:\/|$))/.test(
      url.pathname,
    )
  ) {
    return AUTH_FALLBACK;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function hasAuthReturn(search: string, hash: string): boolean {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  return ["code", "error", "error_code", "access_token", "token_hash"].some(
    (key) => query.has(key) || fragment.has(key),
  );
}

export function isRecoveryReturn(search: string, hash: string): boolean {
  return (
    new URLSearchParams(search).get("type") === "recovery" ||
    new URLSearchParams(hash.replace(/^#/, "")).get("type") === "recovery"
  );
}

export function authErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  if (/invalid login|invalid credentials/i.test(message))
    return "Email or password not recognised. Try again or reset your password.";
  if (/email not confirmed/i.test(message))
    return "Confirm your email before signing in. You can request a new confirmation link below.";
  if (/expired|otp|invalid.*token|flow_state|code verifier/i.test(message))
    return "This link has expired or has already been used. Request a new link.";
  if (/rate|too many/i.test(message))
    return "Too many attempts. Please wait a little before trying again.";
  if (/fetch|network|timeout/i.test(message))
    return "The connection took too long. Check your connection and try again.";
  return message;
}

export function withTimeout<T>(task: Promise<T>, ms = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Connection timeout. Please try again.")), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Initial reads must not overwrite a newer sign-in/sign-out event. */
export function isCurrentAuthRead(startedAt: number, current: number): boolean {
  return startedAt === current;
}
