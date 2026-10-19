/**
 * Pinned (unapplied) blueprint hashes for the Tessera contracts in
 * `contracts/tessera/plutus.json`. `scripts/verify-vault-hash.mjs` (run in CI)
 * fails the build if a fresh `aiken build` no longer matches them.
 *
 * Pins only: there is no Tessera off-chain code yet (Phase 4), and the
 * `ConfigState` / `SupplyState` datums are provisional until counsel answers (SPEC.md §1), so
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
 * Phase 2.5a: the Reserve State is split into a Config UTxO (committee,
 * switches) and a Supply UTxO (the hot books), each with its own thread token
 * (`config`, `supply`). The reserve, eligibility and vault hashes all moved;
 * the eligibility registry and the vault now read the Config by reference.
 */

/** `reserve.reserve` — Reserve Config + Supply spend, TSRA and thread-token policy. */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "77afe2d850d3b2758db92d73ff7e35ba7e28b0458c0d56a716eb5e10";

/** `eligibility.eligibility` — eligibility-token policy and registry address. */
export const TESSERA_ELIGIBILITY_BLUEPRINT_HASH =
  "67245ef1c8a1018ca860207aad2b0eb76d169fa1fe70d52da091b1ed";

/** `stsra_vault.stsra_vault` — sTSRA vault spend + sTSRA and thread/marker policy. */
export const TESSERA_STSRA_VAULT_BLUEPRINT_HASH =
  "374489919b587316c76b604dafb947b4256f6a4c24a7af8385ba079e";
