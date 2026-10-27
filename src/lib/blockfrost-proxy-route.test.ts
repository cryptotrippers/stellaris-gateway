// Sprint 2 E13 — the /api/bf route end to end, with Blockfrost mocked:
// the key is added server-side, refused requests never leave the server, and
// nothing but the body and content type comes back.
import test from "node:test";
import assert from "node:assert/strict";

const KEY = "preprodTESTKEYdoNotUse0000000000";
process.env.BLOCKFROST_PREPROD_PROJECT_ID = KEY;
const { Route } = await import("../routes/api/bf/$");

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handlers = (Route.options as unknown as { server: { handlers: Record<string, Handler> } })
  .server.handlers;

const calls: Array<{ url: string; init: RequestInit }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify([{ ok: true }]), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "upstream=1",
      "x-ratelimit-remaining": "9",
    },
  });
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const TX = "c".repeat(64);
const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://stellaris.example/api/bf${path}`, {
    ...init,
    headers: { "sec-fetch-site": "same-origin", ...(init.headers as Record<string, string>) },
  });

test("E13 route: an allowed GET is forwarded to Preprod with the server's key", async () => {
  calls.length = 0;
  const res = await handlers.GET!({
    request: req(`/txs/${TX}/utxos`, { headers: { project_id: "proxied" } }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://cardano-preprod.blockfrost.io/api/v0/txs/${TX}/utxos`);
  assert.equal((calls[0]!.init.headers as Record<string, string>).project_id, KEY);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-ratelimit-remaining"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  assert.ok(!text.includes(KEY));
});

test("E13 route: a submit is forwarded as CBOR with its exact bytes", async () => {
  calls.length = 0;
  const bytes = new Uint8Array([0x84, 0xa4, 0x00, 0x81]);
  const res = await handlers.POST!({
    request: req("/tx/submit", {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/cbor" },
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(new Uint8Array(calls[0]!.init.body as ArrayBuffer), bytes);
});

test("E13 route: refused requests never reach Blockfrost", async () => {
  calls.length = 0;
  const cases: Array<[Request, number, "GET" | "POST"]> = [
    [req("/ipfs/add"), 404, "GET"],
    [req(`/txs/${TX}/utxos`, { headers: { "sec-fetch-site": "cross-site" } }), 403, "GET"],
    [
      req("/tx/submit", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      415,
      "POST",
    ],
    [
      req("/tx/submit", {
        method: "POST",
        body: new Uint8Array(20_000),
        headers: { "content-type": "application/cbor" },
      }),
      413,
      "POST",
    ],
  ];
  for (const [r, status, m] of cases) {
    const res = await handlers[m]!({ request: r });
    assert.equal(res.status, status, r.url);
  }
  assert.equal(calls.length, 0);
});

test("E13 route: without a configured key the proxy answers 503", async () => {
  delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  try {
    const res = await handlers.GET!({ request: req("/epochs/latest/parameters") });
    assert.equal(res.status, 503);
  } finally {
    process.env.BLOCKFROST_PREPROD_PROJECT_ID = KEY;
  }
});
