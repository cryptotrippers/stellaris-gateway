/**
 * Fraction vault — blueprint pins + address/policy derivation.
 *
 * The fractional-ownership hub runs on two validators, both compiled from
 * `contracts/fraction-vault/` and pinned here by hash:
 *
 *   * `fraction_vault.spend` — the offering. One UTxO holds the counters and
 *     the units paid in. Parameterised by
 *     `(version, asset_id, unit_policy, unit_name)`, so ADA (the empty policy)
 *     and any native token share one compiled script.
 *   * `fraction.mint` — the fraction token itself. Parameterised by the
 *     APPLIED offering script hash plus the asset id, so a fraction of asset A
 *     can never be minted against asset B. The token name IS the asset id.
 *
 * Both blueprints are re-hashed at runtime before any parameter is applied,
 * and `scripts/verify-vault-hash.mjs` fails the build if either drifts from a
 * clean `aiken build`.
 */
import { LUCID_NETWORK } from "./network";
import type { DepositAsset } from "./deposit-assets.shared";
import { type DepositUnit, lucidUnitOf, unitOfDepositAsset } from "./multi-asset-vault";

export { lucidUnitOf, unitOfDepositAsset };
export type { DepositUnit };

/** Offering instance version. Bumping this yields a fresh, empty offering. */
export const FRACTION_VAULT_VERSION = 1n;

/** Hash of the *unapplied* fraction_vault validator from plutus.json. */
export const FRACTION_BLUEPRINT_HASH =
  "adb3467c4fa9b8c8b77279d23b9db7009ed5098b77f8464b5d2744fc";

/** Hash of the *unapplied* fraction mint policy from plutus.json. */
export const FRACTION_POLICY_BLUEPRINT_HASH =
  "a0c413e215548d0c1470e1c07680a4a4d3a7207572e5a12681a3e9e0";

import fractionBlueprintSource from "../../contracts/fraction-vault/plutus.json?raw";

const blueprint = JSON.parse(fractionBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

function compiledCodeOf(title: string): string {
  const validator = blueprint.validators?.find((v) => v.title === title);
  if (!validator?.compiledCode) {
    throw new Error(`The fraction-vault blueprint is missing compiledCode for ${title}.`);
  }
  return validator.compiledCode;
}

/** Compiled CBOR of the *unapplied* offering validator (PlutusV3). */
export const FRACTION_BLUEPRINT_CBOR = compiledCodeOf("fraction_vault.fraction_vault.spend");

/** Compiled CBOR of the *unapplied* fraction mint policy (PlutusV3). */
export const FRACTION_POLICY_BLUEPRINT_CBOR = compiledCodeOf("fraction.fraction.mint");

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (
    network: typeof LUCID_NETWORK,
    v: { type: "PlutusV3"; script: string },
  ) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  mintingPolicyToId: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (text: string) => string;
};

export interface AppliedOffering {
  /** Offering (spend) validator. */
  cbor: string;
  scriptHash: string;
  address: string;
  /** Fraction token. */
  policyCbor: string;
  policyId: string;
  /** Token name (hex) — the asset id. */
  assetNameHex: string;
  /** Lucid `unit` string of the fraction token: policyId + nameHex. */
  fractionUnit: string;
  assetId: string;
  unit: DepositUnit;
  version: bigint;
  type: "PlutusV3";
}

const cache = new Map<string, AppliedOffering>();

const HEX = /^[0-9a-f]*$/;

/**
 * Apply the offering parameters, then bind the mint policy to the resulting
 * applied script hash. Order matters: the policy depends on the offering
 * hash, never the other way round, so there is no circular parameter.
 */
export function getOfferingScripts(
  lucidMod: unknown,
  assetId: string,
  unit: DepositUnit,
): AppliedOffering {
  if (!HEX.test(unit.policyId) || !HEX.test(unit.assetNameHex)) {
    throw new Error("The deposit unit policy id and asset name must be hex.");
  }
  if (unit.policyId !== "" && unit.policyId.length !== 56) {
    throw new Error("A native-token policy id must be 56 hex characters.");
  }
  if (!assetId) throw new Error("An offering needs an asset id.");

  const cacheKey = `${FRACTION_BLUEPRINT_HASH}:${String(FRACTION_VAULT_VERSION)}:${assetId}:${unit.policyId}:${unit.assetNameHex}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const mod = lucidMod as LucidModLike;

  const offeringPin = mod.validatorToScriptHash({
    type: "PlutusV3",
    script: FRACTION_BLUEPRINT_CBOR,
  });
  if (offeringPin !== FRACTION_BLUEPRINT_HASH) {
    throw new Error(
      `Fraction offering blueprint mismatch: the compiled artifact hashes to ${offeringPin}, ` +
        `but the verified pin is ${FRACTION_BLUEPRINT_HASH}. Rebuild the contracts and re-pin ` +
        `before signing any transaction.`,
    );
  }
  const policyPin = mod.validatorToScriptHash({
    type: "PlutusV3",
    script: FRACTION_POLICY_BLUEPRINT_CBOR,
  });
  if (policyPin !== FRACTION_POLICY_BLUEPRINT_HASH) {
    throw new Error(
      `Fraction token policy blueprint mismatch: the compiled artifact hashes to ${policyPin}, ` +
        `but the verified pin is ${FRACTION_POLICY_BLUEPRINT_HASH}.`,
    );
  }

  const assetNameHex = mod.fromText(assetId);

  const cbor = mod.applyParamsToScript(FRACTION_BLUEPRINT_CBOR, [
    FRACTION_VAULT_VERSION,
    assetNameHex,
    unit.policyId,
    unit.assetNameHex,
  ]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = mod.validatorToScriptHash(validator);

  const policyCbor = mod.applyParamsToScript(FRACTION_POLICY_BLUEPRINT_CBOR, [
    scriptHash,
    assetNameHex,
  ]);
  const policyValidator = { type: "PlutusV3" as const, script: policyCbor };
  const policyId = mod.mintingPolicyToId(policyValidator);

  const applied: AppliedOffering = {
    cbor,
    scriptHash,
    address: mod.validatorToAddress(LUCID_NETWORK, validator),
    policyCbor,
    policyId,
    assetNameHex,
    fractionUnit: `${policyId}${assetNameHex}`,
    assetId,
    unit,
    version: FRACTION_VAULT_VERSION,
    type: "PlutusV3",
  };
  cache.set(cacheKey, applied);
  return applied;
}

/** Lazily load Lucid in the browser and derive an offering's scripts. */
export async function deriveOffering(
  assetId: string,
  unit: DepositUnit,
): Promise<AppliedOffering> {
  const lucid = await import("@lucid-evolution/lucid");
  return getOfferingScripts(lucid, assetId, unit);
}

/** ADA, expressed as the empty policy — the launch denomination. */
export const ADA_UNIT: DepositUnit = {
  policyId: "",
  assetNameHex: "",
  decimals: 6,
  symbol: "ADA",
};

/** Read the on-chain unit from a registry row, falling back to ADA. */
export function unitOf(asset: DepositAsset | null | undefined): DepositUnit {
  return asset ? unitOfDepositAsset(asset) : ADA_UNIT;
}
