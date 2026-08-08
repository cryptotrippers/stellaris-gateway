#!/usr/bin/env node
/**
 * Blueprint drift guard.
 *
 * Fails if `contracts/vault/plutus.json` drifts from the *unapplied* blueprints
 * pinned in the app:
 *   - `vault.vault.spend`             → VAULT_BLUEPRINT_* in src/lib/vault.ts
 *   - `yield_vault.yield_vault.spend` → YIELD_BLUEPRINT_* in src/lib/yield-vault.ts
 *
 * Applied script hashes + addresses are derived at runtime by Lucid via
 * `applyParamsToScript(cbor, [version, assetId])`, so only the blueprints are
 * pinned here — bumping a version does NOT change these values.
 *
 * Skips silently if plutus.json is absent (contributors without Aiken installed
 * can still `bun run build`).
 *
 * Run manually: `node scripts/verify-vault-hash.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PLUTUS_PATH = resolve("contracts/vault/plutus.json");
const VAULT_TS_PATH = resolve("src/lib/vault.ts");
const YIELD_TS_PATH = resolve("src/lib/yield-vault.ts");

if (!existsSync(PLUTUS_PATH)) {
  console.log("[verify-vault-hash] contracts/vault/plutus.json not present — skipping (run `aiken build` locally to generate it).");
  process.exit(0);
}

const blueprint = JSON.parse(readFileSync(PLUTUS_PATH, "utf8"));
const validators = blueprint?.validators ?? [];

function findValidator(titlePrefix) {
  const v = validators.find(
    (x) => typeof x?.title === "string" && x.title.startsWith(titlePrefix) && x.title.includes(".spend"),
  );
  if (!v?.hash || !v?.compiledCode) {
    console.error(`[verify-vault-hash] plutus.json has no '${titlePrefix}' spend validator with hash + compiledCode`);
    process.exit(1);
  }
  return v;
}

function readPins(path) {
  const src = readFileSync(path, "utf8");
  return (name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
    if (!m) {
      console.error(`[verify-vault-hash] ${name} not found in ${path}`);
      process.exit(1);
    }
    return m[1];
  };
}

const vaultPin = readPins(VAULT_TS_PATH);
const yieldPin = readPins(YIELD_TS_PATH);

const targets = [
  {
    label: "vault (Stage 3)",
    onChain: findValidator("vault.vault"),
    hash: vaultPin("VAULT_BLUEPRINT_HASH"),
    cbor: vaultPin("VAULT_BLUEPRINT_CBOR"),
    file: "src/lib/vault.ts",
  },
  {
    label: "yield_vault (Stage 4)",
    onChain: findValidator("yield_vault.yield_vault"),
    hash: yieldPin("YIELD_BLUEPRINT_HASH"),
    cbor: yieldPin("YIELD_BLUEPRINT_CBOR"),
    file: "src/lib/yield-vault.ts",
  },
];

let drift = false;
for (const t of targets) {
  if (t.hash !== t.onChain.hash) {
    console.error(`[verify-vault-hash] ${t.label} BLUEPRINT HASH DRIFT`);
    console.error(`  pinned   (${t.file}): ${t.hash}`);
    console.error(`  on-chain (plutus.json):     ${t.onChain.hash}`);
    drift = true;
  }
  if (t.cbor !== t.onChain.compiledCode) {
    console.error(`[verify-vault-hash] ${t.label} BLUEPRINT CBOR DRIFT`);
    console.error(`  pinned CBOR length:   ${t.cbor.length}`);
    console.error(`  on-chain CBOR length: ${t.onChain.compiledCode.length}`);
    drift = true;
  }
}

if (drift) {
  console.error("");
  console.error("  The compiled validator no longer matches what the app applies at runtime.");
  console.error("  Either revert the Aiken change, or update the pinned hash + CBOR. If the");
  console.error("  on-chain logic itself changed (not just a rebuild), also bump the version");
  console.error("  and withdraw all live deposits before deploying.");
  process.exit(1);
}

for (const t of targets) {
  console.log(`[verify-vault-hash] OK — ${t.label} matches (hash=${t.hash.slice(0, 12)}…, cbor=${t.cbor.length} chars).`);
}
