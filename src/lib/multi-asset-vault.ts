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
 * `(version, asset_id, unit_policy, unit_name, seed)`, so one compiled script
 * yields a distinct Preprod address per project AND per deposit denomination.
 * `seed` is the UTxO consumed at bootstrap to mint the vault's one-shot
 * state-thread token (AUDIT.md F-1); an instance's address is only known once
 * it has been bootstrapped and its seed pinned in `vault-instances.ts`. ADA is
 * expressed as the empty policy with the empty name, exactly as on chain, so
 * the same derivation covers ADA and native tokens (USDr, USDM, iUSD, …).
 */
import { LUCID_NETWORK } from "./network";
import type { DepositAsset } from "./deposit-assets.shared";
import {
  MULTI_VAULT_SEEDS,
  markerUnit,
  pinnedSeed,
  seedKey,
  seedToData,
  threadUnit,
  type VaultSeed,
} from "./vault-instances";

/**
 * Vault instance version. Bumping this mints a fresh, empty vault instance.
 *
 * v2 (Phase 1 — security): one-shot state-thread token from a `seed` UTxO
 * (AUDIT.md F-1). No v1 instance was ever bootstrapped, so nothing migrates.
 */
export const MULTI_VAULT_VERSION = 2n;

/** Hash of the *unapplied* multi_asset_vault validator from plutus.json. */
export const MULTI_BLUEPRINT_HASH = "770577be4ab87d5c569a94f3c4ff516bab41e8d9404eb4e3da09fc87";

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
  Constr: new (index: number, fields: unknown[]) => unknown;
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
  /** Bootstrap seed this instance is parameterised by. */
  seed: VaultSeed;
  /** Lucid unit of the state-thread token the genuine State carries. */
  threadUnit: string;
  /** Lucid unit of the marker every genuine Position carries (F-4). */
  markerUnit: string;
  type: "PlutusV3";
}

/** Key of an instance in `MULTI_VAULT_SEEDS`: asset id + deposit unit. */
export function multiVaultSeedKey(assetId: string, unit: DepositUnit): string {
  return `${assetId}:${unit.policyId}${unit.assetNameHex}`;
}

const cache = new Map<string, AppliedMultiVault>();

const HEX = /^[0-9a-f]*$/;

/**
 * Apply `(version, asset_id, unit_policy, unit_name, seed)` to the blueprint
 * and return the applied script, its hash, and its address on the active
 * network. `seed` defaults to the pinned instance; throws
 * `VaultNotBootstrappedError` when there is none.
 */
export function getMultiVaultScript(
  lucidMod: unknown,
  assetId: string,
  unit: DepositUnit,
  seed: VaultSeed = pinnedSeed(
    "multi_asset_vault",
    MULTI_VAULT_SEEDS,
    multiVaultSeedKey(assetId, unit),
  ),
): AppliedMultiVault {
  if (!HEX.test(unit.policyId) || !HEX.test(unit.assetNameHex)) {
    throw new Error("The deposit unit policy id and asset name must be hex.");
  }
  if (unit.policyId !== "" && unit.policyId.length !== 56) {
    throw new Error("A native-token policy id must be 56 hex characters.");
  }

  const cacheKey = `${MULTI_BLUEPRINT_HASH}:${String(MULTI_VAULT_VERSION)}:${assetId}:${unit.policyId}:${unit.assetNameHex}:${seedKey(seed)}`;
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
    seedToData(lucidMod, seed),
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = mod.validatorToScriptHash(validator);
  const applied: AppliedMultiVault = {
    cbor,
    scriptHash,
    address: mod.validatorToAddress(LUCID_NETWORK, validator),
    assetId,
    unit,
    version: MULTI_VAULT_VERSION,
    seed,
    threadUnit: threadUnit(scriptHash),
    markerUnit: markerUnit(scriptHash),
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
