//// fraction_vault v2 — the default fraction policy (SPEC-v2.md §3).
////
//// Derived, never authoritative: the policy reads the genuine State before
//// and after this transaction and allows exactly the change in
//// `outstanding` to be minted (`Settle`) or burned (`RefundFraction`,
//// `Redeem`), under one token name — the asset id. The State makes the same
//// check from its side (invariant 3), so the two are bound both ways.
////
//// The State must name THIS policy as its `fraction_policy`; an offering
//// that names another policy cannot drive this one.

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Output, Transaction}
use stellaris/fv2.{OfferingV2}
use stellaris/thread.{holds_thread}

fn state_of(o: Output) -> OfferingV2 {
  expect InlineDatum(raw) = o.datum
  expect d: OfferingV2 = raw
  d
}

validator fraction_v2(offering_hash: ByteArray, asset_id: ByteArray) {
  mint(_redeemer: Data, own: PolicyId, tx: Transaction) {
    let genuine =
      fn(o: Output) {
        o.address.payment_credential == Script(offering_hash) && holds_thread(
          o.value,
          offering_hash,
        )
      }
    expect Some(before_in) = list.find(tx.inputs, fn(i) { genuine(i.output) })
    expect [after_out] = list.filter(tx.outputs, genuine)
    let before = state_of(before_in.output)
    let after = state_of(after_out)
    let delta = after.book.outstanding - before.book.outstanding
    and {
      before.terms.fraction_policy == own,
      delta != 0,
      dict.to_pairs(assets.tokens(tx.mint, own)) == [Pair(asset_id, delta)],
    }
  }

  else(_) {
    fail
  }
}
