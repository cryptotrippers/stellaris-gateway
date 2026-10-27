// Sprint 2 E13 — Blockfrost proxy: allow-list, Preprod-only upstream, size
// limits, and proof that the project key no longer reaches the browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKFROST_UPSTREAM,
  MAX_EVALUATE_BYTES,
  MAX_TX_BYTES,
  checkProxyRequest,
  isCrossSiteBrowserRequest,
} from "./blockfrost-proxy.shared";

const ADDR =
  "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp";
const VKH = "addr_vkh1" + "q".repeat(50);
const SCRIPT_ADDR = "script1" + "q".repeat(50);
const STAKE = "stake_test1" + "u".repeat(53);
const TX = "a".repeat(64);
const SH = "b".repeat(56);
const UNIT = SH + "7374617465";

const get = (p: string) => checkProxyRequest({ method: "GET", pathAndQuery: p });

test("E13: every endpoint the installed Lucid Blockfrost provider calls is allowed", () => {
  const src = readFileSync("node_modules/@lucid-evolution/provider/dist/index.js", "utf8");
  const start = src.indexOf("var Blockfrost = class");
  assert.ok(start > 0, "Blockfrost provider class not found");
  const seg = src.slice(start, src.indexOf("= class", start + 30));
  const templates = [...new Set([...seg.matchAll(/`\$\{this\.url\}([^`]*)`/g)].map((m) => m[1]!))];
  assert.ok(templates.length >= 12, `found only ${templates.length} endpoints`);
  const sample: Record<string, string> = {
    queryPredicate: ADDR,
    unit: UNIT,
    page: "1",
    txHash: TX,
    rewardAddress: STAKE,
    datumHash: TX,
    "r.reference_script_hash": SH,
  };
  for (const t of templates) {
    const path = t.replace(/\$\{([^}]+)\}/g, (_, k: string) => {
      assert.ok(k in sample, `new placeholder in Lucid's provider: ${k}`);
      return sample[k]!;
    });
    const posts: Record<string, string> = {
      "/tx/submit": "application/cbor",
      "/utils/txs/evaluate/utxos": "application/json",
    };
    const d = posts[path]
      ? checkProxyRequest({
          method: "POST",
          pathAndQuery: path,
          contentType: posts[path],
          contentLength: 100,
        })
      : get(path);
    assert.ok(d.ok, `Lucid calls ${t} but the proxy refuses it: ${d.ok ? "" : d.reason}`);
  }
});

test("E13: allowed GETs go to Preprod with only page/count kept", () => {
  for (const a of [ADDR, VKH, SCRIPT_ADDR]) assert.ok(get(`/addresses/${a}/utxos?page=2`).ok, a);
  const d = get(`/addresses/${ADDR}/utxos/${UNIT}?page=3`);
  assert.ok(d.ok);
  assert.equal(d.upstreamUrl, `${BLOCKFROST_UPSTREAM}/addresses/${ADDR}/utxos/${UNIT}?page=3`);
  assert.ok(d.upstreamUrl.startsWith("https://cardano-preprod.blockfrost.io/api/v0/"));
  assert.ok(get(`/addresses/${ADDR}/utxos/lovelace`).ok);
  assert.ok(get(`/assets/${UNIT}/addresses?count=2`).ok);
  assert.ok(get(`/accounts/${STAKE}`).ok);
});

test("E13: mainnet addresses and accounts are refused", () => {
  const main =
    "addr1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwqfjkjv7";
  assert.equal(get(`/addresses/${main}/utxos`).ok, false);
  assert.equal(get(`/accounts/stake1${"u".repeat(53)}`).ok, false);
});

test("E13: anything Lucid doesn't need is refused", () => {
  for (const p of [
    "/",
    "/health",
    "/ipfs/add",
    "/pools",
    "/metadata/txs/labels",
    `/accounts/${STAKE}/addresses`,
    `/addresses/${ADDR}`,
    `/addresses/${ADDR}/transactions`,
    `/txs/${TX}`,
    `/txs/${TX}/metadata`,
    "/epochs/latest",
    "/mempool",
  ]) {
    assert.equal(get(p).ok, false, p);
  }
});

test("E13: traversal, encoding and query tricks are refused", () => {
  for (const p of [
    `/txs/${TX}/../../ipfs/add`,
    `/txs/${TX}%2Futxos`,
    `//txs/${TX}/utxos`,
    `/txs/${TX}/utxos?project_id=x`,
    `/addresses/${ADDR}/utxos?page=1&page=2`,
    `/addresses/${ADDR}/utxos?page=-1`,
    `/addresses/${ADDR}/utxos?order=desc`,
    `/txs/${TX.toUpperCase()}/utxos`,
    `/txs/${TX}/utxos `,
    `/txs/${"a".repeat(700)}`,
  ]) {
    assert.equal(get(p).ok, false, p);
  }
});

test("E13: methods, content types and body sizes are enforced", () => {
  assert.equal(checkProxyRequest({ method: "DELETE", pathAndQuery: "/tx/submit" }).ok, false);
  assert.equal(get("/tx/submit").ok, false, "submit is POST only");
  assert.equal(
    checkProxyRequest({
      method: "POST",
      pathAndQuery: `/txs/${TX}/utxos`,
      contentType: "application/json",
      contentLength: 10,
    }).ok,
    false,
  );
  const post = (ct: string | null, len: number | null, p = "/tx/submit") =>
    checkProxyRequest({ method: "POST", pathAndQuery: p, contentType: ct, contentLength: len });
  assert.ok(post("application/cbor", MAX_TX_BYTES).ok);
  assert.equal(post("application/cbor", MAX_TX_BYTES + 1).ok, false);
  assert.equal(post("application/cbor", 0).ok, false);
  assert.equal(post("application/cbor", null).ok, false);
  assert.equal(post("application/json", 100).ok, false);
  assert.ok(
    post("application/json; charset=utf-8", MAX_EVALUATE_BYTES, "/utils/txs/evaluate/utxos").ok,
  );
  assert.equal(
    post("application/json", MAX_EVALUATE_BYTES + 1, "/utils/txs/evaluate/utxos").ok,
    false,
  );
});

test("E13: cross-site browser requests are refused; same-origin and non-browser pass", () => {
  assert.equal(isCrossSiteBrowserRequest(new Headers({ "sec-fetch-site": "cross-site" })), true);
  assert.equal(isCrossSiteBrowserRequest(new Headers({ "sec-fetch-site": "same-site" })), true);
  assert.equal(isCrossSiteBrowserRequest(new Headers({ "sec-fetch-site": "same-origin" })), false);
  assert.equal(isCrossSiteBrowserRequest(new Headers()), false);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !n.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

test("E13: the Blockfrost key is read only by server code and never returned to the browser", () => {
  const files = walk("src");
  const readers = files.filter((f) =>
    ((src) => src.includes("BLOCKFROST_PREPROD_PROJECT_ID") && src.includes("process.env"))(
      readFileSync(f, "utf8"),
    ),
  );
  for (const f of readers) {
    assert.match(
      f,
      /(\.server\.ts|blockfrost\.functions\.ts|routes[\\/]api[\\/]bf[\\/]\$\.ts)$/,
      `${f} reads the Blockfrost key but is not server-only`,
    );
  }
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /VITE_BLOCKFROST_PROJECT_ID/, `${f} would bundle a Blockfrost key`);
    assert.doesNotMatch(
      src,
      /getBlockfrostClientConfig\s*=/,
      `${f} still exports the key to browsers`,
    );
  }
  const fns = readFileSync("src/lib/blockfrost.functions.ts", "utf8");
  assert.doesNotMatch(fns, /projectId:\s*key/, "a server function returns the key");
  const vault = readFileSync("src/lib/vault.ts", "utf8");
  assert.match(vault, /BLOCKFROST_PROXY_PREFIX/);
  assert.match(vault, /new lucidMod\.Blockfrost\(bf\.url, bf\.projectId\)/);
});
