//// The genuine Reserve State as a reference input (Phase 2.4).
////
//// Vault actions that need the committee or a KYC switch read the reserve's
//// current State instead of a copy, so a reserve `Rotate` or `SetKyc` applies
//// at once (SPEC.md §3.1, D-6). `validators/eligibility.ak` (2.3) keeps its
//// own copy of this lookup so its hash is unchanged.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{InlineDatum, Transaction}
use stellaris/thread.{thread_name}
use tessera/reserve_state.{ReserveState}

/// The ReserveState of the one reference input that holds the reserve's
/// thread token at the reserve address. `None` for a missing, duplicated,
/// planted (no token) or misplaced State.
pub fn genuine_reserve(tx: Transaction, reserve: PolicyId) -> Option<ReserveState> {
  let states =
    tx.reference_inputs
      |> list.filter(
          fn(i) { quantity_of(i.output.value, reserve, thread_name) == 1 },
        )
  when states is {
    [s] ->
      if s.output.address.payment_credential == Script(reserve) {
        when s.output.datum is {
          InlineDatum(d) ->
            if d is st: ReserveState {
              Some(st)
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
