/**
 * sUSDr vault — blueprint pin + applied address derivation.
 *
 * Mirrors `src/lib/yield-vault.ts`'s structure, with one deliberate
 * simplification: `contracts/susdr-vault/validators/susdr_vault.ak` defines
 * its `mint` handler (sUSDr) in the SAME validator block as `spend`, so the
 * two purposes compile to a single script hash (verified in
 * `contracts/susdr-vault/DESIGN.md` by diffing `plutus.json`). There is no
 * `receipt.ak`-style second file and no `getReceiptPolicy`/
 * `assertReceiptPolicy` step here — the sUSDr policy id IS
 * `AppliedSusdrVault.scriptHash`.
 *
 * The validator is parameterized by `(version, usdr_policy, usdr_asset_name)`.
 * `scripts/verify-susdr-vault-hash.mjs` fails the build if the pinned
 * blueprint drifts from `contracts/susdr-vault/plutus.json`.
 */
import { LUCID_NETWORK } from "./network";
import { SUSDR_VAULT_VERSION, SUSDR_ASSET_NAME, USDR_ASSET_NAME } from "./susdr-params";

/** Hash of the *unapplied* susdr_vault validator (spend/mint/else all share it). */
export const SUSDR_VAULT_BLUEPRINT_HASH =
  "255deaeead572430a9e159237690106e9f93d72ce78fb672e5b58c77";

import susdrBlueprintSource from "../../contracts/susdr-vault/plutus.json?raw";

const susdrBlueprint = JSON.parse(susdrBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string; hash?: string }>;
};

const susdrSpendValidator = susdrBlueprint.validators?.find(
  (validator) => validator.title === "susdr_vault.susdr_vault.spend",
);

if (!susdrSpendValidator?.compiledCode) {
  throw new Error("The susdr_vault blueprint is missing compiledCode for its spend handler.");
}

/** Compiled CBOR of the *unapplied* susdr_vault validator (PlutusV3). */
export const SUSDR_VAULT_BLUEPRINT_CBOR = susdrSpendValidator.compiledCode;

const susdrMintValidator = susdrBlueprint.validators?.find(
  (validator) => validator.title === "susdr_vault.susdr_vault.mint",
);

if (!susdrMintValidator?.hash || susdrMintValidator.hash !== susdrSpendValidator.hash) {
  throw new Error(
    "susdr_vault's spend and mint handlers no longer share a hash — the 'one script, two " +
      "purposes' design in DESIGN.md no longer holds for this build of the Aiken compiler. " +
      "Do not derive a sUSDr policy id from the vault's script hash until this is re-verified.",
  );
}

export interface AppliedSusdrVault {
  /** CBOR of the fully-applied validator (ready to attach to a tx). */
  cbor: string;
  /** Applied script hash — the vault's spending credential AND the sUSDr policy id. */
  scriptHash: string;
  /** Bech32 vault address for the active network. */
  address: string;
  usdrPolicyId: string;
  usdrAssetNameHex: string;
  /** `scriptHash + susdrAssetNameHex`, the Lucid unit for the sUSDr token. */
  susdrUnit: string;
  type: "PlutusV3";
}

const appliedCache = new Map<string, AppliedSusdrVault>();

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (network: typeof LUCID_NETWORK, v: { type: "PlutusV3"; script: string }) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (s: string) => string;
};

/**
 * Apply `(SUSDR_VAULT_VERSION, usdrPolicyId, usdrAssetName)` to the blueprint
 * and return the applied script, its address, and the derived sUSDr unit.
 * Cached per `(usdrPolicyId, usdrAssetName)` pair for the session.
 */
export function getSusdrVaultScript(
  lucidMod: unknown,
  usdrPolicyId: string,
  usdrAssetName: string = USDR_ASSET_NAME,
): AppliedSusdrVault {
  const cacheKey = `${SUSDR_VAULT_BLUEPRINT_HASH}:${String(SUSDR_VAULT_VERSION)}:${usdrPolicyId}:${usdrAssetName}`;
  const cached = appliedCache.get(cacheKey);
  if (cached) return cached;

  const { applyParamsToScript, validatorToAddress, validatorToScriptHash, fromText } =
    lucidMod as LucidModLike;

  // Verify the *unapplied* blueprint before any parameters are applied, so a
  // drifted or stale plutus.json can never be used to build an on-chain tx.
  const unappliedHash = validatorToScriptHash({
    type: "PlutusV3",
    script: SUSDR_VAULT_BLUEPRINT_CBOR,
  });
  if (unappliedHash !== SUSDR_VAULT_BLUEPRINT_HASH) {
    throw new Error(
      `sUSDr vault blueprint mismatch: compiled artifact hashes to ${unappliedHash}, ` +
        `but the verified pin is ${SUSDR_VAULT_BLUEPRINT_HASH}. Rebuild the Aiken contracts ` +
        `in contracts/susdr-vault and re-pin SUSDR_VAULT_BLUEPRINT_HASH before signing any tx.`,
    );
  }

  const usdrAssetNameHex = fromText(usdrAssetName);
  const cbor = applyParamsToScript(SUSDR_VAULT_BLUEPRINT_CBOR, [
    SUSDR_VAULT_VERSION,
    usdrPolicyId,
    usdrAssetNameHex,
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = validatorToScriptHash(validator);
  const address = validatorToAddress(LUCID_NETWORK, validator);
  const susdrAssetNameHex = fromText(SUSDR_ASSET_NAME);

  const applied: AppliedSusdrVault = {
    cbor,
    scriptHash,
    address,
    usdrPolicyId,
    usdrAssetNameHex,
    susdrUnit: `${scriptHash}${susdrAssetNameHex}`,
    type: "PlutusV3",
  };
  appliedCache.set(cacheKey, applied);
  console.info(
    `[susdr-vault] blueprint=${SUSDR_VAULT_BLUEPRINT_HASH} v${String(SUSDR_VAULT_VERSION)} ` +
      `usdrPolicy=${usdrPolicyId} → hash=${scriptHash} addr=${address} susdrUnit=${applied.susdrUnit}`,
  );
  return applied;
}

/**
 * Guard for builders that spend an existing vault UTxO: refuse to build if a
 * registry-recorded address no longer matches the verified script. Mirrors
 * `assertYieldVaultAddress` (AUDIT.md O-01) — bootstrap deliberately does NOT
 * call this, since it is the one flow allowed to target a fresh address.
 */
export function assertSusdrVaultAddress(
  script: Pick<AppliedSusdrVault, "address" | "usdrPolicyId">,
  registryAddress: string | null | undefined,
): void {
  if (registryAddress && registryAddress !== script.address) {
    throw new Error(
      `Vault address drift for USDr policy ${script.usdrPolicyId}: registry has ${registryAddress}, ` +
        `verified script derives ${script.address}. Re-bootstrap the vault before transacting.`,
    );
  }
}
