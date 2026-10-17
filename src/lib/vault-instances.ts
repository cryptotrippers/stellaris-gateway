/**
 * Bootstrap seeds of every live shared-State vault instance.
 *
 * Phase 1 (AUDIT.md F-1): `yield_vault`, `multi_asset_vault` and
 * `fraction_vault` are parameterised by a one-shot `seed` OutputReference,
 * and bootstrap mints a state-thread token by consuming that UTxO. The seed is
 * therefore part of the script — a vault's address cannot be derived until its
 * seed is known, and it is only known once the vault has been bootstrapped.
 *
 * Workflow: the bootstrap builder picks a wallet UTxO as the seed, submits,
 * and returns `{ txHash, outputIndex }`. An operator then pins it here in a
 * reviewed commit; until then the vault exists on-chain but this build cannot
 * address it. Keeping the map in git (rather than only in the database) means
 * every address the app will ever sign against is code-reviewed.
 *
 * Each map is scoped to ONE blueprint family. When a version constant bumps,
 * its map starts empty again.
 *
 * `scripts/lib/vault-seeds.mjs` parses these maps for the Node verification
 * scripts. Keep one entry per line, exactly in this shape:
 *
 *   "sfm-01": { txHash: "<64 hex chars>", outputIndex: 0 },
 *
 * Plain shared module (browser + server); no Lucid import at top level.
 */

export interface VaultSeed {
  /** Transaction id of the seed UTxO, 64 hex chars. */
  txHash: string;
  outputIndex: number;
}

/** yield_vault v5 — keyed by asset id (e.g. "sfm-01"). */
export const YIELD_VAULT_SEEDS: Readonly<Record<string, VaultSeed>> = {};

/** multi_asset_vault v2 — keyed by `${assetId}:${unitPolicyId}${unitAssetNameHex}`. */
export const MULTI_VAULT_SEEDS: Readonly<Record<string, VaultSeed>> = {};

/** fraction_vault v2 — keyed by `${assetId}:${unitPolicyId}${unitAssetNameHex}`. */
export const OFFERING_SEEDS: Readonly<Record<string, VaultSeed>> = {};

/** Thrown when a vault family has no pinned seed for the requested instance. */
export class VaultNotBootstrappedError extends Error {
  constructor(
    readonly family: string,
    readonly key: string,
  ) {
    super(
      `No bootstrapped ${family} instance is pinned for "${key}" in this build. ` +
        `Bootstrap it, then pin the returned seed in src/lib/vault-instances.ts.`,
    );
    this.name = "VaultNotBootstrappedError";
  }
}

const TX_HASH = /^[0-9a-f]{64}$/;

/** Validate and normalise a seed; throws on anything malformed. */
export function normaliseSeed(seed: VaultSeed): VaultSeed {
  const txHash = seed.txHash.trim().toLowerCase();
  if (!TX_HASH.test(txHash)) throw new Error("A vault seed tx hash must be 64 hex characters.");
  if (!Number.isInteger(seed.outputIndex) || seed.outputIndex < 0) {
    throw new Error("A vault seed output index must be a non-negative integer.");
  }
  return { txHash, outputIndex: seed.outputIndex };
}

/** Look up a pinned seed, or throw `VaultNotBootstrappedError`. */
export function pinnedSeed(
  family: string,
  map: Readonly<Record<string, VaultSeed>>,
  key: string,
): VaultSeed {
  const seed = map[key];
  if (!seed) throw new VaultNotBootstrappedError(family, key);
  return normaliseSeed(seed);
}

type ConstrCtor = new (index: number, fields: unknown[]) => unknown;

/**
 * Plutus data for an Aiken `OutputReference { transaction_id, output_index }`
 * (constructor 0, `[bytes, int]`) — the shape the validators' `seed`
 * parameter expects.
 */
export function seedToData(lucidMod: unknown, seed: VaultSeed): unknown {
  const { Constr } = lucidMod as { Constr: ConstrCtor };
  const s = normaliseSeed(seed);
  return new Constr(0, [s.txHash, BigInt(s.outputIndex)]);
}

/** Cache-key fragment for a seed. */
export function seedKey(seed: VaultSeed): string {
  return `${seed.txHash}#${String(seed.outputIndex)}`;
}

/** Asset name (hex) of every state-thread token: UTF-8 "state". */
export const THREAD_TOKEN_NAME_HEX = "7374617465";

/** Lucid unit of an instance's thread token: its own script hash + "state". */
export function threadUnit(scriptHash: string): string {
  return `${scriptHash}${THREAD_TOKEN_NAME_HEX}`;
}

/** Asset name (hex) of every position marker: UTF-8 "position" (AUDIT.md F-4). */
export const MARKER_TOKEN_NAME_HEX = "706f736974696f6e";

/**
 * Lucid unit of an instance's position marker. Every Position UTxO a deposit
 * creates carries exactly one; Positions without it are not the vault's.
 */
export function markerUnit(scriptHash: string): string {
  return `${scriptHash}${MARKER_TOKEN_NAME_HEX}`;
}
