#!/usr/bin/env node
/**
 * Step 4 drift guard.
 *
 * Fails if `contracts/vault/plutus.json` drifts from the *unapplied* blueprint
 * pinned in `src/lib/vault.ts` (VAULT_BLUEPRINT_HASH + VAULT_BLUEPRINT_CBOR).
 * The applied script hash + address are derived at runtime by Lucid via
 * `applyParamsToScript(cbor, [VAULT_VERSION])`, so we only pin the blueprint
 * here — bumping VAULT_VERSION does NOT change these values.
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

if (!existsSync(PLUTUS_PATH)) {
  console.log("[verify-vault-hash] contracts/vault/plutus.json not present — skipping (run `aiken build` locally to generate it).");
  process.exit(0);
}

const blueprint = JSON.parse(readFileSync(PLUTUS_PATH, "utf8"));
const v0 = blueprint?.validators?.[0];
const onChainHash = v0?.hash;
const onChainCbor = v0?.compiledCode;
if (!onChainHash || !onChainCbor) {
  console.error("[verify-vault-hash] plutus.json validators[0] missing hash or compiledCode");
  process.exit(1);
}

const vaultTs = readFileSync(VAULT_TS_PATH, "utf8");

function extract(name) {
  const m = vaultTs.match(new RegExp(`${name}\\s*=\\s*"([0-9a-f]+)"`));
  if (!m) {
    console.error(`[verify-vault-hash] ${name} not found in src/lib/vault.ts`);
    process.exit(1);
  }
  return m[1];
}

const pinnedHash = extract("VAULT_BLUEPRINT_HASH");
const pinnedCbor = extract("VAULT_BLUEPRINT_CBOR");

let drift = false;
if (pinnedHash !== onChainHash) {
  console.error("[verify-vault-hash] BLUEPRINT HASH DRIFT");
  console.error(`  pinned   (src/lib/vault.ts):        ${pinnedHash}`);
  console.error(`  on-chain (plutus.json):             ${onChainHash}`);
  drift = true;
}
if (pinnedCbor !== onChainCbor) {
  console.error("[verify-vault-hash] BLUEPRINT CBOR DRIFT");
  console.error(`  pinned CBOR length:  ${pinnedCbor.length}`);
  console.error(`  on-chain CBOR length: ${onChainCbor.length}`);
  drift = true;
}

if (drift) {
  console.error("");
  console.error("  The compiled validator no longer matches what the app applies at runtime.");
  console.error("  Either revert the Aiken change, or update VAULT_BLUEPRINT_HASH +");
  console.error("  VAULT_BLUEPRINT_CBOR in src/lib/vault.ts. If the on-chain logic itself");
  console.error("  changed (not just a rebuild), also bump VAULT_VERSION and withdraw all");
  console.error("  live deposits before deploying.");
  process.exit(1);
}

console.log(`[verify-vault-hash] OK — blueprint matches (hash=${pinnedHash.slice(0, 12)}…, cbor=${pinnedCbor.length} chars).`);
