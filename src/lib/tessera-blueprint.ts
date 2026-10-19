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
 * Phase 2.4: `stsra_vault.ak` (sTSRA vault State, Positions, Tickets and the
 * sTSRA / marker policy) is parameterised by its seed UTxO and the applied
 * reserve script hash.
 */

/** `reserve.reserve` — Reserve State spend + TSRA and thread-token policy. */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "813f72527045fc82ceda7527a4488f78a1de64369739e72ff7f691f7";

/** `eligibility.eligibility` — eligibility-token policy and registry address. */
export const TESSERA_ELIGIBILITY_BLUEPRINT_HASH =
  "c2f2f6fdc62456bd7ce30f521425aa27025d8427d975350f0db7050f";

/** `stsra_vault.stsra_vault` — sTSRA vault spend + sTSRA and thread/marker policy. */
export const TESSERA_STSRA_VAULT_BLUEPRINT_HASH =
  "fc355a5ec275d1cbadf96defe83b1eb5d9af8d267fba0554e56d391d";
