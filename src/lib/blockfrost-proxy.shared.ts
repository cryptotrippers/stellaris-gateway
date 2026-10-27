/**
 * Sprint 2 E13 — Blockfrost proxy policy.
 *
 * The browser's Lucid instance used to receive the Blockfrost project key from
 * `getBlockfrostClientConfig()`, so every visitor could read it and spend our
 * quota (or worse, use it for anything Blockfrost allows). Lucid now talks to
 * `/api/bf/*` on our own origin; the server adds the key and forwards only
 * the requests Lucid Evolution's Blockfrost provider actually makes, to
 * Preprod only.
 *
 * This module is the allow-list: pure, shared, unit-tested. The route
 * (`src/routes/api/bf/$.ts`) applies it, rate-limits per client and forwards.
 * Endpoints mirror @lucid-evolution/provider's `Blockfrost` class; a test reads
 * the installed provider and fails if it starts calling something not listed.
 */

/** Where the browser's Lucid points. */
export const BLOCKFROST_PROXY_PREFIX = "/api/bf";

/** Preprod only — never configurable from the request. */
export const BLOCKFROST_UPSTREAM = "https://cardano-preprod.blockfrost.io/api/v0";

/** Placeholder project id the browser sends; the proxy ignores it. */
export const BLOCKFROST_PROXY_PROJECT_ID = "proxied";

/** Largest transaction Cardano accepts, in bytes. */
export const MAX_TX_BYTES = 16_384;
/** Evaluation requests carry the tx plus extra UTxOs as JSON. */
export const MAX_EVALUATE_BYTES = 131_072;

const B32 = "[02-9ac-hj-np-z]"; // bech32 data charset
const HEX = "[0-9a-f]";

/**
 * Address predicates Lucid sends: a testnet address, or a bare payment/script
 * credential. Mainnet addresses (`addr1…`) are refused outright.
 */
const ADDRESS = `(?:addr_test1${B32}{20,200}|addr_vkh1${B32}{40,70}|script1${B32}{40,70})`;
const UNIT = `(?:lovelace|${HEX}{56}(?:${HEX}{2}){0,32})`;
const TX_HASH = `${HEX}{64}`;
const SCRIPT_HASH = `${HEX}{56}`;
const STAKE = `stake_test1${B32}{40,70}`;

interface Rule {
  method: "GET" | "POST";
  path: RegExp;
  /** Query keys allowed for this endpoint. */
  query?: readonly string[];
  contentType?: string;
  maxBytes?: number;
}

const re = (s: string) => new RegExp(`^${s}$`);

export const PROXY_RULES: readonly Rule[] = [
  { method: "GET", path: re("/epochs/latest/parameters") },
  { method: "GET", path: re("/network") },
  { method: "GET", path: re(`/addresses/${ADDRESS}/utxos`), query: ["page", "count"] },
  { method: "GET", path: re(`/addresses/${ADDRESS}/utxos/${UNIT}`), query: ["page", "count"] },
  { method: "GET", path: re(`/assets/${UNIT}/addresses`), query: ["count"] },
  { method: "GET", path: re(`/txs/${TX_HASH}/utxos`) },
  { method: "GET", path: re(`/txs/${TX_HASH}/cbor`) },
  { method: "GET", path: re(`/accounts/${STAKE}`) },
  { method: "GET", path: re(`/scripts/${SCRIPT_HASH}`) },
  { method: "GET", path: re(`/scripts/${SCRIPT_HASH}/cbor`) },
  { method: "GET", path: re(`/scripts/${SCRIPT_HASH}/json`) },
  { method: "GET", path: re(`/scripts/datum/${TX_HASH}/cbor`) },
  {
    method: "POST",
    path: re("/tx/submit"),
    contentType: "application/cbor",
    maxBytes: MAX_TX_BYTES,
  },
  {
    method: "POST",
    path: re("/utils/txs/evaluate/utxos"),
    contentType: "application/json",
    maxBytes: MAX_EVALUATE_BYTES,
  },
];

export type ProxyDecision =
  | { ok: true; upstreamUrl: string; rule: Rule }
  | { ok: false; status: 400 | 403 | 404 | 405 | 411 | 413 | 415; reason: string };

const QUERY_VALUE = /^[0-9]{1,4}$/;

/**
 * Decide whether a proxied request may go to Blockfrost.
 * `pathAndQuery` is everything after `/api/bf`, e.g. `/txs/<hash>/utxos`.
 * `contentLength` is the declared or measured body size for POSTs.
 */
export function checkProxyRequest(input: {
  method: string;
  pathAndQuery: string;
  contentType?: string | null;
  contentLength?: number | null;
}): ProxyDecision {
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return { ok: false, status: 405, reason: "Only GET and POST are proxied." };
  }
  const raw = input.pathAndQuery;
  if (raw.length > 600 || /[%\\\s]|\.\.|\/\//.test(raw)) {
    return { ok: false, status: 400, reason: "Malformed path." };
  }
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);

  const rule = PROXY_RULES.find((r) => r.path.test(path));
  if (!rule) return { ok: false, status: 404, reason: "Endpoint not allowed through the proxy." };
  if (rule.method !== method) {
    return { ok: false, status: 405, reason: `${path} only accepts ${rule.method}.` };
  }

  const params = new URLSearchParams(query);
  const kept = new URLSearchParams();
  for (const [k, v] of params) {
    if (!rule.query?.includes(k) || !QUERY_VALUE.test(v) || kept.has(k)) {
      return { ok: false, status: 400, reason: `Query parameter "${k}" is not allowed.` };
    }
    kept.set(k, v);
  }

  if (method === "POST") {
    const ct = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== rule.contentType) {
      return { ok: false, status: 415, reason: `${path} needs ${rule.contentType}.` };
    }
    if (input.contentLength === null || input.contentLength === undefined) {
      return { ok: false, status: 411, reason: "A request body size is required." };
    }
    if (input.contentLength <= 0 || input.contentLength > (rule.maxBytes ?? 0)) {
      return { ok: false, status: 413, reason: `Body must be 1–${rule.maxBytes} bytes.` };
    }
  }

  const qs = kept.toString();
  return { ok: true, upstreamUrl: `${BLOCKFROST_UPSTREAM}${path}${qs ? `?${qs}` : ""}`, rule };
}

/**
 * True for a browser request made by another site (Sec-Fetch-Site set and not
 * same-origin). Keeps other sites from using the proxy as free Blockfrost
 * access through visitors' browsers; non-browser clients are covered by the
 * rate limit.
 */
export function isCrossSiteBrowserRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/** Upstream response headers passed back to the browser; everything else is dropped. */
export const PASSED_RESPONSE_HEADERS = ["content-type"] as const;
