//// Pure rules for the Tessera reserve gate. No transaction or datum access,
//// so every rule is unit-testable on its own.
////
//// Units: TSRA quantities are in 1e-6 TSRA, matching Cardano native-asset
//// integers. Times are POSIX milliseconds, as in a transaction validity range.

/// Asset name of the TSRA token minted under the reserve script's policy.
pub const tsra_name: ByteArray = "TSRA"

// The genuine Reserve State is marked by the state-thread token
// (`stellaris/thread.thread_name`, "state") under this same policy.

/// Hard minimum committee threshold: never a single key. (Proposed launch
/// committee: 3-of-5, a bootstrap parameter.)
pub const min_threshold: Int = 2

/// Hard ceiling on `mint_cap`: 1,000,000,000 TSRA (6 decimals, so 1e15 units).
/// Raising it needs a new script, not a committee vote. The committee sets the
/// working cap below it (proposed genesis `mint_cap`: 5,000,000 TSRA, a
/// bootstrap parameter, not a validator constant).
pub const max_mint_cap: Int = 1_000_000_000_000_000

/// A reserve attestation older than this blocks new minting: 7 days.
pub const max_attestation_age: Int = 604_800_000

/// An attestation transaction's validity range may span at most 1 day, so the
/// recorded `attested_at` is within a day of real time.
pub const max_attest_window: Int = 86_400_000

/// Minting `qty` more TSRA is allowed only while total minted supply stays at
/// or below BOTH the attested reserve and the committee's mint cap.
pub fn mint_allowed(
  minted_supply: Int,
  qty: Int,
  attested_reserve: Int,
  mint_cap: Int,
) -> Bool {
  qty > 0 && minted_supply + qty <= attested_reserve && minted_supply + qty <= mint_cap
}

/// The transaction must be over by the time the attestation goes stale.
pub fn fresh(upper_bound: Int, attested_at: Int) -> Bool {
  upper_bound <= attested_at + max_attestation_age
}

/// A new attestation anchors at the validity lower bound `lo`, must not go
/// backwards, and must come from a bounded validity range.
pub fn window_ok(lo: Int, hi: Int, previous_attested_at: Int) -> Bool {
  lo >= previous_attested_at && hi >= lo && hi - lo <= max_attest_window
}

// ------------------------------------------------------------------ tests

test mint_up_to_reserve_is_allowed() {
  mint_allowed(0, 100, 100, 1_000)
}

test mint_above_attested_reserve_is_rejected() {
  !mint_allowed(0, 101, 100, 1_000)
}

test mint_above_cap_is_rejected() {
  !mint_allowed(50, 51, 1_000, 100)
}

test mint_counts_existing_supply() {
  !mint_allowed(90, 11, 100, 1_000)
}

test zero_or_negative_mint_is_rejected() {
  !mint_allowed(0, 0, 100, 100) && !mint_allowed(0, -1, 100, 100)
}

test attestation_goes_stale_after_seven_days() {
  fresh(1_000 + max_attestation_age, 1_000) && !fresh(1_001 + max_attestation_age, 1_000)
}

test attestation_cannot_go_backwards() {
  window_ok(2_000, 3_000, 2_000) && !window_ok(1_999, 3_000, 2_000)
}

test attestation_window_is_bounded() {
  window_ok(0, max_attest_window, 0) && !window_ok(0, max_attest_window + 1, 0)
}

test inverted_window_is_rejected() {
  !window_ok(3_000, 2_000, 0)
}

test the_mint_cap_ceiling_is_one_billion_tsra() {
  // 1,000,000,000 TSRA at 6 decimals; changing it moves the script hash
  max_mint_cap == 1_000_000_000 * 1_000_000
}
