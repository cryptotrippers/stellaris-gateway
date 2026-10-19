//// The first-loss reserve's State datum and lookups (Phase 2.5b, SPEC.md
//// §3a.1), shared by `validators/first_loss.ak` and the vault, which reads and
//// checks it in `ReportYield`, `ReportLoss` and the last-exit sweep.
////
//// The genuine first-loss State is the one UTxO carrying the `state` thread
//// token (`stellaris/thread.thread_name`) under the first-loss script's own
//// policy, at that script's address, with an inline `FirstLossState`.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{InlineDatum, Output, Transaction}
use stellaris/thread.{thread_name}

pub type FirstLossState {
  /// TSRA the UTxO holds (besides ADA and the thread token), exactly.
  balance: Int,
  /// Monotonic replay counter.
  epoch: Int,
}

/// The FirstLossState of the one output among `outs` that holds the thread
/// token of `policy` at `policy`'s address; `None` for a missing, duplicated,
/// planted (no token) or misplaced one.
pub fn first_loss_among(outs: List<Output>, policy: PolicyId) -> Option<FirstLossState> {
  let marked =
    outs |> list.filter(fn(o) { quantity_of(o.value, policy, thread_name) == 1 })
  when marked is {
    [o] ->
      if o.address.payment_credential == Script(policy) {
        when o.datum is {
          InlineDatum(d) ->
            if d is s: FirstLossState {
              Some(s)
            } else {
              None
            }
          _ -> None
        }
      } else {
        None
      }
    _ -> None
  }
}

/// The first-loss State being spent.
pub fn first_loss_spent(tx: Transaction, policy: PolicyId) -> Option<FirstLossState> {
  first_loss_among(list.map(tx.inputs, fn(i) { i.output }), policy)
}

/// The first-loss State as a reference input.
pub fn first_loss_ref(tx: Transaction, policy: PolicyId) -> Option<FirstLossState> {
  first_loss_among(list.map(tx.reference_inputs, fn(i) { i.output }), policy)
}

/// The first-loss State the transaction returns.
pub fn first_loss_returned(tx: Transaction, policy: PolicyId) -> Option<FirstLossState> {
  first_loss_among(tx.outputs, policy)
}

/// The balance a transaction can see: the spent State's if it spends it,
/// otherwise the referenced State's. `None` if neither.
pub fn first_loss_balance(tx: Transaction, policy: PolicyId) -> Option<Int> {
  when first_loss_spent(tx, policy) is {
    Some(s) -> Some(s.balance)
    None ->
      when first_loss_ref(tx, policy) is {
        Some(s) -> Some(s.balance)
        None -> None
      }
  }
}

/// The transaction moves the first-loss balance from `before` to `after`: it
/// spends the genuine State and returns it with the new balance. (The
/// first-loss validator, which runs for that input, checks the TSRA actually
/// moved and who may do it.)
pub fn first_loss_moves(
  tx: Transaction,
  policy: PolicyId,
  before: Int,
  after: Int,
) -> Bool {
  when (first_loss_spent(tx, policy), first_loss_returned(tx, policy)) is {
    (Some(a), Some(b)) -> a.balance == before && b.balance == after
    _ -> False
  }
}
