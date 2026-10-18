/**
 * Pinned (unapplied) blueprint hashes for the Tessera contracts in
 * `contracts/tessera/plutus.json`. `scripts/verify-vault-hash.mjs` (run in CI)
 * fails the build if a fresh `aiken build` no longer matches them.
 *
 * Pins only: there is no Tessera off-chain code yet (Phase 4), and the
 * `ReserveState` datum is provisional until counsel answers (SPEC.md §1), so
 * nothing may bootstrap or derive an address against these hashes.
 *
 * Phase 2.2: `reserve.ak` mints its own state-thread token and checks the
 * genesis State on-chain, so the separate `state_nft.ak` (and its pin) is
 * retired. The script is parameterised by the bootstrap seed UTxO.
 * Phase 2.3: `eligibility.ak` (allowlist policy + registry) is parameterised
 * by the applied reserve script hash.
 */

/** `reserve.reserve` — Reserve State spend + TSRA and thread-token policy. */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "d2444aa24277a9f0a0234c11b0f74c08debbb309e0afb4e20f6ebe46";

/** `eligibility.eligibility` — eligibility-token policy and registry address. */
export const TESSERA_ELIGIBILITY_BLUEPRINT_HASH =
  "0df1e0a18ecb57fc4848ed0daed759bee3394dc9d21e070dd2d109a7";
