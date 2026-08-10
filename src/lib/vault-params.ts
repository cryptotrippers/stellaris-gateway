/**
 * Stage 3 vault parameters.
 *
 * Split out of `vault.ts` so server-only code can read the version without
 * importing the browser Lucid/wallet code that lives alongside it.
 */

/** Bumping this value produces a fresh vault instance on-chain. */
export const VAULT_VERSION = 2n;

/** The asset whose vault the standalone deposit/withdraw cards default to. */
export const DEFAULT_VAULT_ASSET_ID = "sfm-01";
