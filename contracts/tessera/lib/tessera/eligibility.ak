//// The one eligibility check (Phase 2.3). Mint, redeem and stake call only
//// `eligible`, so the launch implementation — a committee-issued allowlist
//// token (`validators/eligibility.ak`) — can later be replaced by a Midnight
//// zero-knowledge credential by changing this module alone. (Any change here
//// still moves the hash of every script that calls it.)

use aiken/collection/list
use cardano/address
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

/// `holder` (a payment key hash) is eligible in `tx` under `policy` when:
///   (a) `holder` signed the transaction, and
///   (b) a reference input or spent input holds exactly one eligibility token
///       of `policy` named `holder`.
/// (a) stops anyone using another holder's token; (b) is the allowlist.
pub fn eligible(tx: Transaction, policy: PolicyId, holder: ByteArray) -> Bool {
  list.has(tx.extra_signatories, holder) && (holds_token(
    tx.reference_inputs,
    policy,
    holder,
  ) || holds_token(tx.inputs, policy, holder))
}

fn holds_token(inputs: List<Input>, policy: PolicyId, holder: ByteArray) -> Bool {
  list.any(inputs, fn(i) { quantity_of(i.output.value, policy, holder) == 1 })
}

// ------------------------------------------------------------------ tests

const t_policy: PolicyId =
  #"55555555555555555555555555555555555555555555555555555555"

const t_alice: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const t_bob: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

fn t_in(value: assets.Value) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0909090909090909090909090909090909090909090909090909090909090909",
      output_index: 0,
    },
    output: Output {
      address: address.from_script(t_policy),
      value: assets.from_lovelace(2_000_000) |> assets.merge(value),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn token(name: ByteArray, qty: Int) -> assets.Value {
  assets.from_asset(t_policy, name, qty)
}

test signer_with_a_referenced_token_is_eligible() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [t_in(token(t_alice, 1))],
      extra_signatories: [t_alice],
    }
  eligible(tx, t_policy, t_alice)
}

test signer_with_a_spent_token_is_eligible() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [t_in(token(t_alice, 1))],
      extra_signatories: [t_alice],
    }
  eligible(tx, t_policy, t_alice)
}

test token_without_the_holders_signature_is_not_eligible() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [t_in(token(t_alice, 1))],
      extra_signatories: [t_bob],
    }
  !eligible(tx, t_policy, t_alice)
}

test another_holders_token_is_not_eligible() {
  // bob signs and references alice's token
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [t_in(token(t_alice, 1))],
      extra_signatories: [t_bob],
    }
  !eligible(tx, t_policy, t_bob)
}

test signer_without_any_token_is_not_eligible() {
  let tx = Transaction { ..placeholder, extra_signatories: [t_alice] }
  !eligible(tx, t_policy, t_alice)
}

test a_token_under_another_policy_is_not_eligible() {
  let other =
    assets.from_asset(
      #"66666666666666666666666666666666666666666666666666666666",
      t_alice,
      1,
    )
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [t_in(other)],
      extra_signatories: [t_alice],
    }
  !eligible(tx, t_policy, t_alice)
}

test exactly_one_token_is_required() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [t_in(token(t_alice, 2))],
      extra_signatories: [t_alice],
    }
  !eligible(tx, t_policy, t_alice)
}
