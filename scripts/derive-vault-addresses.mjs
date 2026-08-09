#!/usr/bin/env node
/**
 * Derive the applied vault script hash + Preprod address for each supported
 * marketplace asset id, using the pinned blueprint CBOR in src/lib/vault.ts.
 *
 * Usage:  node scripts/derive-vault-addresses.mjs [assetId ...]
 * Default asset ids: sfm-01 sfm-02
 *
 * This is the Stage 3 / Step 1 address registry generator. The output must
 * match what the browser logs (`[vault] applied version=... → hash=...`).
 */
import { readFileSync } from "node:fs";
import {
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  fromText,
} from "@lucid-evolution/lucid";

const src = readFileSync(new URL("../src/lib/vault.ts", import.meta.url), "utf8");

function pin(name) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
  if (!m) throw new Error(`Could not read ${name} from src/lib/vault.ts`);
  return m[1];
}
const versionMatch = src.match(/VAULT_VERSION\s*=\s*(\d+)n/);
if (!versionMatch) throw new Error("Could not read VAULT_VERSION from src/lib/vault.ts");

const VERSION = BigInt(versionMatch[1]);
const HASH = pin("VAULT_BLUEPRINT_HASH");
const CBOR = pin("VAULT_BLUEPRINT_CBOR");

const assetIds = process.argv.slice(2).length ? process.argv.slice(2) : ["sfm-01", "sfm-02"];

console.log(`[derive-vault-addresses] version=${VERSION}`);
console.log(`[derive-vault-addresses] blueprint hash=${HASH}`);
console.log(`[derive-vault-addresses] blueprint cbor=${CBOR.length} chars\n`);

for (const assetId of assetIds) {
  const script = applyParamsToScript(CBOR, [VERSION, fromText(assetId)]);
  const validator = { type: "PlutusV3", script };
  console.log(`asset=${assetId}`);
  console.log(`  scriptHash: ${validatorToScriptHash(validator)}`);
  console.log(`  preprod:    ${validatorToAddress("Preprod", validator)}\n`);
}

// --- Stage 4: yield vault -------------------------------------------------
const ysrc = readFileSync(new URL("../src/lib/yield-vault.ts", import.meta.url), "utf8");
function ypin(name) {
  const m = ysrc.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
  if (!m) throw new Error(`Could not read ${name} from src/lib/yield-vault.ts`);
  return m[1];
}
const yVersionMatch = ysrc.match(/YIELD_VAULT_VERSION\s*=\s*(\d+)n/);
if (!yVersionMatch) throw new Error("Could not read YIELD_VAULT_VERSION");
const Y_VERSION = BigInt(yVersionMatch[1]);
const Y_HASH = ypin("YIELD_BLUEPRINT_HASH");
// The yield blueprint CBOR is imported from plutus.json at runtime by the app,
// so read it from the same artifact here instead of a literal pin.
const Y_CBOR = JSON.parse(
  readFileSync(new URL("../contracts/vault/plutus.json", import.meta.url), "utf8"),
).validators.find((v) => v.title === "yield_vault.yield_vault.spend").compiledCode;

console.log(`[derive-yield-addresses] version=${Y_VERSION}`);
console.log(`[derive-yield-addresses] blueprint hash=${Y_HASH}`);
console.log(`[derive-yield-addresses] blueprint cbor=${Y_CBOR.length} chars\n`);

for (const assetId of assetIds) {
  const script = applyParamsToScript(Y_CBOR, [Y_VERSION, fromText(assetId)]);
  const validator = { type: "PlutusV3", script };
  console.log(`yield asset=${assetId}`);
  console.log(`  scriptHash: ${validatorToScriptHash(validator)}`);
  console.log(`  preprod:    ${validatorToAddress("Preprod", validator)}\n`);
}
