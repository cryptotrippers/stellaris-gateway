/**
 * fraction_vault v2 — blueprint pins and script derivation (E07).
 *
 * Three validators compiled from `contracts/fraction-vault/` (SPEC-v2.md §3,
 * §11.1), each pinned here by the hash of its UNAPPLIED code and re-hashed at
 * runtime before any parameter is applied:
 *
 *   * `pledge`      — one script for every offering; parameter `version`.
 *                     Doubles as the pledge-marker policy.
 *   * `offering_v2` — one per offering; `(version, asset_id, unit_policy,
 *                     unit_name, pledge_hash, seed)`. Doubles as the policy of
 *                     the State's one-shot thread token.
 *   * `fraction_v2` — the fraction token; `(offering_hash, asset_id)`.
 *
 * Order of derivation: pledge → offering (needs the pledge hash) → fraction
 * policy (needs the offering hash). No parameter is circular.
 *
 * `scripts/verify-vault-hash.mjs` fails CI if a pin drifts from a clean build.
 * Plain shared module: Lucid is passed in, never imported at top level.
 */
import blueprintSource from "../../contracts/fraction-vault/plutus.json?raw";
import { trustDerivedScript } from "./tx-trust.shared";
import { PLEDGE_MARKER_HEX } from "./offering-v2-chain";
import { normaliseSeed, seedKey, seedToData, threadUnit, type VaultSeed } from "./vault-instances";

export const OFFERING_V2_BLUEPRINT_HASH =
  "c26699c93b120a25bd34b0f485fde981de5566da0bc77402354f4ab9";
export const PLEDGE_BLUEPRINT_HASH = "13f3e79ebc5a0e4c74f1e443e8b99b1a8fa9c8858f3d2d5354cfb8e0";
export const FRACTION_V2_BLUEPRINT_HASH =
  "15b1e44fb3761a2f905ef71f73b339d1ca53632cbc5a85e9e886dfdd";

/** Version parameter of the shared pledge script and of v2 offerings. */
export const PLEDGE_VERSION = 0n;
export const OFFERING_V2_VERSION = 0n;

// Vite's `?raw` gives the file's text. Some Node test loaders resolve the
// `.json` themselves and hand over the parsed object; accept either, so the
// pins are checked against the same blueprint in the app and in CI.
const blueprintRaw: unknown = blueprintSource;
const blueprint = (typeof blueprintRaw === "string" ? JSON.parse(blueprintRaw) : blueprintRaw) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

function compiled(title: string): string {
  const v = blueprint.validators?.find((x) => x.title === title);
  if (!v?.compiledCode) throw new Error(`The fraction-vault blueprint is missing ${title}.`);
  return v.compiledCode;
}

export const OFFERING_V2_BLUEPRINT_CBOR = compiled("offering_v2.offering_v2.spend");
export const PLEDGE_BLUEPRINT_CBOR = compiled("pledge.pledge.spend");
export const FRACTION_V2_BLUEPRINT_CBOR = compiled("fraction_v2.fraction_v2.mint");

type Net = "Preprod" | "Mainnet" | "Preview" | "Custom";

export interface LucidModV2 {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToAddress: (network: Net, v: { type: "PlutusV3"; script: string }) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
  fromText: (text: string) => string;
  Constr: new (index: number, fields: unknown[]) => unknown;
  Data: { to: (v: unknown) => string };
}

export interface V2Unit {
  /** "" for ADA. */
  policyId: string;
  /** Hex asset name; "" for ADA. */
  assetNameHex: string;
}

export interface V2Scripts {
  network: Net;
  assetId: string;
  assetNameHex: string;
  unit: V2Unit;
  seed: VaultSeed;
  pledge: { cbor: string; hash: string; address: string; markerUnit: string };
  offering: { cbor: string; hash: string; address: string; threadUnit: string };
  fraction: { cbor: string; policyId: string; unit: string };
  /** Lucid unit key of the deposit unit ("lovelace" for ADA). */
  depositUnit: string;
}

function checkPin(mod: LucidModV2, cbor: string, pin: string, name: string) {
  const got = mod.validatorToScriptHash({ type: "PlutusV3", script: cbor });
  if (got !== pin) {
    throw new Error(
      `${name} blueprint mismatch: the compiled artifact hashes to ${got}, but the verified ` +
        `pin is ${pin}. Rebuild the contracts and re-pin before signing any transaction.`,
    );
  }
}

const HEX = /^[0-9a-f]*$/;
const cache = new Map<string, V2Scripts>();

/**
 * Derive every script of one v2 offering. `seed` is the UTxO the offering's
 * `Open` consumes; before opening it is the chosen seed, afterwards the pinned
 * one. `network` defaults to Preprod; tests pass "Custom" for the emulator.
 */
export function deriveV2(
  mod: LucidModV2,
  assetId: string,
  unit: V2Unit,
  seed: VaultSeed,
  network: Net = "Preprod",
): V2Scripts {
  if (!HEX.test(unit.policyId) || !HEX.test(unit.assetNameHex)) {
    throw new Error("The deposit unit policy id and asset name must be hex.");
  }
  if (unit.policyId !== "" && unit.policyId.length !== 56) {
    throw new Error("A native-token policy id must be 56 hex characters.");
  }
  if (!assetId) throw new Error("An offering needs an asset id.");
  const s = normaliseSeed(seed);
  const key = `${network}:${assetId}:${unit.policyId}.${unit.assetNameHex}:${seedKey(s)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  checkPin(mod, PLEDGE_BLUEPRINT_CBOR, PLEDGE_BLUEPRINT_HASH, "pledge");
  checkPin(mod, OFFERING_V2_BLUEPRINT_CBOR, OFFERING_V2_BLUEPRINT_HASH, "offering_v2");
  checkPin(mod, FRACTION_V2_BLUEPRINT_CBOR, FRACTION_V2_BLUEPRINT_HASH, "fraction_v2");

  const pledgeCbor = mod.applyParamsToScript(PLEDGE_BLUEPRINT_CBOR, [PLEDGE_VERSION]);
  const pledgeV = { type: "PlutusV3" as const, script: pledgeCbor };
  const pledgeHash = trustDerivedScript(mod.validatorToScriptHash(pledgeV), "pledge (v2)");

  const assetNameHex = mod.fromText(assetId);
  const offeringCbor = mod.applyParamsToScript(OFFERING_V2_BLUEPRINT_CBOR, [
    OFFERING_V2_VERSION,
    assetNameHex,
    unit.policyId,
    unit.assetNameHex,
    pledgeHash,
    seedToData(mod, s),
  ]);
  const offeringV = { type: "PlutusV3" as const, script: offeringCbor };
  const offeringHash = trustDerivedScript(
    mod.validatorToScriptHash(offeringV),
    `offering_v2:${assetId}`,
  );

  const fractionCbor = mod.applyParamsToScript(FRACTION_V2_BLUEPRINT_CBOR, [
    offeringHash,
    assetNameHex,
  ]);
  const fractionPolicy = trustDerivedScript(
    mod.validatorToScriptHash({ type: "PlutusV3", script: fractionCbor }),
    `fraction_v2:${assetId}`,
  );

  const out: V2Scripts = {
    network,
    assetId,
    assetNameHex,
    unit,
    seed: s,
    pledge: {
      cbor: pledgeCbor,
      hash: pledgeHash,
      address: mod.validatorToAddress(network, pledgeV),
      markerUnit: `${pledgeHash}${PLEDGE_MARKER_HEX}`,
    },
    offering: {
      cbor: offeringCbor,
      hash: offeringHash,
      address: mod.validatorToAddress(network, offeringV),
      threadUnit: threadUnit(offeringHash),
    },
    fraction: {
      cbor: fractionCbor,
      policyId: fractionPolicy,
      unit: `${fractionPolicy}${assetNameHex}`,
    },
    depositUnit: unit.policyId === "" ? "lovelace" : `${unit.policyId}${unit.assetNameHex}`,
  };
  cache.set(key, out);
  return out;
}

/**
 * SPEC-v2 §11.1: the State names its fraction policy, and a script cannot
 * check that on-chain at `Open`. Every reader must confirm it before listing
 * an offering.
 */
export function fractionPolicyIsGenuine(scripts: V2Scripts, statePolicy: string): boolean {
  return statePolicy.toLowerCase() === scripts.fraction.policyId;
}
