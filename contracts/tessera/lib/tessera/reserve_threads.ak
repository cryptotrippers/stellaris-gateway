//// The Reserve State's two thread tokens (Phase 2.5a).
////
//// Same idea as `stellaris/thread.ak` (a one-shot token under the validator's
//// own policy marks the genuine UTxO), but the reserve has two genuine UTxOs,
//// so two names: `config` and `supply`. Both are minted exactly once, in the
//// genesis transaction, and never again or burned (`validators/reserve.ak`).
//// Kept out of `stellaris/thread.ak`, whose copies must stay byte-identical
//// across the four Aiken projects.

use cardano/assets.{PolicyId, Value}

pub const config_name: ByteArray = "config"

pub const supply_name: ByteArray = "supply"

/// The exact non-ADA value the Config UTxO carries: one `config` token.
pub fn config_value(policy: PolicyId) -> Value {
  assets.from_asset(policy, config_name, 1)
}

/// The exact non-ADA value the Supply UTxO carries: one `supply` token.
pub fn supply_value(policy: PolicyId) -> Value {
  assets.from_asset(policy, supply_name, 1)
}
