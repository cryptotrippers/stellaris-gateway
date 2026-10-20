//// Redemption queue, stress flow (Phase 2.6, SPEC.md §4.8a and §4.3a): short
//// mode, D-32, and the Defund veto, D-33. Run once per transaction as a
//// withdraw-zero script, like `queue_flow`.
////
//// Normal settlement (`queue_flow`) never touches the ShortState; it only
//// reads it. When the Buffer cannot pay a Request that is a day overdue,
//// anyone `EnterShort`s: `Register` lists payable Requests on the ShortState
//// by day, nothing is paid for 24 hours, and `PayShort` then pays the oldest
//// registered day first until the tallies are empty and `ExitShort`.
//// Registered Requests cancel through `CancelRegistered` so the tally never
//// outlives the Request.

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential}
use cardano/assets.{PolicyId, quantity_of}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{Output, Transaction}
use stellaris/outputs.{continuing_ok}
use tessera/queue_ctx.{
  at_q, config_ref, datum_of, finite_bounds, is_empty_mint, q_ins, q_outs, shard_index,
  short_ref, step,
}
use tessera/queue_pay.{pay_all, shard_and_sink}
use tessera/queue_state.{
  CancelRegistered, Config, EnterShort, ExitShort, PayShort, QueueConfig,
  Register, Request, RequestState, ShardState, ShortAction, ShortRedeemer,
  ShortState, Shard, Short, Tally, VetoDefund, day_of, head_day, month_of,
  request_name, shard_after, short_name, short_overdue_ms, short_reentry_ms,
  short_window_ms, tally_add, tally_sub, config_name,
}
use tessera/reserve_ref.{genuine_config}
use tessera/rules

fn is_request(o: Output) -> Bool {
  when datum_of(o) is {
    Request(_) -> True
    _ -> False
  }
}

fn caps(cfg: QueueConfig) -> (Int, Int) {
  (cfg.daily_limit / cfg.shards, cfg.monthly_limit / cfg.shards)
}

/// The shard holds less than `qty`, or today's day or month window has no
/// room for it. A shard whose counters are already in a LATER window than `lo`
/// proves nothing (a back-dated `lo` must not fake a shortage).
fn cannot_pay(sh: Output, cfg: QueueConfig, lo: Int, qty: Int) -> Bool {
  expect Shard(sd) = datum_of(sh)
  let (cd, cm) = caps(cfg)
  quantity_of(sh.value, cfg.payout_policy, cfg.payout_name) < qty || (day_of(lo) >= sd.day && month_of(day_of(lo)) >= sd.month && shard_after(
    sd,
    day_of(lo),
    qty,
    cd,
    cm,
  ) == None)
}

// ---------------------------------------------------------------- EnterShort

fn enter(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
  let refs = list.map(tx.reference_inputs, fn(i) { i.output })
  expect [probe] =
    list.filter(
      refs,
      fn(o) { at_q(o, q) && quantity_of(o.value, q, request_name) == 1 },
    )
  expect Request(r) = datum_of(probe)
  let shards = list.filter(refs, fn(o) { shard_index(o, q) != None })
  let idxs = list.filter_map(shards, fn(o) { shard_index(o, q) })
  and {
    list.length(q_ins(tx, q)) == 1,
    is_empty_mint(tx, q),
    !s0.active,
    lo >= s0.last_exit + short_reentry_ms,
    cfg.suspended_until <= lo,
    !rules.frozen(rc.loss_pending_until, lo),
    r.payable_after + short_overdue_ms <= lo,
    r.qty <= cfg.instant_max,
    list.length(idxs) == cfg.shards,
    list.length(list.unique(idxs)) == cfg.shards,
    list.all(idxs, fn(i) { i < cfg.shards }),
    list.all(shards, fn(sh) { cannot_pay(sh, cfg, lo, r.qty) }),
    s1 == ShortState {
      active: True,
      episode: s0.episode + 1,
      since: lo,
      reg_deadline: lo + short_window_ms,
      last_exit: s0.last_exit,
      tallies: [],
    },
  }
}

// ------------------------------------------------------------------ Register

/// Pair the spent Requests with their re-created outputs, in order: equal
/// except `reg_episode = ep`, same value, same address. Returns the tallies.
fn reg_all(
  ins: List<Output>,
  outs: List<Output>,
  q: PolicyId,
  ep: Int,
  lo: Int,
  ts: List<Tally>,
) -> Option<List<Tally>> {
  when (ins, outs) is {
    ([], []) -> Some(ts)
    ([i, ..ri], [o, ..ro]) -> {
      expect Request(r) = datum_of(i)
      if r.reg_episode != ep && lo >= r.payable_after && quantity_of(
        i.value,
        q,
        request_name,
      ) == 1 && continuing_ok(o, i) && o.value == i.value && datum_of(o) == Request(
        RequestState { ..r, reg_episode: ep },
      ) {
        reg_all(ri, ro, q, ep, lo, tally_add(ts, r.bucket, r.qty))
      } else {
        None
      }
    }
    _ -> None
  }
}

fn register(tx: Transaction, q: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
  let (reqs, rest) = list.partition(q_ins(tx, q), is_request)
  let (req_outs, rest_outs) = list.partition(q_outs(tx, q), is_request)
  expect [_] = rest
  expect [_] = rest_outs
  expect Some(ts1) = reg_all(reqs, req_outs, q, s0.episode, lo, s0.tallies)
  and {
    reqs != [],
    is_empty_mint(tx, q),
    s0.active,
    s1 == ShortState { ..s0, tallies: ts1 },
  }
}

// ------------------------------------------------------------------ PayShort

fn pay_short(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
  let (reqs, rest) = list.partition(q_ins(tx, q), is_request)
  expect [a, b] = rest
  let shard_in =
    if shard_index(a, q) != None {
      a
    } else {
      b
    }
  expect Some(idx) = shard_index(shard_in, q)
  expect Shard(sd) = datum_of(shard_in)
  expect Some(h) = head_day(s0.tallies)
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
  let (cd, cm) = caps(cfg)
  expect Some(s1d) = shard_after(sd, day_of(lo), total, cd, cm)
  expect Some(ts1) = tally_sub(s0.tallies, h, total)
  and {
    n > 0,
    s0.active,
    lo >= s0.reg_deadline,
    cfg.suspended_until <= lo,
    !rules.frozen(rc.loss_pending_until, lo),
    idx < cfg.shards,
    s1 == ShortState { ..s0, tallies: ts1 },
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(request_name, -n)],
    list.all(
      rs,
      fn((o, r)) {
        r.reg_episode == s0.episode && r.bucket == h && quantity_of(
          o.value,
          q,
          request_name,
        ) == 1 && quantity_of(o.value, reserve, rules.tsra_name) == r.qty
      },
    ),
    shard_and_sink(
      list.filter(q_outs(tx, q), fn(o) { quantity_of(o.value, q, short_name) == 0 }),
      q,
      reserve,
      shard_in,
      s1d,
      cfg,
      total,
    ),
    pay_all(rs, tx.outputs, cfg),
  }
}

// ----------------------------------------------------------------- ExitShort

fn leave(tx: Transaction, q: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
  and {
    list.length(q_ins(tx, q)) == 1,
    is_empty_mint(tx, q),
    s0.active,
    lo >= s0.reg_deadline,
    s0.tallies == [],
    s1 == ShortState { ..s0, active: False, last_exit: lo },
  }
}

// ---------------------------------------------------------- CancelRegistered

/// Cancel a registered Request. While its episode is current and short mode is
/// on, the ShortState is spent and the tally falls by the Request's `qty`;
/// otherwise (stale registration, short mode off) the ShortState is only
/// referenced and must show exactly that, so the plain way out is never
/// closed and the tally never outlives the Request.
fn cancel_registered(tx: Transaction, q: PolicyId) -> Bool {
  let ins = q_ins(tx, q)
  let (reqs, rest) = list.partition(ins, is_request)
  expect [req_in] = reqs
  expect Request(r) = datum_of(req_in)
  and {
    r.reg_episode != 0,
    list.has(tx.extra_signatories, r.owner),
    quantity_of(req_in.value, q, request_name) == 1,
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(request_name, -1)],
    if rest == [] {
      when short_ref(tx, q) is {
        Some(s) -> !s.active || s.episode != r.reg_episode
        None -> False
      } && q_outs(tx, q) == []
    } else {
      expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
      expect Some(ts1) = tally_sub(s0.tallies, r.bucket, r.qty)
      list.length(rest) == 1 && s0.active && s0.episode == r.reg_episode && s1 == ShortState {
        ..s0,
        tallies: ts1,
      } && list.length(q_outs(tx, q)) == 1
    },
  }
}

// --------------------------------------------------------------- VetoDefund

/// D-33: anyone who shows payable Requests that a pending Defund would leave
/// uncovered clears it. Presence is provable; absence is not, so this is a
/// veto, not a precondition.
fn veto(tx: Transaction, q: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((Config(c0), Config(c1))) = step(tx, q, config_name)
  expect Some(pd) = c0.pending_defund
  let refs = list.map(tx.reference_inputs, fn(i) { i.output })
  expect [shard_ref] = list.filter(refs, fn(o) { shard_index(o, q) == Some(pd.shard) })
  let payable =
    list.filter(
      refs,
      fn(o) {
        at_q(o, q) && quantity_of(o.value, q, request_name) == 1 && when datum_of(o) is {
          Request(r) -> r.payable_after <= lo
          _ -> False
        }
      },
    )
  let owed =
    list.foldl(
      payable,
      0,
      fn(o, acc) {
        expect Request(r) = datum_of(o)
        acc + r.qty
      },
    )
  and {
    list.length(q_ins(tx, q)) == 1,
    is_empty_mint(tx, q),
    owed > quantity_of(shard_ref.value, c0.payout_policy, c0.payout_name) - pd.amount,
    c1 == QueueConfig { ..c0, pending_defund: None, epoch: c0.epoch + 1 },
  }
}

// ----------------------------------------------------------------- validator

fn short_action(a: ShortAction, tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  when a is {
    EnterShort -> enter(tx, q, reserve)
    Register -> register(tx, q)
    PayShort -> pay_short(tx, q, reserve)
    ExitShort -> leave(tx, q)
    CancelRegistered -> cancel_registered(tx, q)
    VetoDefund -> veto(tx, q)
  }
}

validator queue_short(reserve: PolicyId) {
  withdraw(redeemer: ShortRedeemer, account: Credential, tx: Transaction) {
    and {
      pairs.get_first(tx.withdrawals, account) == Some(0),
      short_action(redeemer.action, tx, redeemer.queue, reserve),
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
