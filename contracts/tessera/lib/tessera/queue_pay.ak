//// Paying out of a Buffer shard (Phase 2.6): shared by `queue_flow` (normal
//// `Settle`, `Instant`) and `queue_short` (`PayShort`), which move TSRA into a
//// Sink and pay `payout_to` from one shard under identical rules.

use aiken/collection/list
use cardano/assets.{PolicyId, flatten, from_asset, lovelace_of, merge, quantity_of}
use cardano/transaction.{Output}
use stellaris/outputs.{continuing_ok, script_address}
use tessera/queue_ctx.{datum_of}
use tessera/queue_state.{QueueConfig, RequestState, Shard, ShardState, Sink}
use tessera/rules

pub fn shard_out_ok(
  out: Output,
  shard_in: Output,
  s1: ShardState,
  cfg: QueueConfig,
  total: Int,
) -> Bool {
  and {
    continuing_ok(out, shard_in),
    datum_of(out) == Shard(s1),
    out.value == merge(
      shard_in.value,
      from_asset(cfg.payout_policy, cfg.payout_name, -total),
    ),
  }
}

pub fn sink_out_ok(out: Output, q: PolicyId, reserve: PolicyId, total: Int) -> Bool {
  and {
    out.address == script_address(q),
    out.reference_script == None,
    datum_of(out) == Sink,
    list.length(flatten(out.value)) == 2,
    quantity_of(out.value, reserve, rules.tsra_name) == total,
  }
}

/// The transaction's only queue outputs are the shard (updated, `total`
/// payout units lighter) and one Sink holding exactly `total` TSRA.
pub fn shard_and_sink(
  outs: List<Output>,
  q: PolicyId,
  reserve: PolicyId,
  shard_in: Output,
  s1: ShardState,
  cfg: QueueConfig,
  total: Int,
) -> Bool {
  when outs is {
    [a, b] ->
      (shard_out_ok(a, shard_in, s1, cfg, total) && sink_out_ok(b, q, reserve, total)) || (shard_out_ok(
        b,
        shard_in,
        s1,
        cfg,
        total,
      ) && sink_out_ok(a, q, reserve, total))
    _ -> False
  }
}


/// Pay each Request: one distinct output to its `payout_to` holding at least
/// `qty` payout units and its lovelace less the keeper's tip. An output pays
/// one Request only (two Requests to one address need two outputs).
pub fn pay_all(rs: List<(Output, RequestState)>, outs: List<Output>, cfg: QueueConfig) -> Bool {
  when rs is {
    [] -> True
    [(o, r), ..rest] ->
      when take_payment(outs, r, lovelace_of(o.value) - cfg.settle_tip, cfg) is {
        Some(left) -> pay_all(rest, left, cfg)
        None -> False
      }
  }
}

pub fn take_payment(
  outs: List<Output>,
  r: RequestState,
  min_ada: Int,
  cfg: QueueConfig,
) -> Option<List<Output>> {
  when outs is {
    [] -> None
    [x, ..rest] ->
      if x.address == r.payout_to && quantity_of(
        x.value,
        cfg.payout_policy,
        cfg.payout_name,
      ) >= r.qty && lovelace_of(x.value) >= min_ada {
        Some(rest)
      } else {
        when take_payment(rest, r, min_ada, cfg) is {
          Some(left) -> Some([x, ..left])
          None -> None
        }
      }
  }
}

