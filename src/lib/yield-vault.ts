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
  "ff755a8ef4fd16a01a0fd6bab6e1e2217df0b67b2ef726e7fd3e022a";

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

/**
 * Stage 6 — receipt token policy.
 *
 * `receipt.ak` is parameterized by `(applied_yield_vault_hash, asset_id)`, and
 * the vault in turn stores the resulting policy id in its State datum, so a
 * deposit MUST mint and a withdrawal MUST burn exactly the depositor-share
 * delta. There is no hash cycle: the vault's own hash depends only on
 * `(version, asset_id)`.
 */
export const RECEIPT_BLUEPRINT_HASH =
  "ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d";

const receiptValidator = yieldBlueprint.validators?.find(
  (validator) => validator.title === "receipt.receipt.mint",
);

if (!receiptValidator?.compiledCode) {
  throw new Error("The receipt blueprint is missing compiledCode.");
}

export const RECEIPT_BLUEPRINT_CBOR = receiptValidator.compiledCode;

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

  // Verify the *unapplied* blueprint before any parameters are applied, so a
  // drifted or stale plutus.json can never be used to build an on-chain tx.
  const unappliedHash = validatorToScriptHash({
    type: "PlutusV3",
    script: YIELD_BLUEPRINT_CBOR,
  });
  if (unappliedHash !== YIELD_BLUEPRINT_HASH) {
    throw new Error(
      `Yield vault blueprint mismatch: compiled artifact hashes to ${unappliedHash}, ` +
        `but the verified pin is ${YIELD_BLUEPRINT_HASH}. Rebuild the Aiken contracts ` +
        `and re-pin YIELD_BLUEPRINT_HASH before signing any transaction.`,
    );
  }

  const cbor = applyParamsToScript(YIELD_BLUEPRINT_CBOR, [
    YIELD_VAULT_VERSION,
    fromText(assetId),
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress(LUCID_NETWORK, validator);

  const applied: AppliedYieldVault = { cbor, scriptHash, address, assetId, type: "PlutusV3" };
  appliedCache.set(assetId, applied);
  console.info(
    `[yield-vault] blueprint=${YIELD_BLUEPRINT_HASH} v${String(YIELD_VAULT_VERSION)} ` +
      `asset=${assetId} → hash=${scriptHash} addr=${address}`,
  );
  return applied;
}

export interface AppliedReceiptPolicy {
  cbor: string;
  policyId: string;
  /** Token name (hex) — always the vault's asset id. */
  assetNameHex: string;
  /** `policyId + assetNameHex`, the Lucid unit for the receipt token. */
  unit: string;
  type: "PlutusV3";
}

const receiptCache = new Map<string, AppliedReceiptPolicy>();

/**
 * Derive the receipt minting policy bound to this asset's yield vault. The
 * unapplied blueprint is re-hashed and checked against the pin first, exactly
 * like the vault, so a stale artifact can never be attached to a signed tx.
 */
export function getReceiptPolicy(lucidMod: unknown, assetId: string): AppliedReceiptPolicy {
  const cached = receiptCache.get(assetId);
  if (cached) return cached;

  const { applyParamsToScript, validatorToScriptHash, fromText } = lucidMod as LucidModLike;

  const unappliedHash = validatorToScriptHash({
    type: "PlutusV3",
    script: RECEIPT_BLUEPRINT_CBOR,
  });
  if (unappliedHash !== RECEIPT_BLUEPRINT_HASH) {
    throw new Error(
      `Receipt policy blueprint mismatch: compiled artifact hashes to ${unappliedHash}, ` +
        `but the verified pin is ${RECEIPT_BLUEPRINT_HASH}. Rebuild the Aiken contracts ` +
        `and re-pin RECEIPT_BLUEPRINT_HASH before signing any transaction.`,
    );
  }

  const vault = getYieldVaultScript(lucidMod, assetId);
  const assetNameHex = fromText(assetId);
  const cbor = applyParamsToScript(RECEIPT_BLUEPRINT_CBOR, [vault.scriptHash, assetNameHex]);
  const policyId = validatorToScriptHash({ type: "PlutusV3", script: cbor });

  const applied: AppliedReceiptPolicy = {
    cbor,
    policyId,
    assetNameHex,
    unit: `${policyId}${assetNameHex}`,
    type: "PlutusV3",
  };
  receiptCache.set(assetId, applied);
  return applied;
}

/**
 * Refuse to transact against a vault whose datum points at a different receipt
 * policy than the one this build derives.
 */
export function assertReceiptPolicy(
  policy: AppliedReceiptPolicy,
  datumPolicy: string | null | undefined,
): void {
  const onChain = (datumPolicy ?? "").toLowerCase();
  if (!onChain) {
    throw new Error(
      "This vault's state datum carries no receipt policy — it predates Stage 6 and must be re-bootstrapped.",
    );
  }
  if (onChain !== policy.policyId) {
    throw new Error(
      `Receipt policy drift: the vault datum is bound to ${onChain}, but this build derives ` +
        `${policy.policyId}. Re-bootstrap the vault before transacting.`,
    );
  }
}

/**
 * Guard for builders that spend a vault UTxO recorded in the registry: refuse
 * to build if the stored address no longer matches the verified script.
 */
export function assertYieldVaultAddress(
  script: AppliedYieldVault,
  registryAddress: string | null | undefined,
): void {
  if (registryAddress && registryAddress !== script.address) {
    throw new Error(
      `Vault address drift for ${script.assetId}: registry has ${registryAddress}, ` +
        `verified script v${String(YIELD_VAULT_VERSION)} derives ${script.address}. ` +
        `Re-bootstrap the vault before transacting.`,
    );
  }
}

