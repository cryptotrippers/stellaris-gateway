import { createFileRoute } from "@tanstack/react-router";

/**
 * Sprint 2 E13 — same-origin Blockfrost proxy for the browser's Lucid.
 *
 * The Blockfrost key stays on the server: the browser calls /api/bf/<path>,
 * this handler checks the request against the allow-list in
 * blockfrost-proxy.shared.ts (Lucid's endpoints only, Preprod only, size and
 * content-type limits), rate-limits per client and forwards it with the key.
 * POSTs are also covered by the same-origin CSRF guard in src/server.ts.
 */

async function handle(request: Request): Promise<Response> {
  const {
    BLOCKFROST_PROXY_PREFIX,
    PASSED_RESPONSE_HEADERS,
    MAX_EVALUATE_BYTES,
    checkProxyRequest,
    isCrossSiteBrowserRequest,
  } = await import("@/lib/blockfrost-proxy.shared");

  const deny = (status: number, reason: string) =>
    new Response(JSON.stringify({ error: reason }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });

  if (isCrossSiteBrowserRequest(request.headers)) {
    return deny(403, "The Blockfrost proxy only serves this site.");
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${BLOCKFROST_PROXY_PREFIX}/`)) return deny(404, "Not found.");
  const pathAndQuery = url.pathname.slice(BLOCKFROST_PROXY_PREFIX.length) + url.search;

  // Refuse an oversized body before reading it, then measure what arrived.
  let body: ArrayBuffer | undefined;
  let length: number | null = null;
  if (request.method === "POST") {
    const declared = Number(request.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_EVALUATE_BYTES) {
      return deny(413, "Request body too large.");
    }
    body = await request.arrayBuffer();
    length = body.byteLength;
  }

  const decision = checkProxyRequest({
    method: request.method,
    pathAndQuery,
    contentType: request.headers.get("content-type"),
    contentLength: length,
  });
  if (!decision.ok) return deny(decision.status, decision.reason);

  const { enforceRateLimit, RATE_RULES, RateLimited } = await import("@/lib/rate-limit.server");
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  try {
    await enforceRateLimit(RATE_RULES.blockfrostProxy, ip);
  } catch (e) {
    if (e instanceof RateLimited) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(e.retryAfterSeconds),
          "cache-control": "no-store",
        },
      });
    }
    throw e;
  }

  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) return deny(503, "Blockfrost is not configured on the server.");

  let upstream: Response;
  try {
    upstream = await fetch(decision.upstreamUrl, {
      method: request.method,
      headers: {
        project_id: key,
        ...(body ? { "content-type": decision.rule.contentType ?? "application/json" } : {}),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return deny(502, "Blockfrost could not be reached.");
  }

  const headers = new Headers({ "cache-control": "no-store" });
  for (const h of PASSED_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

export const Route = createFileRoute("/api/bf/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
