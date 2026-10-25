/**
 * Security Suite S1 — the set of scripts, policies and addresses a
 * transaction built by this app is allowed to touch.
 *
 * Two sources, both code-reviewed:
 *  1. DEPLOYED_ALLOWLIST, generated from deployments/preprod-v1.json.
 *  2. Scripts the app derives at runtime from the PINNED blueprints
 *     (vault.ts, yield-vault.ts, multi-asset-vault.ts, fraction-vault.ts).
 *     Each derivation helper checks the blueprint pin first and then calls
 *     `trustDerivedScript`; nothing else in the app should call it.
 *
 * Limitation (stated in the S1 guide): this protects the signing path from
 * tampered transactions, wrong parameters and compromised builder
 * dependencies. It cannot protect against a fully replaced site bundle; that
 * is what site integrity (S2) and on-chain validators (layer 1) are for.
 */
import { DEPLOYED_ALLOWLIST } from "./tx-allowlist.generated";

const HEX56 = /^[0-9a-f]{56}$/;

const derived = new Map<string, string>();

/** Register a script derived from a pinned blueprint. Returns the hash. */
export function trustDerivedScript(scriptHash: string, label: string): string {
  const h = scriptHash.toLowerCase();
  if (!HEX56.test(h)) throw new Error(`not a script hash: ${scriptHash}`);
  if (!derived.has(h)) derived.set(h, label);
  return h;
}

const deployedScripts = new Map<string, string>([
  ...DEPLOYED_ALLOWLIST.scripts.map((e) => [e.value, e.role] as [string, string]),
  ...DEPLOYED_ALLOWLIST.policies.map((e) => [e.value, e.role] as [string, string]),
]);
const deployedAddresses = new Map<string, string>(
  DEPLOYED_ALLOWLIST.addresses.map((e) => [e.value, e.role] as [string, string]),
);
const deployedRewards = new Map<string, string>(
  DEPLOYED_ALLOWLIST.rewardAddresses.map((e) => [e.value, e.role] as [string, string]),
);

export interface TrustView {
  /** Label of a trusted script or policy hash, or null. */
  script(hash: string): string | null;
  /** Label of a deployed address, or null. */
  address(bech32: string): string | null;
  /** Label of a deployed reward address, or null. */
  reward(bech32: string): string | null;
}

/** The live trust view (deployed + derived in this session). */
export const trust: TrustView = {
  script: (h) => deployedScripts.get(h.toLowerCase()) ?? derived.get(h.toLowerCase()) ?? null,
  address: (a) => deployedAddresses.get(a) ?? null,
  reward: (a) => deployedRewards.get(a) ?? null,
};

/** A fixed trust view for tests. */
export function trustOf(input: {
  scripts?: Record<string, string>;
  addresses?: Record<string, string>;
  rewards?: Record<string, string>;
}): TrustView {
  return {
    script: (h) => input.scripts?.[h.toLowerCase()] ?? null,
    address: (a) => input.addresses?.[a] ?? null,
    reward: (a) => input.rewards?.[a] ?? null,
  };
}
