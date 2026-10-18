/**
 * Pinned (unapplied) blueprint hash for the Tessera contract in
 * `contracts/tessera/plutus.json`. `scripts/verify-vault-hash.mjs` (run in CI)
 * fails the build if a fresh `aiken build` no longer matches it.
 *
 * Pins only: there is no Tessera off-chain code yet (Phase 4), and the
 * `ReserveState` datum is provisional until counsel answers (SPEC.md §1), so
 * nothing may bootstrap or derive an address against this hash.
 *
 * Phase 2.2: `reserve.ak` mints its own state-thread token and checks the
 * genesis State on-chain, so the separate `state_nft.ak` (and its pin) is
 * retired. The script is parameterised by the bootstrap seed UTxO.
 */

/** `reserve.reserve` — Reserve State spend + TSRA and thread-token policy. */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "708957b6d06783c47bac49a5252828b92f3c1a690fa6dd101abaed84";
