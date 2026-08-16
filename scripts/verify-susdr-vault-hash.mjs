#!/usr/bin/env node
/**
 * Blueprint drift guard for the sUSDr contracts.
 *
 * Fails if `contracts/susdr-vault/plutus.json` drifts from the *unapplied*
 * blueprints pinned in the app:
 *   - `susdr_vault.susdr_vault.spend` → SUSDR_VAULT_BLUEPRINT_* in src/lib/susdr-vault.ts
 *   - `usdr_mint.usdr_mint.mint`      → USDR_MINT_BLUEPRINT_* in src/lib/usdr-mint.ts
 *
 * Also re-checks that susdr_vault's spend and mint handlers still share one
 * hash — the "one script, two purposes" design DESIGN.md documents is a
 * property of the compiler's output, not something this codebase can force,
 * so it needs to be checked on every build, not just asserted once.
 *
 * Applied script hashes + addresses are derived at runtime by Lucid via
 * `applyParamsToScript`, so only the blueprints are pinned here.
 *
 * Skips silently if plutus.json is absent (contributors without Aiken
 * installed can still `bun run build`). Mirrors scripts/verify-vault-hash.mjs.
 *
 * Run manually: `node scripts/verify-susdr-vault-hash.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";

const PLUTUS_PATH = resolve("contracts/susdr-vault/plutus.json");
const VAULT_TS_PATH = resolve("src/lib/susdr-vault.ts");
const MINT_TS_PATH = resolve("src/lib/usdr-mint.ts");

const STRICT = process.env.VERIFY_VAULT_STRICT === "1" || process.argv.includes("--strict");

if (!existsSync(PLUTUS_PATH)) {
  if (STRICT) {
    console.error("[verify-susdr-vault-hash] STRICT mode: contracts/susdr-vault/plutus.json is missing — run `aiken build`.");
    process.exit(1);
  }
  console.log("[verify-susdr-vault-hash] contracts/susdr-vault/plutus.json not present — skipping (run `aiken build` locally to generate it).");
  process.exit(0);
}

const blueprint = JSON.parse(readFileSync(PLUTUS_PATH, "utf8"));
const validators = blueprint?.validators ?? [];

function findValidator(title) {
  const v = validators.find((x) => x?.title === title);
  if (!v?.hash || !v?.compiledCode) {
    console.error(`[verify-susdr-vault-hash] plutus.json has no '${title}' validator with hash + compiledCode`);
    process.exit(1);
  }
  return v;
}

function readPin(path, name) {
  const src = readFileSync(path, "utf8");
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
  if (!m) {
    console.error(`[verify-susdr-vault-hash] ${name} not found in ${path}`);
    process.exit(1);
  }
  return m[1];
}

/** blake2b-224 over (PlutusV3 language tag 0x03 || flat-encoded script bytes). */
function scriptHashOf(compiledCodeHex) {
  const body = Uint8Array.from(Buffer.from(compiledCodeHex, "hex"));
  const tagged = new Uint8Array(body.length + 1);
  tagged[0] = 0x03;
  tagged.set(body, 1);
  return Buffer.from(blake2b(tagged, { dkLen: 28 })).toString("hex");
}

const susdrSpend = findValidator("susdr_vault.susdr_vault.spend");
const susdrMint = findValidator("susdr_vault.susdr_vault.mint");
const usdrMint = findValidator("usdr_mint.usdr_mint.mint");

let drift = false;

if (susdrSpend.hash !== susdrMint.hash) {
  console.error(
    `[verify-susdr-vault-hash] susdr_vault spend (${susdrSpend.hash}) and mint (${susdrMint.hash}) ` +
      `hashes differ — the combined-handler design DESIGN.md relies on no longer holds.`,
  );
  drift = true;
}

const targets = [
  { label: "susdr_vault", onChain: susdrSpend, hash: readPin(VAULT_TS_PATH, "SUSDR_VAULT_BLUEPRINT_HASH"), file: VAULT_TS_PATH },
  { label: "usdr_mint", onChain: usdrMint, hash: readPin(MINT_TS_PATH, "USDR_MINT_BLUEPRINT_HASH"), file: MINT_TS_PATH },
];

for (const t of targets) {
  if (t.hash !== t.onChain.hash) {
    console.error(`[verify-susdr-vault-hash] ${t.label} BLUEPRINT HASH DRIFT`);
    console.error(`  pinned   (${t.file}): ${t.hash}`);
    console.error(`  on-chain (plutus.json):     ${t.onChain.hash}`);
    drift = true;
  }
  const recomputed = scriptHashOf(t.onChain.compiledCode);
  if (recomputed !== t.onChain.hash) {
    console.error(`[verify-susdr-vault-hash] ${t.label} SELF-INCONSISTENT BLUEPRINT`);
    console.error(`  plutus.json hash:  ${t.onChain.hash}`);
    console.error(`  hash of its CBOR:  ${recomputed}`);
    drift = true;
  }
}

if (drift) {
  console.error("");
  console.error("  The compiled validator no longer matches what the app applies at runtime.");
  console.error("  Rebuild contracts/susdr-vault (aiken build) and re-pin the hashes above,");
  console.error("  or revert the Aiken change. If the on-chain logic itself changed, also bump");
  console.error("  SUSDR_VAULT_VERSION and withdraw all live deposits before redeploying.");
  process.exit(1);
}

console.log(`[verify-susdr-vault-hash] OK — susdr_vault spend+mint share one hash (${susdrSpend.hash.slice(0, 12)}…).`);
for (const t of targets) {
  console.log(`[verify-susdr-vault-hash] OK — ${t.label} matches (hash=${t.hash.slice(0, 12)}…, recomputed from CBOR).`);
}
