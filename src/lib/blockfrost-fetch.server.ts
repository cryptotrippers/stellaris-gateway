/**
 * Server-only Blockfrost fetch helper.
 *
 * `*.server.ts` files are blocked from client bundles by filename, so the
 * project id read here can never reach the browser. Load this with a dynamic
 * `await import()` inside server-function handlers.
 */

const BASE = "https://cardano-preprod.blockfrost.io/api/v0";

/** GET a Blockfrost path. Returns null on 404, throws on any other failure. */
export async function bfGet<T>(path: string): Promise<T | null> {
  const key = process.env["BLOCKFROST_PREPROD_PROJECT_ID"];
  if (!key) throw new Error("Blockfrost is not configured on the server.");
  const res = await fetch(`${BASE}${path}`, { headers: { project_id: key } });
  if (res.status === 404) return null;
  const body = await res.text();
  if (!res.ok) throw new Error(`Blockfrost ${res.status}: ${body || res.statusText}`);
  return JSON.parse(body) as T;
}
