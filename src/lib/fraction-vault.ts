/**
 * Fraction vault — blueprint pins + address/policy derivation.
 *
 * The fractional-ownership hub runs on two validators, both compiled from
 * `contracts/fraction-vault/` and pinned here by hash:
 *
 *   * `fraction_vault.spend` — the offering. One UTxO holds the counters and
 *     the units paid in. Parameterised by
 *     `(version, asset_id, unit_policy, unit_name, seed)`, so ADA (the empty
 *     policy) and any native token share one compiled script. `seed` is the
 *     UTxO consumed at opening to mint the offering's one-shot state-thread
 *     token (AUDIT.md F-1); an offering's address is only known once it is
 *     opened and its seed pinned in `vault-instances.ts`.
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
import {
  OFFERING_SEEDS,
  pinnedSeed,
  seedKey,
  seedToData,
  threadUnit,
  type VaultSeed,
} from "./vault-instances";

export { lucidUnitOf, unitOfDepositAsset };
export type { DepositUnit };

/**
 * Offering instance version. Bumping this yields a fresh, empty offering.
 *
 * v2 (Phase 1 — security): offerings carry a one-shot state-thread token
 * minted at opening from a `seed` UTxO (AUDIT.md F-1). No v1 offering was
 * ever opened on Preprod, so nothing migrates.
 */
export const FRACTION_VAULT_VERSION = 2n;

/** Hash of the *unapplied* fraction_vault validator from plutus.json. */
export const FRACTION_BLUEPRINT_HASH =
  "1360f2208e2a2ba81185727a162cac4f1a06123d93818a1859e254a4";

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
  Constr: new (index: number, fields: unknown[]) => unknown;
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
  /** Opening seed this offering is parameterised by. */
  seed: VaultSeed;
  /** Lucid unit of the state-thread token the genuine offering UTxO carries. */
  threadUnit: string;
  type: "PlutusV3";
}

/** Key of an offering in `OFFERING_SEEDS`: asset id + deposit unit. */
export function offeringSeedKey(assetId: string, unit: DepositUnit): string {
  return `${assetId}:${unit.policyId}${unit.assetNameHex}`;
}

const cache = new Map<string, AppliedOffering>();

const HEX = /^[0-9a-f]*$/;

/**
 * Apply the offering parameters, then bind the mint policy to the resulting
 * applied script hash. Order matters: the policy depends on the offering
 * hash, never the other way round, so there is no circular parameter.
 *
 * `seed` defaults to the offering pinned in `vault-instances.ts`; only the
 * opening builder passes one explicitly. Throws `VaultNotBootstrappedError`
 * when the offering has no pinned seed.
 */
export function getOfferingScripts(
  lucidMod: unknown,
  assetId: string,
  unit: DepositUnit,
  seed: VaultSeed = pinnedSeed("fraction_vault", OFFERING_SEEDS, offeringSeedKey(assetId, unit)),
): AppliedOffering {
  if (!HEX.test(unit.policyId) || !HEX.test(unit.assetNameHex)) {
    throw new Error("The deposit unit policy id and asset name must be hex.");
  }
  if (unit.policyId !== "" && unit.policyId.length !== 56) {
    throw new Error("A native-token policy id must be 56 hex characters.");
  }
  if (!assetId) throw new Error("An offering needs an asset id.");

  const cacheKey = `${FRACTION_BLUEPRINT_HASH}:${String(FRACTION_VAULT_VERSION)}:${assetId}:${unit.policyId}:${unit.assetNameHex}:${seedKey(seed)}`;
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
    seedToData(lucidMod, seed),
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
    seed,
    threadUnit: threadUnit(scriptHash),
    type: "PlutusV3",
  };
  cache.set(cacheKey, applied);
  return applied;
}

/**
 * Lazily load Lucid in the browser and derive an opened offering's scripts.
 * Throws `VaultNotBootstrappedError` for an offering that has no pinned seed.
 */
export async function deriveOffering(
  assetId: string,
  unit: DepositUnit,
  seed?: VaultSeed,
): Promise<AppliedOffering> {
  const lucid = await import("@lucid-evolution/lucid");
  return seed
    ? getOfferingScripts(lucid, assetId, unit, seed)
    : getOfferingScripts(lucid, assetId, unit);
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
