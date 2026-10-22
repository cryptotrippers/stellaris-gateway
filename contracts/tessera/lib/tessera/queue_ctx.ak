//// Transaction-side helpers shared by the queue scripts (Phase 2.6).
////
//// Selecting the genuine queue UTxOs: the Config and ShortState by their
//// thread tokens, the Buffer shards by their `shard<i>` tokens, Requests by
//// the `request` marker. A datum anyone pays to the queue address without
//// the token is never trusted.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value, quantity_of}
use cardano/transaction.{InlineDatum, Output, Transaction}
use stellaris/outputs.{continuing_ok}
use tessera/queue_state.{
  Config, Grace, GraceState, QueueConfig, QueueDatum, Short, ShortState,
  config_name, short_name,
}

/// (lower, upper) finite validity bounds, if both exist.
pub fn finite_bounds(tx: Transaction) -> Option<(Int, Int)> {
  when
    (
      tx.validity_range.lower_bound.bound_type,
      tx.validity_range.upper_bound.bound_type,
    )
  is {
    (Finite(lo), Finite(hi)) -> Some((lo, hi))
    _ -> None
  }
}

pub fn at_q(o: Output, q: PolicyId) -> Bool {
  o.address.payment_credential == Script(q)
}

pub fn q_ins(tx: Transaction, q: PolicyId) -> List<Output> {
  tx.inputs
    |> list.filter_map(
        fn(i) {
          if at_q(i.output, q) {
            Some(i.output)
          } else {
            None
          }
        },
      )
}

pub fn q_outs(tx: Transaction, q: PolicyId) -> List<Output> {
  tx.outputs |> list.filter(fn(o) { at_q(o, q) })
}

/// The inline `QueueDatum` of a queue UTxO. A queue-address UTxO whose datum
/// is missing or malformed fails the transaction that spends it (it could
/// never be anything the scripts understand).
pub fn datum_of(o: Output) -> QueueDatum {
  expect InlineDatum(d) = o.datum
  expect q: QueueDatum = d
  q
}

/// The one output among `outs` that carries thread token `name` under `q`
/// at the queue address, with its datum. `None` if missing or duplicated.
pub fn thread_among(
  outs: List<Output>,
  q: PolicyId,
  name: ByteArray,
) -> Option<(Output, QueueDatum)> {
  when
    outs
      |> list.filter(fn(o) { at_q(o, q) && quantity_of(o.value, q, name) == 1 })
  is {
    [o] ->
      when o.datum is {
        InlineDatum(d) ->
          if d is qd: QueueDatum {
            Some((o, qd))
          } else {
            None
          }
        _ -> None
      }
    _ -> None
  }
}

fn ref_outs(tx: Transaction) -> List<Output> {
  list.map(tx.reference_inputs, fn(i) { i.output })
}

/// The genuine QueueConfig among reference inputs.
pub fn config_ref(tx: Transaction, q: PolicyId) -> Option<QueueConfig> {
  when thread_among(ref_outs(tx), q, config_name) is {
    Some((_, Config(c))) -> Some(c)
    _ -> None
  }
}

/// The genuine ShortState among reference inputs.
pub fn short_ref(tx: Transaction, q: PolicyId) -> Option<ShortState> {
  when thread_among(ref_outs(tx), q, short_name) is {
    Some((_, Short(s))) -> Some(s)
    _ -> None
  }
}

/// Short mode is not active (read by reference; the genuine ShortState must be
/// present). Normal settlement and instant redemption require it.
pub fn short_inactive(tx: Transaction, q: PolicyId) -> Bool {
  when short_ref(tx, q) is {
    Some(s) -> !s.active
    None -> False
  }
}

/// A referenced Grace for `holder` valid until at least `hi`.
pub fn grace_valid(tx: Transaction, q: PolicyId, holder: ByteArray, hi: Int) -> Bool {
  list.any(
    ref_outs(tx),
    fn(o) {
      at_q(o, q) && quantity_of(o.value, q, holder) == 1 && when o.datum is {
        InlineDatum(d) ->
          if d is g: QueueDatum {
            when g is {
              Grace(GraceState { until }) -> until >= hi
              _ -> False
            }
          } else {
            False
          }
        _ -> False
      }
    },
  )
}

/// The shard index named by the single `shard<i>` token an output carries
/// under `q`; `None` if it carries none, several, or a foreign name.
pub fn shard_index(o: Output, q: PolicyId) -> Option<Int> {
  when dict.to_pairs(assets.tokens(o.value, q)) is {
    [Pair(name, 1)] ->
      if bytearray.length(name) == 6 && bytearray.take(name, 5) == "shard" {
        Some(bytearray.at(name, 5))
      } else {
        None
      }
    _ -> None
  }
}

pub fn is_empty_mint(tx: Transaction, q: PolicyId) -> Bool {
  dict.is_empty(assets.tokens(tx.mint, q))
}

pub fn tsra_of(v: Value, reserve: PolicyId, name: ByteArray) -> Int {
  quantity_of(v, reserve, name)
}

/// A thread UTxO (`name`) spent and its continuing output: the old and the new
/// datum. The output keeps the exact address, no reference script and exactly
/// the input's value; the caller checks what the datum may change.
pub fn step(
  tx: Transaction,
  q: PolicyId,
  name: ByteArray,
) -> Option<(QueueDatum, QueueDatum)> {
  when
    (
      thread_among(list.map(tx.inputs, fn(i) { i.output }), q, name),
      thread_among(tx.outputs, q, name),
    )
  is {
    (Some((i, d0)), Some((o, d1))) ->
      if continuing_ok(o, i) && o.value == i.value {
        Some((d0, d1))
      } else {
        None
      }
    _ -> None
  }
}
