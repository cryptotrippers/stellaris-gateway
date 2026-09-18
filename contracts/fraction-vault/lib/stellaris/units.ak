//// Deposit-unit helpers for the multi-asset vault.
////
//// A vault instance is parameterised by a single deposit UNIT — a
//// `(policy_id, asset_name)` pair. ADA is expressed the same way, as the
//// empty policy with the empty name, so every rule below is written once and
//// works for both ADA and native tokens (USDr, USDM, iUSD, …).
////
//// Two invariants make multi-asset custody safe:
////
////   1. every UTxO returned to the script may carry ONLY lovelace and the
////      deposit unit — arbitrary token dust would inflate min-ADA until the
////      accounted balance can no longer be paid out (token-flood lock);
////   2. when the unit is a native token, each UTxO must still carry a
////      lovelace rider so it satisfies Cardano's min-ADA rule; that rider is
////      NOT part of the accounted balance and is returned with the position.

use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId, Value}

/// The ADA "policy" — the empty byte string. A vault parameterised with this
/// policy is denominated in lovelace.
pub const ada_policy: PolicyId = #""

/// Lovelace every script UTxO must carry so it satisfies min-ADA. For a
/// token-denominated vault this is a rider held alongside the tokens.
pub const min_rider_lovelace: Int = 2_000_000

/// Is this vault denominated in ADA rather than a native token?
pub fn is_ada(policy: PolicyId) -> Bool {
  policy == ada_policy
}

/// Quantity of the deposit unit held in `value`.
pub fn unit_of(value: Value, policy: PolicyId, name: ByteArray) -> Int {
  assets.quantity_of(value, policy, name)
}

/// `value` holds nothing except lovelace and the deposit unit.
pub fn value_clean(value: Value, policy: PolicyId, name: ByteArray) -> Bool {
  let extras =
    list.filter(
      dict.to_pairs(assets.to_dict(value)),
      fn(entry) {
        let Pair(pid, tokens) = entry
        if pid == assets.ada_policy_id {
          False
        } else if pid == policy {
          // Only the configured token name may appear under the unit policy.
          list.any(
            dict.to_pairs(tokens),
            fn(t) {
              let Pair(tn, qty) = t
              tn != name && qty != 0
            },
          )
        } else {
          True
        }
      },
    )
  extras == []
}

/// Does this UTxO carry enough lovelace to be spendable on chain?
pub fn rider_ok(value: Value) -> Bool {
  assets.lovelace_of(value) >= min_rider_lovelace
}

/// Sum of the deposit unit across a list of values.
pub fn unit_sum(values: List<Value>, policy: PolicyId, name: ByteArray) -> Int {
  list.foldr(values, 0, fn(v, acc) { acc + unit_of(v, policy, name) })
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const usdr_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const other_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

test ada_unit_reads_lovelace() {
  unit_of(assets.from_lovelace(5_000_000), ada_policy, #"") == 5_000_000
}

test token_unit_reads_the_token_quantity() {
  let v =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(usdr_policy, "USDR", 42),
    )
  unit_of(v, usdr_policy, "USDR") == 42 && unit_of(v, ada_policy, #"") == 2_000_000
}

test pure_ada_value_is_clean_for_an_ada_vault() {
  value_clean(assets.from_lovelace(10_000_000), ada_policy, #"")
}

test token_plus_rider_is_clean() {
  let v =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(usdr_policy, "USDR", 100),
    )
  value_clean(v, usdr_policy, "USDR")
}

test foreign_token_is_rejected() {
  let v =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(other_policy, "JUNK", 1),
    )
  !value_clean(v, usdr_policy, "USDR")
}

test wrong_token_name_under_the_unit_policy_is_rejected() {
  let v =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(usdr_policy, "NOTUSDR", 1),
    )
  !value_clean(v, usdr_policy, "USDR")
}

test rider_below_min_ada_is_rejected() {
  !rider_ok(assets.from_lovelace(1_999_999)) && rider_ok(assets.from_lovelace(2_000_000))
}

test unit_sum_adds_across_utxos() {
  let a = assets.from_asset(usdr_policy, "USDR", 10)
  let b = assets.from_asset(usdr_policy, "USDR", 32)
  unit_sum([a, b], usdr_policy, "USDR") == 42
}
