//// Redemption queue, user flow in normal mode (Phase 2.6, SPEC.md §4.1):
//// `Request`, `Instant`, `Settle` and `Sweep`, run once per transaction as a
//// withdraw-zero script so that a batch of N Requests costs one run of this
//// script, not N (each Request's own spend handler is only a gate).
////
//// * It works on the queue named in its redeemer; `redeem_queue` checks, on
////   every spend and mint, that the redeemer names itself, so a run cannot be
////   borrowed for another queue.
//// * Short mode (D-32): `Settle` and `Instant` read the ShortState by
////   reference and refuse while it is active; the stress flow is in
////   `queue_short`.
//// * I-Q1 (D-35): only `Sweep` may touch a Sink, and it requires the genuine
////   Supply to be spent under the reserve's `Burn` for exactly the Sinks'
////   total. Every other action here fails if a Sink is among the queue inputs.
//// * The withdrawal is a gate: the amount must be 0 and the only certificate
////   the credential accepts is its registration.

use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, flatten, from_asset, lovelace_of, merge, quantity_of}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Output, Spend, Transaction}
use stellaris/outputs.{continuing_ok, script_address}
use tessera/eligibility.{eligible}
use tessera/queue_pay.{pay_all, shard_and_sink}
use tessera/queue_ctx.{
  at_q, config_ref, datum_of, finite_bounds, grace_valid, is_empty_mint, q_ins,
  q_outs, shard_index, short_inactive,
}
use tessera/queue_state.{
  FlowAction, FlowInstant, FlowRedeemer, FlowRequest, FlowSettle, FlowSweep,
  QueueConfig, Request, RequestState, Shard, ShardState, Sink, day_of,
  max_request_window, min_request_ada, payable_after_of, request_name,
  reserve_burn_tag, shard_after,
}
use tessera/reserve_ref.{genuine_config}
use tessera/reserve_state.{ConfigState, SupplyDatum}
use tessera/reserve_threads.{supply_name}
use tessera/rules

fn is_key(a: Address) -> Bool {
  when a.payment_credential is {
    VerificationKey(_) -> True
    _ -> False
  }
}

/// Instant and Settle pay out only when nothing stops them: short mode off
/// (D-32), no suspension (D-28), no loss freeze (D-29).
fn payouts_open(
  tx: Transaction,
  q: PolicyId,
  rc: ConfigState,
  cfg: QueueConfig,
  lo: Int,
) -> Bool {
  and {
    short_inactive(tx, q),
    cfg.suspended_until <= lo,
    !rules.frozen(rc.loss_pending_until, lo),
  }
}

// ------------------------------------------------------------------ Request

fn request_out_ok(
  o: Output,
  tx: Transaction,
  q: PolicyId,
  reserve: PolicyId,
  cfg: QueueConfig,
  rc: ConfigState,
  lo: Int,
  hi: Int,
) -> Bool {
  expect Request(r) = datum_of(o)
  and {
    o.address == script_address(q),
    o.reference_script == None,
    list.length(flatten(o.value)) == 3,
    lovelace_of(o.value) >= min_request_ada,
    quantity_of(o.value, q, request_name) == 1,
    quantity_of(o.value, reserve, rules.tsra_name) == r.qty,
    r.qty >= cfg.min_request,
    r.bucket == day_of(lo),
    r.payable_after == payable_after_of(r.bucket, cfg.settle_delay),
    r.reg_episode == 0,
    is_key(r.payout_to),
    list.has(tx.extra_signatories, r.owner),
    !rc.kyc_redeem || eligible(tx, rc.eligibility_policy, r.owner) || grace_valid(
      tx,
      q,
      r.owner,
      hi,
    ),
  }
}

fn request(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((lo, hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  let outs = q_outs(tx, q)
  let n = list.length(outs)
  and {
    q_ins(tx, q) == [],
    n > 0,
    hi >= lo,
    hi - lo <= max_request_window,
    day_of(lo) == day_of(hi),
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(request_name, n)],
    list.all(
      outs,
      fn(o) { request_out_ok(o, tx, q, reserve, cfg, rc, lo, hi) },
    ),
  }
}

// ------------------------------------------------------------------ Instant

fn instant(
  tx: Transaction,
  q: PolicyId,
  reserve: PolicyId,
  holder: ByteArray,
  qty: Int,
) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  expect [shard_in] = q_ins(tx, q)
  expect Some(idx) = shard_index(shard_in, q)
  expect Shard(s0) = datum_of(shard_in)
  expect Some(s1) =
    shard_after(
      s0,
      day_of(lo),
      qty,
      cfg.daily_limit / cfg.shards,
      cfg.monthly_limit / cfg.shards,
    )
  and {
    payouts_open(tx, q, rc, cfg, lo),
    idx < cfg.shards,
    qty > 0,
    qty <= cfg.instant_max,
    list.has(tx.extra_signatories, holder),
    !rc.kyc_redeem || eligible(tx, rc.eligibility_policy, holder),
    is_empty_mint(tx, q),
    shard_and_sink(q_outs(tx, q), q, reserve, shard_in, s1, cfg, qty),
    list.any(
      tx.outputs,
      fn(o) {
        o.address.payment_credential == VerificationKey(holder) && quantity_of(
          o.value,
          cfg.payout_policy,
          cfg.payout_name,
        ) >= qty
      },
    ),
  }
}

// ------------------------------------------------------------------- Settle

fn settle(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  let (reqs, others) =
    list.partition(
      q_ins(tx, q),
      fn(o) {
        when datum_of(o) is {
          Request(_) -> True
          _ -> False
        }
      },
    )
  expect [shard_in] = others
  expect Some(idx) = shard_index(shard_in, q)
  expect Shard(s0) = datum_of(shard_in)
  let rs =
    list.map(
      reqs,
      fn(o) {
        expect Request(r) = datum_of(o)
        (o, r)
      },
    )
  let n = list.length(rs)
  let total = list.foldl(rs, 0, fn((_, r), acc) { acc + r.qty })
  expect Some(s1) =
    shard_after(
      s0,
      day_of(lo),
      total,
      cfg.daily_limit / cfg.shards,
      cfg.monthly_limit / cfg.shards,
    )
  and {
    n > 0,
    payouts_open(tx, q, rc, cfg, lo),
    idx < cfg.shards,
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(request_name, -n)],
    list.all(
      rs,
      fn((o, r)) {
        quantity_of(o.value, q, request_name) == 1 && quantity_of(
          o.value,
          reserve,
          rules.tsra_name,
        ) == r.qty && lo >= r.payable_after
      },
    ),
    shard_and_sink(q_outs(tx, q), q, reserve, shard_in, s1, cfg, total),
    pay_all(rs, tx.outputs, cfg),
  }
}

// -------------------------------------------------------------------- Sweep

/// I-Q1 (D-35). Every queue input is a Sink holding only TSRA and lovelace;
/// the genuine Supply is spent under the reserve's `Burn` for exactly their
/// total TSRA (the reserve then checks `mint == -qty` and `kyc_redeem`); no
/// queue output exists and nothing under the queue policy moves.
fn sweep(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  let ins = q_ins(tx, q)
  expect Some(supply_in) =
    list.find(
      tx.inputs,
      fn(i) {
        i.output.address.payment_credential == Script(reserve) && quantity_of(
          i.output.value,
          reserve,
          supply_name,
        ) == 1
      },
    )
  expect InlineDatum(sd) = supply_in.output.datum
  expect SupplyDatum(_) = sd
  expect Some(rd) =
    pairs.get_first(tx.redeemers, Spend(supply_in.output_reference))
  let Pair(tag, fields) = builtin.un_constr_data(rd)
  expect [qty_data, _holder] = fields
  expect burn_qty: Int = qty_data
  and {
    ins != [],
    list.all(
      ins,
      fn(o) { datum_of(o) == Sink && list.length(flatten(o.value)) == 2 },
    ),
    tag == reserve_burn_tag,
    burn_qty == list.foldl(
      ins,
      0,
      fn(o, acc) { acc + quantity_of(o.value, reserve, rules.tsra_name) },
    ),
    q_outs(tx, q) == [],
    is_empty_mint(tx, q),
  }
}

// ----------------------------------------------------------------- validator

fn flow_action(action: FlowAction, tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  when action is {
    FlowRequest -> request(tx, q, reserve)
    FlowInstant { holder, qty } -> instant(tx, q, reserve, holder, qty)
    FlowSettle -> settle(tx, q, reserve)
    FlowSweep -> sweep(tx, q, reserve)
  }
}

validator queue_flow(reserve: PolicyId) {
  withdraw(redeemer: FlowRedeemer, account: Credential, tx: Transaction) {
    and {
      // a gate, not a reward account
      pairs.get_first(tx.withdrawals, account) == Some(0),
      flow_action(redeemer.action, tx, redeemer.queue, reserve),
    }
  }

  // Registration is the only certificate this credential ever accepts.
  publish(_redeemer: Data, certificate: Certificate, _tx: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}
