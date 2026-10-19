//// The genuine Reserve Config and Supply as seen from another script (Phase
//// 2.4, split in 2.5a, loss path in 2.5b).
////
//// Vault actions that need the committee or a KYC switch read the reserve's
//// current Config instead of a copy, so a reserve `Rotate` or `SetKyc` applies
//// at once (SPEC.md §3.1, D-6). The Config is spent only by committee actions
//// and `LossBurn`, not by every TSRA mint or burn, so an in-flight vault
//// transaction is not invalidated by supply traffic. `validators/eligibility.ak`
//// (2.3) keeps its own copy of the Config lookup.
////
//// Three views:
//// * by reference (`genuine_config`, `genuine_supply`): exits, stakes,
////   `VaultClaimBurn`'s `vault_policy`, the 3% cap;
//// * spent (`spent_config`, `spent_supply`): `ReportLoss`, which spends both
////   and checks the datums the reserve moves them to.

use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use tessera/reserve_state.{
  ConfigDatum, ConfigState, ReserveDatum, SupplyDatum, SupplyState,
}
use tessera/reserve_threads.{config_name, supply_name}

/// The one output among `outs` holding thread token `name` (exactly one unit)
/// at the reserve address with an inline `ReserveDatum`. `None` for a missing,
/// duplicated, planted (no token), misplaced or datum-less one.
fn sole_reserve_datum(
  outs: List<Output>,
  reserve: PolicyId,
  name: ByteArray,
) -> Option<ReserveDatum> {
  let states =
    outs |> list.filter(fn(o) { quantity_of(o.value, reserve, name) == 1 })
  when states is {
    [s] ->
      if s.address.payment_credential == Script(reserve) {
        when s.datum is {
          InlineDatum(d) ->
            if d is r: ReserveDatum {
              Some(r)
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

/// The ConfigState among `outs` (wrong-kind datums are not a Config).
pub fn config_among(outs: List<Output>, reserve: PolicyId) -> Option<ConfigState> {
  when sole_reserve_datum(outs, reserve, config_name) is {
    Some(ConfigDatum(c)) -> Some(c)
    _ -> None
  }
}

/// The SupplyState among `outs`.
pub fn supply_among(outs: List<Output>, reserve: PolicyId) -> Option<SupplyState> {
  when sole_reserve_datum(outs, reserve, supply_name) is {
    Some(SupplyDatum(s)) -> Some(s)
    _ -> None
  }
}

fn outputs_of(inputs: List<Input>) -> List<Output> {
  list.map(inputs, fn(i) { i.output })
}

/// The ConfigState of the one reference input that holds the reserve's
/// `config` token at the reserve address. `None` for a missing, duplicated,
/// planted (no token), misplaced or wrong-kind (a Supply datum) Config.
pub fn genuine_config(tx: Transaction, reserve: PolicyId) -> Option<ConfigState> {
  config_among(outputs_of(tx.reference_inputs), reserve)
}

/// The SupplyState of the one reference input that holds the `supply` token
/// (the 3% first-loss cap reads `minted_supply` from it).
pub fn genuine_supply(tx: Transaction, reserve: PolicyId) -> Option<SupplyState> {
  supply_among(outputs_of(tx.reference_inputs), reserve)
}

/// The Config being SPENT and the Config it is returned as (`ReportLoss`).
pub fn spent_config(
  tx: Transaction,
  reserve: PolicyId,
) -> Option<(ConfigState, ConfigState)> {
  when
    (
      config_among(outputs_of(tx.inputs), reserve),
      config_among(tx.outputs, reserve),
    )
  is {
    (Some(c0), Some(c1)) -> Some((c0, c1))
    _ -> None
  }
}

/// The Supply being SPENT and the Supply it is returned as.
pub fn spent_supply(
  tx: Transaction,
  reserve: PolicyId,
) -> Option<(SupplyState, SupplyState)> {
  when
    (
      supply_among(outputs_of(tx.inputs), reserve),
      supply_among(tx.outputs, reserve),
    )
  is {
    (Some(s0), Some(s1)) -> Some((s0, s1))
    _ -> None
  }
}
