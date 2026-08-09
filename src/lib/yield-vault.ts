/**
 * Stage 4 — Yield Vault blueprint pin + address derivation.
 *
 * This is the share-accrual successor to the Stage 3 per-owner vault
 * (`src/lib/vault.ts`). It is deliberately kept separate: the Stage 3 vault
 * stays live and spendable while the yield vault is proven on Preprod.
 *
 * The validator is parameterized by `(version, asset_id)`, exactly like the
 * Stage 3 vault, so every marketplace asset derives its own script hash and
 * address. `scripts/verify-vault-hash.mjs` fails the build if the pinned
 * blueprint drifts from `contracts/vault/plutus.json`.
 */
import { LUCID_NETWORK } from "./network";

/** Yield vault instance version. Bumping this mints a fresh vault family. */
export const YIELD_VAULT_VERSION = 3n;

/** Hash of the *unapplied* yield_vault validator from plutus.json. */
export const YIELD_BLUEPRINT_HASH =
  "623678fe6de5b685b6d287c185c0da8a25a495a95742760a0c6e6fe7";

/** Compiled CBOR of the *unapplied* yield_vault validator (PlutusV3). */
import yieldBlueprintSource from "../../contracts/vault/plutus.json?raw";

const yieldBlueprint = JSON.parse(yieldBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

const yieldValidator = yieldBlueprint.validators?.find(
  (validator) => validator.title === "yield_vault.yield_vault.spend",
);

if (!yieldValidator?.compiledCode) {
  throw new Error("The yield_vault blueprint is missing compiledCode.");
}

export const YIELD_BLUEPRINT_CBOR = yieldValidator.compiledCode;

export interface AppliedYieldVault {
  cbor: string;
  scriptHash: string;
  address: string;
  assetId: string;
  type: "PlutusV3";
}

const appliedCache = new Map<string, AppliedYieldVault>();

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (network: typeof LUCID_NETWORK, v: { type: "PlutusV3"; script: string }) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (s: string) => string;
};

/**
 * Apply `(YIELD_VAULT_VERSION, assetId)` to the yield blueprint and return the
 * applied script + its address on the active network. Cached per asset.
 */
export function getYieldVaultScript(lucidMod: unknown, assetId: string): AppliedYieldVault {
  const cached = appliedCache.get(assetId);
  if (cached) return cached;

  const { applyParamsToScript, validatorToAddress, validatorToScriptHash, fromText } =
    lucidMod as LucidModLike;

  const cbor = applyParamsToScript(YIELD_BLUEPRINT_CBOR, [
    YIELD_VAULT_VERSION,
    fromText(assetId),
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress(LUCID_NETWORK, validator);

  const applied: AppliedYieldVault = { cbor, scriptHash, address, assetId, type: "PlutusV3" };
  appliedCache.set(assetId, applied);
  return applied;
}
