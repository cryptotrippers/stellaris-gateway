/**
 * Recovery for stale preview bundles: when the app redeploys while a tab is
 * open, the old bundle's hashed chunks disappear and dynamic imports fail
 * ("Failed to fetch dynamically imported module"). The only fix is a full
 * reload to fetch the new index. Reloading is rate-limited so a genuinely
 * broken deploy cannot loop the tab forever.
 */

const RELOAD_KEY = "stellaris:last-chunk-reload";
const MIN_RELOAD_INTERVAL_MS = 60_000;

const CHUNK_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module", // Chrome/Edge
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
  "Loading chunk",
  "Loading CSS chunk",
];

export function isStaleChunkError(message: string): boolean {
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

export function shouldReloadForStaleChunk(now: number, lastReload: number | null): boolean {
  return lastReload === null || now - lastReload > MIN_RELOAD_INTERVAL_MS;
}

export interface ReloadEnv {
  now(): number;
  readLast(): number | null;
  writeLast(timestamp: number): void;
  reload(): void;
}

/** Returns true when a reload was triggered. */
export function recoverFromStaleChunk(message: string, env: ReloadEnv): boolean {
  if (!isStaleChunkError(message)) return false;
  const now = env.now();
  if (!shouldReloadForStaleChunk(now, env.readLast())) return false;
  env.writeLast(now);
  env.reload();
  return true;
}

function browserEnv(): ReloadEnv | null {
  if (typeof window === "undefined") return null;
  return {
    now: () => Date.now(),
    readLast: () => {
      const raw = window.sessionStorage.getItem(RELOAD_KEY);
      const parsed = raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },
    writeLast: (timestamp) => window.sessionStorage.setItem(RELOAD_KEY, String(timestamp)),
    reload: () => window.location.reload(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** Browser entry point: reload once per minute at most if this is a stale-chunk error. */
export function recoverFromStaleChunkBrowser(error: unknown): boolean {
  const env = browserEnv();
  return env ? recoverFromStaleChunk(errorMessage(error), env) : false;
}

/** Installs global listeners; returns a cleanup function. Browser-only. */
export function installStaleChunkReload(): () => void {
  if (typeof window === "undefined") return () => {};
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recoverFromStaleChunkBrowser(event.reason);
  };
  const onError = (event: ErrorEvent) => {
    recoverFromStaleChunkBrowser(event.error ?? event.message);
  };
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("error", onError);
  return () => {
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("error", onError);
  };
}
