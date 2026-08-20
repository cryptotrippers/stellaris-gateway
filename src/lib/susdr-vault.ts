/**
 * sUSDr — stablecoin yield vault blueprint pin + address derivation.
 *
 * Mirrors the ADA vault convention (`src/lib/vault.ts`, `src/lib/yield-vault.ts`):
 * the *unapplied* blueprint from `contracts/susdr-vault/plutus.json` is pinned
 * here by hash, re-hashed at runtime before any parameters are applied, and
 * `scripts/verify-vault-hash.mjs` fails the build if it drifts from a clean
 * `aiken build`.
 *
 * Preprod-only reference implementation — see contracts/susdr-vault/README.md.
 * The vault validator is parameterized by `(version)` and is both the spending
 * validator and the sUSDr minting policy; the test stablecoin policy
 * (`usdr.ak`) is parameterized by `(issuer_key_hash)`.
 */
import { LUCID_NETWORK } from "./network";

/** sUSDr vault instance version. Bumping this mints a fresh vault instance. */
export const SUSDR_VAULT_VERSION = 1n;

/** Hash of the *unapplied* susdr_vault validator from plutus.json. */
export const SUSDR_BLUEPRINT_HASH = "ca69e3255a3721e0881d3b8c93422a2027eadcf9064db16164026a7f";

/** Hash of the *unapplied* usdr test-stablecoin policy from plutus.json. */
export const USDR_BLUEPRINT_HASH = "e066c6bda9520276cebc618decd6df908358a0bd9e33de43f71e9cc6";

import susdrBlueprintSource from "../../contracts/susdr-vault/plutus.json?raw";

const susdrBlueprint = JSON.parse(susdrBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

function compiledCodeOf(title: string): string {
  const validator = susdrBlueprint.validators?.find((v) => v.title === title);
  if (!validator?.compiledCode) {
    throw new Error(`The sUSDr blueprint is missing compiledCode for ${title}.`);
  }
  return validator.compiledCode;
}

/** Compiled CBOR of the *unapplied* susdr_vault validator (PlutusV3). */
export const SUSDR_BLUEPRINT_CBOR = compiledCodeOf("susdr_vault.susdr_vault.spend");

/** Compiled CBOR of the *unapplied* usdr minting policy (PlutusV3). */
export const USDR_BLUEPRINT_CBOR = compiledCodeOf("usdr.usdr.mint");

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (
    network: typeof LUCID_NETWORK,
    v: { type: "PlutusV3"; script: string },
  ) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
};

function assertPin(lucidMod: LucidModLike, label: string, cbor: string, pinned: string): void {
  const unappliedHash = lucidMod.validatorToScriptHash({ type: "PlutusV3", script: cbor });
  if (unappliedHash !== pinned) {
    throw new Error(
      `${label} blueprint mismatch: compiled artifact hashes to ${unappliedHash}, but the ` +
        `verified pin is ${pinned}. Rebuild the Aiken contracts and re-pin before signing ` +
        `any transaction.`,
    );
  }
}

export interface AppliedSusdrVault {
  cbor: string;
  scriptHash: string;
  address: string;
  /** The sUSDr share token policy id — the vault script is its own policy. */
  policyId: string;
  version: bigint;
  type: "PlutusV3";
}

const vaultCache = new Map<string, AppliedSusdrVault>();

/**
 * Apply `(SUSDR_VAULT_VERSION)` to the sUSDr blueprint and return the applied
 * script, its address on the active network, and its share-token policy id.
 */
export function getSusdrVaultScript(lucidMod: unknown): AppliedSusdrVault {
  const cacheKey = `${SUSDR_BLUEPRINT_HASH}:${String(SUSDR_VAULT_VERSION)}`;
  const cached = vaultCache.get(cacheKey);
  if (cached) return cached;

  const mod = lucidMod as LucidModLike;
  assertPin(mod, "sUSDr vault", SUSDR_BLUEPRINT_CBOR, SUSDR_BLUEPRINT_HASH);

  const cbor = mod.applyParamsToScript(SUSDR_BLUEPRINT_CBOR, [SUSDR_VAULT_VERSION]);
  const validator = { type: "PlutusV3" as const, script: cbor };
  const scriptHash = mod.validatorToScriptHash(validator);
  const applied: AppliedSusdrVault = {
    cbor,
    scriptHash,
    address: mod.validatorToAddress(LUCID_NETWORK, validator),
    policyId: scriptHash,
    version: SUSDR_VAULT_VERSION,
    type: "PlutusV3",
  };
  vaultCache.set(cacheKey, applied);
  console.info(
    `[susdr-vault] blueprint=${SUSDR_BLUEPRINT_HASH} v${String(SUSDR_VAULT_VERSION)} ` +
      `→ hash=${applied.scriptHash} addr=${applied.address}`,
  );
  return applied;
}

export interface AppliedUsdrPolicy {
  cbor: string;
  policyId: string;
  issuerKeyHash: string;
  type: "PlutusV3";
}

const usdrCache = new Map<string, AppliedUsdrPolicy>();

const HEX28 = /^[0-9a-f]{56}$/;

/** Derive the USDr test-stablecoin policy for a given issuer payment key hash. */
export function getUsdrPolicy(lucidMod: unknown, issuerKeyHash: string): AppliedUsdrPolicy {
  const issuer = issuerKeyHash.trim().toLowerCase();
  if (!HEX28.test(issuer)) {
    throw new Error("The USDr issuer key hash must be 56 hex characters.");
  }
  const cacheKey = `${USDR_BLUEPRINT_HASH}:${issuer}`;
  const cached = usdrCache.get(cacheKey);
  if (cached) return cached;

  const mod = lucidMod as LucidModLike;
  assertPin(mod, "USDr policy", USDR_BLUEPRINT_CBOR, USDR_BLUEPRINT_HASH);

  const cbor = mod.applyParamsToScript(USDR_BLUEPRINT_CBOR, [issuer]);
  const applied: AppliedUsdrPolicy = {
    cbor,
    policyId: mod.validatorToScriptHash({ type: "PlutusV3", script: cbor }),
    issuerKeyHash: issuer,
    type: "PlutusV3",
  };
  usdrCache.set(cacheKey, applied);
  return applied;
}

/** Lazily load Lucid in the browser and derive the applied sUSDr vault. */
export async function deriveSusdrVault(): Promise<AppliedSusdrVault> {
  const lucid = await import("@lucid-evolution/lucid");
  return getSusdrVaultScript(lucid);
}
