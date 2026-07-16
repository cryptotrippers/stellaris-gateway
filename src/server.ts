import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Security headers — applied to every response before it leaves the worker.
//
// Design choices:
//  - Baseline hardening headers (nosniff, frame deny, referrer, permissions,
//    HSTS on HTTPS, COOP) are enforced.
//  - CSP is emitted in Report-Only mode. The app talks to a mix of origins
//    (WalletConnect relay/verify, Blockfrost via our own /_serverFn proxy,
//    Stripe iframes, potential Lovable preview HMR). Report-Only lets us
//    surface violations without breaking the preview or checkout while we
//    tighten the allow-lists over time.
// -----------------------------------------------------------------------------

const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  // React inline styles + Tailwind runtime; SSR emits inline scripts for hydration.
  "script-src": ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:"],
  "connect-src": [
    "'self'",
    // WalletConnect / Reown
    "https://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.com",
    "wss://*.walletconnect.org",
    "https://*.reown.com",
    // Stripe
    "https://api.stripe.com",
    "https://m.stripe.network",
    // Blockfrost is only ever called server-side, but keep a safety net.
    "https://cardano-preprod.blockfrost.io",
  ],
  "frame-src": [
    "'self'",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://checkout.stripe.com",
  ],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "worker-src": ["'self'", "blob:"],
  "upgrade-insecure-requests": [],
};

const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
  .join("; ");

function applySecurityHeaders(request: Request, response: Response): Response {
  const isHttps = new URL(request.url).protocol === "https:";
  const headers = new Headers(response.headers);

  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };

  set("X-Content-Type-Options", "nosniff");
  set("X-Frame-Options", "DENY");
  set("Referrer-Policy", "strict-origin-when-cross-origin");
  set("X-DNS-Prefetch-Control", "off");
  set("Cross-Origin-Opener-Policy", "same-origin");
  set(
    "Permissions-Policy",
    [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      'payment=(self "https://js.stripe.com" "https://checkout.stripe.com")',
      "usb=()",
      "magnetometer=()",
      "accelerometer=()",
      "gyroscope=()",
      "interest-cohort=()",
    ].join(", "),
  );
  if (isHttps) {
    set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  set("Content-Security-Policy-Report-Only", CSP_HEADER);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return applySecurityHeaders(request, normalized);
    } catch (error) {
      console.error(error);
      return applySecurityHeaders(
        request,
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
