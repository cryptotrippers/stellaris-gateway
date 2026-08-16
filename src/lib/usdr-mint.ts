/**
 * USDr — blueprint pin + applied policy derivation, mint/burn tx builders.
 *
 * `contracts/susdr-vault/validators/usdr_mint.ak` is parameterized by
 * `(admins: List<ByteArray>, threshold: Int)`, baked in at deploy time (a
 * minting policy has no state UTxO to store a rotatable committee the way
 * `susdr_vault`'s State datum does — see DESIGN.md). Mint requires M-of-N
 * admin signatures; burn is unrestricted.
 *
 * Browser-only where it touches Lucid: dynamically imported inside each
 * function so it never ships into an SSR bundle.
 */
import { USDR_ASSET_NAME } from "./susdr-params";

export const USDR_MINT_BLUEPRINT_HASH =
  "3a66ba3d1a6c18b613b2c62f5349e13eb010716d3a38ecb8dee1973b";

import usdrBlueprintSource from "../../contracts/susdr-vault/plutus.json?raw";

const usdrBlueprint = JSON.parse(usdrBlueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

const usdrMintValidator = usdrBlueprint.validators?.find(
  (validator) => validator.title === "usdr_mint.usdr_mint.mint",
);

if (!usdrMintValidator?.compiledCode) {
  throw new Error("The usdr_mint blueprint is missing compiledCode.");
}

export const USDR_MINT_BLUEPRINT_CBOR = usdrMintValidator.compiledCode;

export interface AppliedUsdrMint {
  cbor: string;
  policyId: string;
  assetNameHex: string;
  unit: string;
  admins: string[];
  threshold: number;
  type: "PlutusV3";
}

const HEX28 = /^[0-9a-f]{56}$/;

/** Validate an admin committee before anyone signs anything. */
export function validateAdminCommittee(
  admins: string[],
  threshold: number,
): { ok: true } | { ok: false; reason: string } {
  if (admins.length === 0) return { ok: false, reason: "Add at least one admin key hash." };
  const bad = admins.find((a) => !HEX28.test(a.trim().toLowerCase()));
  if (bad) {
    return {
      ok: false,
      reason: `"${bad.slice(0, 16)}…" is not a 28-byte payment key hash (56 hex characters).`,
    };
  }
  const unique = new Set(admins.map((a) => a.trim().toLowerCase()));
  if (unique.size !== admins.length) {
    return { ok: false, reason: "The same admin key hash is listed more than once." };
  }
  if (threshold < 1) return { ok: false, reason: "The signature threshold must be at least 1." };
  if (threshold > admins.length) {
    return {
      ok: false,
      reason: `Threshold ${threshold} is higher than the ${admins.length} admin(s) listed — the policy would be permanently unusable.`,
    };
  }
  return { ok: true };
}

type LucidModLike = {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (s: string) => string;
};

const appliedCache = new Map<string, AppliedUsdrMint>();

/**
 * Apply `(admins, threshold)` to the USDr blueprint and return the applied
 * policy. Rotating the committee means calling this with a different
 * `admins`/`threshold` — which derives a DIFFERENT policy id; existing USDr
 * minted under the old policy does not migrate (see DESIGN.md).
 */
export function getUsdrMintPolicy(
  lucidMod: unknown,
  admins: string[],
  threshold: number,
): AppliedUsdrMint {
  const committee = validateAdminCommittee(admins, threshold);
  if (!committee.ok) throw new Error(committee.reason);
  const normalized = admins.map((a) => a.trim().toLowerCase());

  const cacheKey = `${USDR_MINT_BLUEPRINT_HASH}:${normalized.join(",")}:${threshold}`;
  const cached = appliedCache.get(cacheKey);
  if (cached) return cached;

  const { applyParamsToScript, validatorToScriptHash, fromText } = lucidMod as LucidModLike;

  const unappliedHash = validatorToScriptHash({ type: "PlutusV3", script: USDR_MINT_BLUEPRINT_CBOR });
  if (unappliedHash !== USDR_MINT_BLUEPRINT_HASH) {
    throw new Error(
      `usdr_mint blueprint mismatch: compiled artifact hashes to ${unappliedHash}, ` +
        `but the verified pin is ${USDR_MINT_BLUEPRINT_HASH}. Rebuild the Aiken contracts ` +
        `in contracts/susdr-vault and re-pin USDR_MINT_BLUEPRINT_HASH before signing any tx.`,
    );
  }

  const cbor = applyParamsToScript(USDR_MINT_BLUEPRINT_CBOR, [normalized, BigInt(threshold)]);
  const policyId = validatorToScriptHash({ type: "PlutusV3", script: cbor });
  const assetNameHex = fromText(USDR_ASSET_NAME);

  const applied: AppliedUsdrMint = {
    cbor,
    policyId,
    assetNameHex,
    unit: `${policyId}${assetNameHex}`,
    admins: normalized,
    threshold,
    type: "PlutusV3",
  };
  appliedCache.set(cacheKey, applied);
  console.info(
    `[usdr-mint] blueprint=${USDR_MINT_BLUEPRINT_HASH} admins=${normalized.length} threshold=${threshold} → policyId=${policyId}`,
  );
  return applied;
}
