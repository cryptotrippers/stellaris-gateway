//// State-thread token (Phase 1, AUDIT.md F-1).
////
//// A shared-State validator cannot tell its genuine State UTxO from a
//// State-shaped datum anyone paid to the same address: paying to a script
//// never runs it. Without an on-chain identity, a planted State can be spent
//// ALONE (the sole-State rule only forbids spending two together) and used to
//// mint shares at a price the attacker chose, which are then redeemed against
//// the genuine State.
////
//// The fix is a one-shot NFT. The validator is parameterised by a `seed`
//// OutputReference and doubles as the NFT's minting policy (same script
//// hash). The mint handler requires `seed` to be consumed, so the token can be
//// minted at most once, ever; it can never be burned. Every State transition
//// then requires the spent State AND the returned State to carry it, so a
//// State without the token can never be spent at all.
////
//// This module is duplicated verbatim in each Aiken project that uses it
//// (Aiken projects cannot share a lib). Keep the copies identical.

use aiken/collection/dict
use aiken/collection/list
use cardano/address
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

/// Asset name of the state-thread token, under the validator's own policy.
pub const thread_name: ByteArray = "state"

/// The exact non-ADA value a State UTxO must carry: one thread token.
pub fn thread_value(policy: PolicyId) -> Value {
  assets.from_asset(policy, thread_name, 1)
}

/// True iff `value` holds exactly one thread token of `policy`.
pub fn holds_thread(value: Value, policy: PolicyId) -> Bool {
  assets.quantity_of(value, policy, thread_name) == 1
}

/// True iff `seed` is among the transaction's inputs.
pub fn seed_spent(inputs: List<Input>, seed: OutputReference) -> Bool {
  list.any(inputs, fn(i) { i.output_reference == seed })
}

/// The mint-side rule shared by every thread policy: under `policy` this
/// transaction mints exactly one unit of `thread_name` and nothing else, and
/// it consumes `seed`. Burning (a negative quantity) never satisfies it.
pub fn one_shot_mint(
  tx: Transaction,
  policy: PolicyId,
  seed: OutputReference,
) -> Bool {
  when dict.to_pairs(assets.tokens(tx.mint, policy)) is {
    [Pair(name, qty)] ->
      name == thread_name && qty == 1 && seed_spent(tx.inputs, seed)
    _ -> False
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const t_policy: PolicyId =
  #"44444444444444444444444444444444444444444444444444444444"

fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 3,
  }
}

fn t_input(r: OutputReference) -> Input {
  Input {
    output_reference: r,
    output: Output {
      address: address.from_verification_key(
        #"11111111111111111111111111111111111111111111111111111111",
      ),
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn t_tx(inputs: List<Input>, mint: Value) -> Transaction {
  Transaction { ..placeholder, inputs, mint }
}

test one_shot_mint_needs_the_seed() {
  let other = OutputReference { ..t_seed(), output_index: 4 }
  one_shot_mint(
    t_tx([t_input(t_seed())], thread_value(t_policy)),
    t_policy,
    t_seed(),
  ) && !one_shot_mint(
    t_tx([t_input(other)], thread_value(t_policy)),
    t_policy,
    t_seed(),
  )
}

test one_shot_mint_is_exactly_one_token() {
  let two = assets.from_asset(t_policy, thread_name, 2)
  let extra = assets.merge(
    thread_value(t_policy),
    assets.from_asset(t_policy, "x", 1),
  )
  !one_shot_mint(t_tx([t_input(t_seed())], two), t_policy, t_seed()) && !one_shot_mint(
    t_tx([t_input(t_seed())], extra),
    t_policy,
    t_seed(),
  )
}

test thread_token_can_never_be_burned() {
  let burn = assets.from_asset(t_policy, thread_name, -1)
  !one_shot_mint(t_tx([t_input(t_seed())], burn), t_policy, t_seed())
}

test holds_thread_is_exact() {
  holds_thread(
    assets.merge(assets.from_lovelace(2_000_000), thread_value(t_policy)),
    t_policy,
  ) && !holds_thread(assets.from_lovelace(2_000_000), t_policy) && !holds_thread(
    assets.from_asset(t_policy, thread_name, 2),
    t_policy,
  )
}
