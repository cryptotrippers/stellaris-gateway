#!/usr/bin/env node
/**
 * Fails if contracts/vault/plutus.json drifts from the hash pinned in
 * src/lib/vault.ts (VAULT_SCRIPT_HASH). Skips silently if plutus.json is
 * absent (contributors without Aiken installed can still `bun run build`).
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
const onChainHash = blueprint?.validators?.[0]?.hash;
if (!onChainHash) {
  console.error("[verify-vault-hash] plutus.json has no validators[0].hash");
  process.exit(1);
}

const vaultTs = readFileSync(VAULT_TS_PATH, "utf8");
const match = vaultTs.match(/VAULT_SCRIPT_HASH\s*=\s*"([0-9a-f]+)"/);
if (!match) {
  console.error("[verify-vault-hash] VAULT_SCRIPT_HASH not found in src/lib/vault.ts");
  process.exit(1);
}
const pinnedHash = match[1];

if (pinnedHash !== onChainHash) {
  console.error("[verify-vault-hash] HASH DRIFT DETECTED");
  console.error(`  pinned  (src/lib/vault.ts):        ${pinnedHash}`);
  console.error(`  on-chain (contracts/vault/plutus.json): ${onChainHash}`);
  console.error("");
  console.error("  The compiled validator no longer matches the address the app talks to.");
  console.error("  Either revert the Aiken change or run `aiken address`, update");
  console.error("  VAULT_SCRIPT_HASH + VAULT_SCRIPT_ADDRESS in src/lib/vault.ts, and");
  console.error("  make sure all live deposits are withdrawn before switching.");
  process.exit(1);
}

console.log(`[verify-vault-hash] OK — hash matches (${pinnedHash.slice(0, 12)}…).`);
