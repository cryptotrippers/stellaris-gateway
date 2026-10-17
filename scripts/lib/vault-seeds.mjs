/**
 * Read the pinned bootstrap seeds from src/lib/vault-instances.ts.
 *
 * Node scripts cannot import the TypeScript module, so the three seed maps are
 * parsed textually. Entries must keep the one-per-line shape the module uses:
 *
 *   "sfm-01": { txHash: "<64 hex>", outputIndex: 0 },
 *
 * Anything that looks like an entry but does not parse is a hard error — a
 * silently skipped seed would mean a vault the scripts never check.
 */
import { readFileSync } from "node:fs";

const SOURCE = "src/lib/vault-instances.ts";
const MAPS = { yield: "YIELD_VAULT_SEEDS", multi: "MULTI_VAULT_SEEDS", offering: "OFFERING_SEEDS" };
const ENTRY =
  /^\s*"([^"]+)":\s*\{\s*txHash:\s*"([0-9a-f]{64})",\s*outputIndex:\s*(\d+)\s*,?\s*\},?\s*$/;

function parseMap(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${SOURCE}: ${name} not found`);
  const open = src.indexOf("{", src.indexOf("=", start));
  const close = src.indexOf("};", open);
  if (open < 0 || close < 0) throw new Error(`${SOURCE}: cannot find the body of ${name}`);
  const body = src.slice(open + 1, close).trim();
  const out = {};
  if (!body) return out;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("//")) continue;
    const m = line.match(ENTRY);
    if (!m) throw new Error(`${SOURCE}: unparseable ${name} entry: ${line.trim()}`);
    out[m[1]] = { txHash: m[2], outputIndex: Number(m[3]) };
  }
  return out;
}

/** `{ yield, multi, offering }`, each a map of instance key -> seed. */
export function readVaultSeeds() {
  const src = readFileSync(SOURCE, "utf8");
  return Object.fromEntries(Object.entries(MAPS).map(([k, name]) => [k, parseMap(src, name)]));
}

/** Plutus data for an Aiken OutputReference, for applyParamsToScript. */
export function seedData(Constr, seed) {
  return new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]);
}
