//// The genuine Reserve Config as a reference input (Phase 2.4, split in 2.5a).
////
//// Vault actions that need the committee or a KYC switch read the reserve's
//// current Config instead of a copy, so a reserve `Rotate` or `SetKyc` applies
//// at once (SPEC.md §3.1, D-6). The Config is spent only by committee actions,
//// not by every TSRA mint or burn, so an in-flight vault transaction is not
//// invalidated by supply traffic. `validators/eligibility.ak` (2.3) keeps its
//// own copy of this lookup.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{InlineDatum, Transaction}
use tessera/reserve_state.{ConfigDatum, ConfigState, ReserveDatum}
use tessera/reserve_threads.{config_name}

/// The ConfigState of the one reference input that holds the reserve's
/// `config` token at the reserve address. `None` for a missing, duplicated,
/// planted (no token), misplaced or wrong-kind (a Supply datum) Config.
pub fn genuine_config(tx: Transaction, reserve: PolicyId) -> Option<ConfigState> {
  let states =
    tx.reference_inputs
      |> list.filter(
          fn(i) { quantity_of(i.output.value, reserve, config_name) == 1 },
        )
  when states is {
    [s] ->
      if s.output.address.payment_credential == Script(reserve) {
        when s.output.datum is {
          InlineDatum(d) ->
            if d is ConfigDatum(st): ReserveDatum {
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
