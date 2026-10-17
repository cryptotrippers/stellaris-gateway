import { readFileSync, existsSync } from "node:fs";
import {
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  fromText,
  Constr,
} from "@lucid-evolution/lucid";
import { sameScriptCbor } from "./lib/script-cbor.mjs";
import { readVaultSeeds, seedData } from "./lib/vault-seeds.mjs";

// Read-only: compares the scripts derived from the committed blueprint against
// what Blockfrost reports on Preprod. Exits 1 on any MISMATCH, 2 on setup errors.

function die(msg) {
  console.error(`[verify-live-scripts] ${msg}`);
  process.exit(2);
}

const KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
if (!KEY) die("BLOCKFROST_PREPROD_PROJECT_ID is not set in this shell.");
if (!KEY.startsWith("preprod"))
  die("BLOCKFROST_PREPROD_PROJECT_ID is not a Preprod key — refusing to run.");
const BF = "https://cardano-preprod.blockfrost.io/api/v0";

const PLUTUS = "contracts/vault/plutus.json";
if (!existsSync(PLUTUS)) die(`${PLUTUS} not found — run this from the repo root.`);
const bp = JSON.parse(readFileSync(PLUTUS, "utf8"));
const get = (t) => {
  const v = bp.validators?.find((x) => x.title === t);
  if (!v?.compiledCode) die(`${PLUTUS} has no compiledCode for '${t}'.`);
  return v.compiledCode;
};

/**
 * Find `export const NAME = <digits>n` in the first file that defines it. The
 * version constants have moved between modules before (VAULT_VERSION now lives
 * in vault-params.ts), so look in every known home and fail loudly if none has it.
 */
function versionPin(name, files) {
  const re = new RegExp(`export const ${name}\\s*=\\s*(\\d+)n`);
  for (const f of files) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(re);
    if (m) return BigInt(m[1]);
  }
  die(`could not find 'export const ${name} = <n>n' in any of: ${files.join(", ")}`);
}

const V = versionPin("VAULT_VERSION", ["src/lib/vault-params.ts", "src/lib/vault.ts"]);
const YV = versionPin("YIELD_VAULT_VERSION", ["src/lib/yield-vault.ts"]);

// Since Phase 1 the yield vault is also parameterised by its bootstrap seed
// (AUDIT.md F-1): only instances pinned in src/lib/vault-instances.ts exist.
const yieldSeeds = readVaultSeeds().yield;
const targets = [];
for (const a of ["sfm-01", "sfm-02"]) {
  targets.push({
    label: `vault/${a}`,
    cbor: applyParamsToScript(get("vault.vault.spend"), [V, fromText(a)]),
  });
}
for (const [a, seed] of Object.entries(yieldSeeds)) {
  targets.push({
    label: `yield_vault/${a}`,
    cbor: applyParamsToScript(get("yield_vault.yield_vault.spend"), [
      YV,
      fromText(a),
      seedData(Constr, seed),
    ]),
  });
}
if (Object.keys(yieldSeeds).length === 0) {
  console.log(
    "yield_vault: no instance pinned in src/lib/vault-instances.ts — nothing to compare.\n",
  );
}

async function bf(p) {
  const r = await fetch(BF + p, { headers: { project_id: KEY } });
  return { s: r.status, b: await r.text() };
}

let mismatches = 0;
for (const t of targets) {
  const val = { type: "PlutusV3", script: t.cbor };
  const hash = validatorToScriptHash(val),
    addr = validatorToAddress("Preprod", val);
  const meta = await bf(`/scripts/${hash}`);
  if (meta.s === 403 || meta.s === 401) {
    // Not process.exit(): with fetch handles still open that trips a libuv
    // assertion on Windows. Set the code and stop issuing requests instead.
    console.error(`[verify-live-scripts] Blockfrost rejected the key (HTTP ${meta.s}).`);
    process.exitCode = 2;
    break;
  }
  const cbor = await bf(`/scripts/${hash}/cbor`);
  const utxos = await bf(`/addresses/${addr}/utxos`);
  let live = "not seen on-chain",
    match = "n/a";
  if (meta.s === 200) {
    live = JSON.parse(meta.b).type;
    if (cbor.s === 200) {
      const c = JSON.parse(cbor.b).cbor;
      if (sameScriptCbor(c, t.cbor)) match = "EXACT MATCH";
      else {
        match = `MISMATCH (live ${c.length} vs local ${t.cbor.length})`;
        mismatches++;
      }
    }
  }
  const u = utxos.s === 200 ? JSON.parse(utxos.b).length : utxos.s === 404 ? 0 : `err ${utxos.s}`;
  console.log(
    `${t.label}\n  hash: ${hash}\n  addr: ${addr}\n  onchain: ${live} | cbor: ${match} | utxos: ${u}\n`,
  );
}
console.log(`vault v${V}, yield_vault v${YV}`);
if (mismatches > 0) process.exitCode = 1;
