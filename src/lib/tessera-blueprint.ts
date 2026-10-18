/**
 * Pinned (unapplied) blueprint hashes for the Tessera contracts in
 * `contracts/tessera/plutus.json`. `scripts/verify-vault-hash.mjs` (run in CI)
 * fails the build if a fresh `aiken build` no longer matches these.
 *
 * Pins only: there is no Tessera off-chain code yet (Phase 4), and the
 * `ReserveState` datum is provisional until counsel answers (SPEC.md §1), so
 * nothing may bootstrap or derive an address against these hashes.
 */

/** `reserve.reserve` — Reserve State spend + TSRA mint policy (one script). */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "dd3b581659a694e4c3055f63e87485850985ec4e7785ed440b7ff7bf";

/** `state_nft.state_nft` — one-shot NFT marking the genuine Reserve State. */
export const TESSERA_STATE_NFT_BLUEPRINT_HASH =
  "cccbc1ac654756a99a68796013a5f119d238dac99276d8b4d26fa341";
