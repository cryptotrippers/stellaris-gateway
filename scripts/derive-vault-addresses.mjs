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
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress("Preprod", validator);
  console.log(`asset=${assetId}`);
  console.log(`  scriptHash: ${scriptHash}`);
  console.log(`  preprod:    ${address}\n`);
}
