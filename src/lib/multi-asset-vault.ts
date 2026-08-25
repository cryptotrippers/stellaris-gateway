/**
 * Multi-asset vault — blueprint pin + address derivation (Wing B, step 1).
 *
 * Mirrors the ADA vault convention (`src/lib/yield-vault.ts`): the *unapplied*
 * blueprint from `contracts/multi-asset-vault/plutus.json` is pinned here by
 * hash, re-hashed at runtime before any parameters are applied, and
 * `scripts/verify-vault-hash.mjs` fails the build if it drifts from a clean
 * `aiken build`.
 *
 * The validator is parameterised by
 * `(version, asset_id, unit_policy, unit_name)`, so one compiled script yields
 * a distinct Preprod address per project AND per deposit denomination. ADA is
 * expressed as the empty policy with the empty name, exactly as on chain, so
 * the same derivation covers ADA and native tokens (USDr, USDM, iUSD, …).
 */
import { LUCID_NETWORK } from "./network";
import type { DepositAsset } from "./deposit-assets.shared";

/** Vault instance version. Bumping this mints a fresh, empty vault instance. */
export const MULTI_VAULT_VERSION = 1n;

/** Hash of the *unapplied* multi_asset_vault validator from plutus.json. */
export const MULTI_BLUEPRINT_HASH = "024fe73af2d6defe8d54b2ca75551763eded748cd041368283d276df";

import multiBlueprintSource from "../../contracts/multi-asset-vault/plutus.json?raw";

const multiBlueprint = JSON.parse(multiBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

function compiledCodeOf(title: string): string {
  const validator = multiBlueprint.validators?.find((v) => v.title === title);
  if (!validator?.compiledCode) {
    throw new Error(`The multi-asset vault blueprint is missing compiledCode for ${title}.`);
  }
  return validator.compiledCode;
}

/** Compiled CBOR of the *unapplied* multi_asset_vault validator (PlutusV3). */
export const MULTI_BLUEPRINT_CBOR = compiledCodeOf("multi_asset_vault.multi_asset_vault.spend");

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (
    network: typeof LUCID_NETWORK,
    v: { type: "PlutusV3"; script: string },
  ) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (text: string) => string;
};

/** The on-chain deposit unit: `(policy_id, asset_name_hex)`; ADA is `("", "")`. */
export interface DepositUnit {
  policyId: string;
  assetNameHex: string;
  /** Base-unit decimals, used only for display. */
  decimals: number;
  symbol: string;
}

/** Read the on-chain unit out of a registry row. ADA collapses to `("", "")`. */
export function unitOfDepositAsset(asset: DepositAsset): DepositUnit {
  const policyId = (asset.policy_id ?? "").trim().toLowerCase();
  return {
    policyId,
    assetNameHex: policyId === "" ? "" : (asset.asset_name_hex ?? "").trim().toLowerCase(),
    decimals: asset.decimals,
    symbol: asset.symbol,
  };
}

/** Lucid's `unit` string for a deposit unit: `"lovelace"` or `policy+name`. */
export function lucidUnitOf(unit: DepositUnit): string {
  return unit.policyId === "" ? "lovelace" : `${unit.policyId}${unit.assetNameHex}`;
}

export interface AppliedMultiVault {
  cbor: string;
  scriptHash: string;
  address: string;
  assetId: string;
  unit: DepositUnit;
  version: bigint;
  type: "PlutusV3";
}

const cache = new Map<string, AppliedMultiVault>();

const HEX = /^[0-9a-f]*$/;

/**
 * Apply `(version, asset_id, unit_policy, unit_name)` to the blueprint and
 * return the applied script, its hash, and its address on the active network.
 */
export function getMultiVaultScript(
  lucidMod: unknown,
  assetId: string,
  unit: DepositUnit,
): AppliedMultiVault {
  if (!HEX.test(unit.policyId) || !HEX.test(unit.assetNameHex)) {
    throw new Error("The deposit unit policy id and asset name must be hex.");
  }
  if (unit.policyId !== "" && unit.policyId.length !== 56) {
    throw new Error("A native-token policy id must be 56 hex characters.");
  }

  const cacheKey = `${MULTI_BLUEPRINT_HASH}:${String(MULTI_VAULT_VERSION)}:${assetId}:${unit.policyId}:${unit.assetNameHex}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const mod = lucidMod as LucidModLike;
  const unappliedHash = mod.validatorToScriptHash({
    type: "PlutusV3",
    script: MULTI_BLUEPRINT_CBOR,
  });
  if (unappliedHash !== MULTI_BLUEPRINT_HASH) {
    throw new Error(
      `Multi-asset vault blueprint mismatch: compiled artifact hashes to ${unappliedHash}, but ` +
        `the verified pin is ${MULTI_BLUEPRINT_HASH}. Rebuild the Aiken contracts and re-pin ` +
        `before signing any transaction.`,
    );
  }

  const cbor = mod.applyParamsToScript(MULTI_BLUEPRINT_CBOR, [
    MULTI_VAULT_VERSION,
    mod.fromText(assetId),
    unit.policyId,
    unit.assetNameHex,
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const applied: AppliedMultiVault = {
    cbor,
    scriptHash: mod.validatorToScriptHash(validator),
    address: mod.validatorToAddress(LUCID_NETWORK, validator),
    assetId,
    unit,
    version: MULTI_VAULT_VERSION,
    type: "PlutusV3",
  };
  cache.set(cacheKey, applied);
  return applied;
}

/** Lazily load Lucid in the browser and derive the applied multi-asset vault. */
export async function deriveMultiVault(
  assetId: string,
  unit: DepositUnit,
): Promise<AppliedMultiVault> {
  const lucid = await import("@lucid-evolution/lucid");
  return getMultiVaultScript(lucid, assetId, unit);
}
