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
 * Phase 2.5b: the loss path. `first_loss.ak` (the first-loss reserve State,
 * parameterised by its seed UTxO and the applied reserve script hash) is new;
 * the Config gains `vault_policy` and `loss_pending_until`; the reserve gains
 * `OpenLoss`, `CancelLoss`, `SetVault`, `LossBurn` and `VaultClaimBurn`; the
 * vault gains `ReportLoss`, `ticket_escrow`, the freeze and class generations.
 * The reserve, eligibility (it decodes the grown Config) and vault hashes all
 * moved again.
 * Phase 2.5b (size): the compiled vault exceeded the 16,384-byte transaction
 * limit, so ReportLoss, ReportYield, SetBounds and the State side of Claim moved
 * into `vault_ops.ak`, a withdraw-zero script. The vault is now parameterised
 * by `(seed, reserve, ops)`; `vault_ops` by the reserve only. `verify-vault-hash`
 * fails any validator above 14,000 bytes.
 */

/** `reserve.reserve` — Reserve Config + Supply spend, TSRA and thread-token policy. */
export const TESSERA_RESERVE_BLUEPRINT_HASH =
  "3f400bf99c0a201244ae3eac4de984e887c71aed810efbe0beb0e04f";

/** `eligibility.eligibility` — eligibility-token policy and registry address. */
export const TESSERA_ELIGIBILITY_BLUEPRINT_HASH =
  "00ccffe5602eaa5781711ed3bb8a01ee37533a412296671b991e7675";

/** `stsra_vault.stsra_vault` — sTSRA vault spend + sTSRA and thread/marker policy. */
export const TESSERA_STSRA_VAULT_BLUEPRINT_HASH =
  "5d4a3dea9f930178b9470ab17f06d6e9a43a7f707c15998f74917263";

/**
 * `vault_ops.vault_ops` — withdraw-zero script validating the vault's
 * `ReportLoss`, `ReportYield`, `SetBounds` and the State side of `Claim`
 * (Phase 2.5b). Its stake credential must be registered; the script accepts no
 * other certificate.
 */
export const TESSERA_VAULT_OPS_BLUEPRINT_HASH =
  "0657e0a1651728cab5f3bc7da358366dacf80c9a4bc85160a8a2d235";

/** `first_loss.first_loss` — first-loss reserve State spend + its thread-token policy. */
export const TESSERA_FIRST_LOSS_BLUEPRINT_HASH =
  "24f5bb9314790130530291ba6e04f9f1084c921bcd614034a1b7c4bf";
