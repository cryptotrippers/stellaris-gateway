/**
 * sUSDr vault parameters.
 *
 * Split out so server-only code can read these without importing the browser
 * Lucid/wallet code that lives alongside the rest of `src/lib/susdr-*.ts` —
 * mirrors `vault-params.ts`.
 */

/** Bumping this value produces a fresh sUSDr vault instance on-chain. */
export const SUSDR_VAULT_VERSION = 1n;

/**
 * USDr policy id + asset name this build's vault is parameterized by.
 *
 * THESE ARE PLACEHOLDERS. No real USDr token exists yet — this repo is
 * Preprod-only (see CLAUDE.md / NETWORK.md) and nothing here claims a real,
 * live USDr issuance. Bootstrapping an actual vault requires first minting a
 * test batch of USDr under `usdr_mint.ak` (see `src/lib/usdr-mint.ts`) with a
 * real admin committee, then pointing `USDR_POLICY_ID` at that policy's id.
 * Until then, `deriveSusdrVaultAddress` still works — it only needs *some*
 * syntactically valid 28-byte policy id to apply the vault's parameters.
 */
export const USDR_POLICY_ID_PLACEHOLDER =
  "00000000000000000000000000000000000000000000000000000000".slice(0, 56);

/** Fixed USDr token name, UTF-8 "USDr" — mirrors `usdr_mint.ak`'s constant. */
export const USDR_ASSET_NAME = "USDr";

/** Fixed sUSDr token name, UTF-8 "sUSDr" — mirrors `susdr_vault.ak`'s constant. */
export const SUSDR_ASSET_NAME = "sUSDr";
