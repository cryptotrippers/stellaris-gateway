#!/usr/bin/env node
/**
 * Derive the applied sUSDr vault script hash + Preprod address, and the
 * applied USDr minting policy id, from the pinned blueprints in
 * src/lib/susdr-vault.ts / src/lib/usdr-mint.ts.
 *
 * This is Phase 1's gate script: it must derive and print both applied
 * addresses without erroring, using the real pinned blueprint hashes from
 * Phase 0 (contracts/susdr-vault/plutus.json). No wallet, no network call.
 *
 * Usage: node scripts/derive-susdr-vault-addresses.mjs
 */
import { readFileSync } from "node:fs";
import {
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  fromText,
} from "@lucid-evolution/lucid";

const plutus = JSON.parse(
  readFileSync(new URL("../contracts/susdr-vault/plutus.json", import.meta.url), "utf8"),
);

function findValidator(title) {
  const v = plutus.validators.find((x) => x.title === title);
  if (!v) throw new Error(`plutus.json has no validator titled '${title}'`);
  return v;
}

const susdrSpend = findValidator("susdr_vault.susdr_vault.spend");
const susdrMint = findValidator("susdr_vault.susdr_vault.mint");
const usdrMint = findValidator("usdr_mint.usdr_mint.mint");

// --- Sanity: the "one script, two purposes" design from DESIGN.md ---------
if (susdrSpend.hash !== susdrMint.hash) {
  throw new Error(
    `susdr_vault spend (${susdrSpend.hash}) and mint (${susdrMint.hash}) hashes differ — ` +
      `the combined-handler design DESIGN.md relies on no longer holds for this compiler build.`,
  );
}
console.log(`[derive-susdr] OK: susdr_vault spend+mint share one hash (${susdrSpend.hash})\n`);

// --- Pin cross-check against src/lib -------------------------------------
const vaultTs = readFileSync(new URL("../src/lib/susdr-vault.ts", import.meta.url), "utf8");
const mintTs = readFileSync(new URL("../src/lib/usdr-mint.ts", import.meta.url), "utf8");
function pin(src, name, file) {
  const m = src.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
  if (!m) throw new Error(`Could not read ${name} from ${file}`);
  return m[1];
}
const pinnedVaultHash = pin(vaultTs, "SUSDR_VAULT_BLUEPRINT_HASH", "src/lib/susdr-vault.ts");
const pinnedMintHash = pin(mintTs, "USDR_MINT_BLUEPRINT_HASH", "src/lib/usdr-mint.ts");
if (pinnedVaultHash !== susdrSpend.hash) {
  throw new Error(
    `SUSDR_VAULT_BLUEPRINT_HASH pin (${pinnedVaultHash}) != plutus.json (${susdrSpend.hash})`,
  );
}
if (pinnedMintHash !== usdrMint.hash) {
  throw new Error(`USDR_MINT_BLUEPRINT_HASH pin (${pinnedMintHash}) != plutus.json (${usdrMint.hash})`);
}
console.log(`[derive-susdr] OK: src/lib pins match plutus.json\n`);

// --- Derive an applied USDr minting policy (fixture admin committee) -----
const VERSION = 1n;
const admins = [
  "aa111111111111111111111111111111111111111111111111111111",
  "bb222222222222222222222222222222222222222222222222222222",
  "cc333333333333333333333333333333333333333333333333333333",
];
const threshold = 2n;

const usdrScript = applyParamsToScript(usdrMint.compiledCode, [admins, threshold]);
const usdrPolicyId = validatorToScriptHash({ type: "PlutusV3", script: usdrScript });
console.log(`[usdr-mint] admins=${admins.length} threshold=${threshold}`);
console.log(`  policyId: ${usdrPolicyId}\n`);

// --- Derive the applied sUSDr vault, parameterized by that USDr policy ---
const usdrAssetNameHex = fromText("USDr");
const vaultScript = applyParamsToScript(susdrSpend.compiledCode, [
  VERSION,
  usdrPolicyId,
  usdrAssetNameHex,
]);
const vaultValidator = { type: "PlutusV3", script: vaultScript };
const vaultScriptHash = validatorToScriptHash(vaultValidator);
const vaultAddress = validatorToAddress("Preprod", vaultValidator);

console.log(`[susdr-vault] version=${VERSION} usdrPolicy=${usdrPolicyId}`);
console.log(`  scriptHash: ${vaultScriptHash}`);
console.log(`  preprod:    ${vaultAddress}`);
console.log(`  susdrUnit:  ${vaultScriptHash}${fromText("sUSDr")}`);
console.log(
  `\n[derive-susdr] sUSDr policy id == vault script hash: ${vaultScriptHash === vaultScriptHash} (structurally always true — see DESIGN.md)`,
);
