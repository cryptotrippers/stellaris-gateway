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
use aiken/primitive/bytearray
use aiken/collection/pairs
use cardano/address.{Credential}
use cardano/assets.{PolicyId, quantity_of}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use stellaris/outputs.{continuing_ok}
use tessera/queue_ctx.{
  at_q, config_ref, datum_of, finite_bounds, is_empty_mint, q_ins, q_outs, shard_index,
  short_ref, step,
}
use tessera/queue_state.{
  CancelRegistered, Config, EnterShort, ExitShort, QueueConfig,
  Register, Request, RequestState, ShardState, ShortAction, ShortRedeemer,
  ShortState, Shard, Short, Tally, VetoDefund, day_of, head_day, month_of,
  request_name, shard_after, shard_name, short_name, short_overdue_ms, short_reentry_ms,
  short_window_ms, tally_add, tally_sub, config_name,
}
use tessera/reserve_ref.{genuine_config}
use tessera/rules
// <hoisted test imports>
use cardano/address.{Script}
use cardano/transaction.{placeholder}
use tessera/queue_fixture.{
  CertMirror, RegisterM, add_in, add_out, alice, at, bob, cert, cfg0,
  config_out, day, drop_out, edit_req, gate, inp, ins, key_addr, lovelace_plus,
  map_in, map_out, minting, outs, q, qout, qtok, rcfg0, refs, refused_certs,
  req, req_out, reserve_config_out, shard0, shard_out, short0, short_out, signed,
  sink_out, staked, t_reserve, t_short, tally, tsra, tx0, usd, wallet,
  with_ref_script, with_value,
}
use tessera/queue_state.{PendingDefund}
use tessera/reserve_state.{ConfigState}
// </hoisted test imports>

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
/// Each input datum is decoded once; the output datum is compared as it is.
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
      let expected: Data = Request(RequestState { ..r, reg_episode: ep })
      if r.reg_episode != ep && lo >= r.payable_after && quantity_of(
        i.value,
        q,
        request_name,
      ) == 1 && continuing_ok(o, i) && o.value == i.value && o.datum == InlineDatum(
        expected,
      ) {
        reg_all(ri, ro, q, ep, lo, tally_add(ts, r.bucket, r.qty))
      } else {
        None
      }
    }
    _ -> None
  }
}

/// Not the ShortState itself.
fn not_short(o: Output, q: PolicyId) -> Bool {
  quantity_of(o.value, q, short_name) == 0
}

fn register(tx: Transaction, q: PolicyId) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((Short(s0), Short(s1))) = step(tx, q, short_name)
  // everything queue-side except the ShortState itself must be a Request
  // (decoding anything else as a Request fails the transaction)
  let reqs = list.filter(q_ins(tx, q), fn(o) { not_short(o, q) })
  let req_outs = list.filter(q_outs(tx, q), fn(o) { not_short(o, q) })
  expect Some(ts1) = reg_all(reqs, req_outs, q, s0.episode, lo, s0.tallies)
  and {
    reqs != [],
    is_empty_mint(tx, q),
    s0.active,
    s1 == ShortState { ..s0, tallies: ts1 },
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
  let (owed, shards) =
    veto_scan(tx.reference_inputs, q, shard_name(pd.shard), lo, 0, [])
  expect [shard_ref] = shards
  and {
    list.length(q_ins(tx, q)) == 1,
    is_empty_mint(tx, q),
    owed > quantity_of(
      shard_ref.value,
      c0.payout_policy,
      c0.payout_name,
    ) - pd.amount,
    c1 == QueueConfig { ..c0, pending_defund: None, epoch: c0.epoch + 1 },
  }
}

/// One pass over the references: the total `qty` of the referenced genuine
/// Requests payable at `lo` (a `request` marker under `q` is on a Request UTxO
/// and nowhere else), and the output(s) carrying the shard thread `name`.
fn veto_scan(
  refs: List<Input>,
  q: PolicyId,
  name: ByteArray,
  lo: Int,
  owed: Int,
  shards: List<Output>,
) -> (Int, List<Output>) {
  when refs is {
    [] -> (owed, shards)
    [i, ..rest] ->
      if quantity_of(i.output.value, q, request_name) == 1 {
        expect Request(r) = datum_of(i.output)
        veto_scan(
          rest,
          q,
          name,
          lo,
          if r.payable_after <= lo {
            owed + r.qty
          } else {
            owed
          },
          shards,
        )
      } else if quantity_of(i.output.value, q, name) == 1 {
        veto_scan(rest, q, name, lo, owed, [i.output, ..shards])
      } else {
        veto_scan(rest, q, name, lo, owed, shards)
      }
  }
}

// ----------------------------------------------------------------- validator

fn short_action(a: ShortAction, tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  when a is {
    EnterShort -> enter(tx, q, reserve)
    Register -> register(tx, q)
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

// ------------------------------------------------------------------ tests


fn run(a: ShortAction, tx: Transaction) -> Bool {
  queue_short.withdraw(
    t_reserve,
    ShortRedeemer { queue: q, action: a },
    Script(t_short),
    tx |> gate(t_short),
  )
}

fn lo_e() -> Int {
  24 * day + 1_000
}

fn base_refs() -> List<Input> {
  [inp(90, config_out(cfg0())), inp(91, reserve_config_out(rcfg0()))]
}

fn dry_shards() -> List<Input> {
  [
    inp(70, shard_out(0, shard0(), 0)),
    inp(71, shard_out(1, shard0(), 0)),
    inp(72, shard_out(2, shard0(), 0)),
    inp(73, shard_out(3, shard0(), 0)),
  ]
}

fn probe_in() -> Input {
  inp(60, req_out(req(alice, 1_000_000_000, 20)))
}

fn s_active(tallies: List<Tally>) -> ShortState {
  ShortState {
    ..short0(),
    active: True,
    episode: 1,
    since: 24 * day,
    reg_deadline: 25 * day,
    tallies: tallies,
  }
}

// -- EnterShort

fn enter_tx() -> Transaction {
  let s1 = ShortState { ..short0(), active: True, episode: 1, since: lo_e(), reg_deadline: lo_e() + day }
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> refs(list.concat(base_refs(), [probe_in(), ..dry_shards()]))
    |> ins([inp(1, short_out(short0()))])
    |> outs([short_out(s1)])
}

test entering_short_mode_with_a_real_shortage_is_accepted() {
  run(EnterShort, enter_tx())
}

test a_shard_that_is_out_of_daily_room_proves_a_shortage_too() {
  // balance is there, but today's daily cap (10,000 TSRA) is used up
  let full = ShardState { day: 24, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  let shards =
    [
      inp(70, shard_out(0, full, 50_000_000_000)),
      inp(71, shard_out(1, full, 50_000_000_000)),
      inp(72, shard_out(2, full, 50_000_000_000)),
      inp(73, shard_out(3, full, 50_000_000_000)),
    ]
  run(EnterShort, enter_tx() |> refs(list.concat(base_refs(), [probe_in(), ..shards])))
}

test a_request_one_millisecond_short_of_a_day_overdue_is_refused() {
  // payable_after of bucket 20 is 23 days; overdue by 24 h at 24 days
  !run(EnterShort, enter_tx() |> at(24 * day - 1, 24 * day + 600_000)) && run(
    EnterShort,
    enter_tx() |> at(24 * day, 24 * day + 600_000)
      |> map_out(0, fn(_) { short_out(ShortState { ..short0(), active: True, episode: 1, since: 24 * day, reg_deadline: 25 * day }) }),
  )
}

test a_probe_over_probe_max_is_refused() {
  !run(
    EnterShort,
    enter_tx()
      |> refs(list.concat(base_refs(), [inp(60, req_out(req(alice, 10_000_000_001, 20))), ..dry_shards()])),
  )
}

test a_missing_shard_reference_is_refused() {
  !run(
    EnterShort,
    enter_tx() |> refs(list.concat(base_refs(), [probe_in(), inp(70, shard_out(0, shard0(), 0)), inp(71, shard_out(1, shard0(), 0)), inp(72, shard_out(2, shard0(), 0))])),
  )
}

test a_duplicated_shard_reference_is_refused() {
  !run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [probe_in(), inp(70, shard_out(0, shard0(), 0)), inp(71, shard_out(1, shard0(), 0)), inp(72, shard_out(2, shard0(), 0)), inp(74, shard_out(2, shard0(), 0))],
          ),
        ),
  )
}

test a_shard_that_can_pay_refuses_the_entry() {
  !run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [probe_in(), inp(70, shard_out(0, shard0(), 1_000_000_000)), inp(71, shard_out(1, shard0(), 0)), inp(72, shard_out(2, shard0(), 0)), inp(73, shard_out(3, shard0(), 0))],
          ),
        ),
  )
}

test a_backdated_lower_bound_cannot_fake_a_shortage() {
  // the shard's counters are already in a later window than lo's: no proof
  let ahead = ShardState { day: 30, paid_day: 10_000_000_000, month: 1, paid_month: 10_000_000_000 }
  !run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [probe_in(), inp(70, shard_out(0, ahead, 50_000_000_000)), inp(71, shard_out(1, shard0(), 0)), inp(72, shard_out(2, shard0(), 0)), inp(73, shard_out(3, shard0(), 0))],
          ),
        ),
  )
}

test entry_is_refused_while_suspended_or_frozen() {
  let c = QueueConfig { ..cfg0(), suspended_until: lo_e() + 1 }
  let rc = ConfigState { ..rcfg0(), loss_pending_until: lo_e() + 1 }
  !run(
    EnterShort,
    enter_tx() |> refs(list.concat([inp(90, config_out(c)), inp(91, reserve_config_out(rcfg0()))], [probe_in(), ..dry_shards()])),
  ) && !run(
    EnterShort,
    enter_tx() |> refs(list.concat([inp(90, config_out(cfg0())), inp(91, reserve_config_out(rc))], [probe_in(), ..dry_shards()])),
  )
}

test entry_is_refused_inside_the_reentry_gap() {
  let recent = ShortState { ..short0(), last_exit: lo_e() - day + 1 }
  let ok = ShortState { ..short0(), last_exit: lo_e() - day }
  !run(EnterShort, enter_tx() |> map_in(0, fn(_) { short_out(recent) })) && run(
    EnterShort,
    enter_tx() |> map_in(0, fn(_) { short_out(ok) })
      |> map_out(0, fn(_) { short_out(ShortState { ..ok, active: True, episode: 1, since: lo_e(), reg_deadline: lo_e() + day }) }),
  )
}

test entry_is_refused_when_already_active() {
  let a = s_active([])
  !run(EnterShort, enter_tx() |> map_in(0, fn(_) { short_out(a) }))
}

test entry_with_a_planted_probe_fails() fail {
  let planted = qout(assets.from_asset(t_reserve, "TSRA", 1_000_000_000), Request(req(alice, 1_000_000_000, 20)))
  run(EnterShort, enter_tx() |> refs(list.concat(base_refs(), [inp(60, planted), ..dry_shards()])))
}

test entry_must_set_the_new_episode_exactly() {
  let bad_ep = ShortState { ..short0(), active: True, episode: 2, since: lo_e(), reg_deadline: lo_e() + day }
  let bad_deadline = ShortState { ..short0(), active: True, episode: 1, since: lo_e(), reg_deadline: lo_e() + day - 1 }
  let bad_tallies = ShortState { ..short0(), active: True, episode: 1, since: lo_e(), reg_deadline: lo_e() + day, tallies: [tally(1, 1)] }
  !run(EnterShort, enter_tx() |> map_out(0, fn(_) { short_out(bad_ep) })) && !run(
    EnterShort,
    enter_tx() |> map_out(0, fn(_) { short_out(bad_deadline) }),
  ) && !run(EnterShort, enter_tx() |> map_out(0, fn(_) { short_out(bad_tallies) }))
}

test entry_with_a_staked_short_output_fails() fail {
  run(EnterShort, enter_tx() |> map_out(0, staked))
}

test entry_with_a_reference_script_on_the_short_output_fails() fail {
  run(EnterShort, enter_tx() |> map_out(0, with_ref_script))
}

test entry_may_not_spend_another_queue_utxo() {
  !run(EnterShort, enter_tx() |> add_in(inp(5, sink_out(1))))
}

test entry_with_a_planted_short_state_fails() fail {
  let planted = qout(assets.zero, Short(short0()))
  run(EnterShort, enter_tx() |> map_in(0, fn(_) { planted }))
}

// -- Register

fn ra() -> RequestState {
  req(alice, 1_000_000_000, 20)
}

fn rb() -> RequestState {
  req(bob, 2_000_000_000, 21)
}

fn reg(r: RequestState) -> RequestState {
  RequestState { ..r, reg_episode: 1 }
}

fn register_tx() -> Transaction {
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> ins([inp(1, short_out(s_active([]))), inp(10, req_out(ra())), inp(11, req_out(rb()))])
    |> outs([
        short_out(s_active([tally(20, 1_000_000_000), tally(21, 2_000_000_000)])),
        req_out(reg(ra())),
        req_out(reg(rb())),
      ])
}

test registering_payable_requests_is_accepted() {
  run(Register, register_tx())
}

test registration_needs_no_signature() {
  run(Register, register_tx() |> signed([]))
}

test an_older_day_goes_to_the_head_of_the_tallies() {
  let older = req(bob, 500_000_000, 19)
  let tx =
    register_tx()
      |> ins([inp(1, short_out(s_active([tally(21, 7)]))), inp(10, req_out(older))])
      |> outs([
          short_out(s_active([tally(19, 500_000_000), tally(21, 7)])),
          req_out(reg(older)),
        ])
  run(Register, tx)
}

test registration_adds_to_an_existing_day() {
  let tx =
    register_tx()
      |> ins([inp(1, short_out(s_active([tally(20, 5)]))), inp(10, req_out(ra()))])
      |> outs([short_out(s_active([tally(20, 1_000_000_005)])), req_out(reg(ra()))])
  run(Register, tx)
}

test the_tallies_must_add_up_exactly() {
  let under = s_active([tally(20, 999_999_999), tally(21, 2_000_000_000)])
  let over = s_active([tally(20, 1_000_000_000), tally(21, 2_000_000_001)])
  let wrong_day = s_active([tally(20, 3_000_000_000)])
  !run(Register, register_tx() |> map_out(0, fn(_) { short_out(under) })) && !run(
    Register,
    register_tx() |> map_out(0, fn(_) { short_out(over) }),
  ) && !run(Register, register_tx() |> map_out(0, fn(_) { short_out(wrong_day) }))
}

test a_request_that_is_not_payable_yet_cannot_be_registered() fail {
  // bucket 21 becomes payable at 24 days
  run(Register, register_tx() |> at(24 * day - 1, 24 * day + 600_000))
}

test a_request_payable_exactly_now_can_be_registered() {
  run(Register, register_tx() |> at(24 * day, 24 * day + 600_000))
}

test a_request_registered_in_this_episode_cannot_be_registered_twice() fail {
  let tx =
    register_tx()
      |> ins([inp(1, short_out(s_active([]))), inp(10, req_out(reg(ra())))])
      |> outs([short_out(s_active([tally(20, 1_000_000_000)])), req_out(reg(ra()))])
  run(Register, tx)
}

test a_stale_registration_can_be_registered_again() {
  let old = RequestState { ..ra(), reg_episode: 1 }
  let s = ShortState { ..s_active([]), episode: 2 }
  let again = RequestState { ..ra(), reg_episode: 2 }
  run(
    Register,
    register_tx()
      |> ins([inp(1, short_out(s)), inp(10, req_out(old))])
      |> outs([short_out(ShortState { ..s, tallies: [tally(20, 1_000_000_000)] }), req_out(again)]),
  )
}

test registration_may_not_change_qty() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, qty: r.qty - 1 } }))
}

test registration_may_not_change_the_owner() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, owner: bob } }))
}

test registration_may_not_change_the_bucket() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, bucket: 19 } }))
}

test registration_may_not_change_payable_after() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, payable_after: 0 } }))
}

test registration_may_not_change_payout_to() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, payout_to: key_addr(bob) } }))
}

test registration_must_set_exactly_the_current_episode() fail {
  run(Register, register_tx() |> edit_req(1, fn(r) { RequestState { ..r, reg_episode: 2 } }))
}

test registration_may_not_add_value() fail {
  run(Register, register_tx() |> map_out(1, fn(o) { with_value(o, usd(1)) }))
}

test registration_may_not_add_lovelace() fail {
  run(Register, register_tx() |> map_out(1, fn(o) { lovelace_plus(o, 1) }))
}

test registration_may_not_stake_the_request() fail {
  run(Register, register_tx() |> map_out(1, staked))
}

test registration_may_not_attach_a_reference_script() fail {
  run(Register, register_tx() |> map_out(1, with_ref_script))
}

test registration_needs_the_marker_on_every_input() fail {
  let unmarked = qout(assets.from_asset(t_reserve, "TSRA", 1_000_000_000), Request(ra()))
  run(Register, register_tx() |> map_in(1, fn(_) { unmarked }))
}

test registration_pairs_inputs_and_outputs_in_order() fail {
  run(
    Register,
    register_tx()
      |> outs([
          short_out(s_active([tally(20, 1_000_000_000), tally(21, 2_000_000_000)])),
          req_out(reg(rb())),
          req_out(reg(ra())),
        ]),
  )
}

test registration_needs_short_mode_on() {
  let off = ShortState { ..s_active([]), active: False }
  !run(Register, register_tx() |> map_in(0, fn(_) { short_out(off) }))
}

test registration_with_no_requests_is_refused() {
  !run(Register, register_tx() |> ins([inp(1, short_out(s_active([])))]) |> outs([short_out(s_active([]))]))
}

test registration_with_a_missing_output_is_refused() fail {
  run(Register, register_tx() |> drop_out(2))
}

test registration_may_not_mint() {
  !run(Register, register_tx() |> minting(qtok(request_name, 1)))
}

test registration_must_not_take_other_queue_inputs() fail {
  run(Register, register_tx() |> add_in(inp(5, sink_out(1))))
}

// -- ExitShort

fn exit_tx() -> Transaction {
  tx0()
    |> at(25 * day, 25 * day + 600_000)
    |> ins([inp(1, short_out(s_active([])))])
    |> outs([short_out(ShortState { ..s_active([]), active: False, last_exit: 25 * day })])
}

test exiting_with_empty_tallies_after_the_window_is_accepted() {
  run(ExitShort, exit_tx())
}

test exit_is_refused_with_open_tallies() {
  !run(
    ExitShort,
    exit_tx() |> map_in(0, fn(_) { short_out(s_active([tally(20, 1)])) }) |> map_out(0, fn(_) { short_out(ShortState { ..s_active([tally(20, 1)]), active: False, last_exit: 25 * day }) }),
  )
}

test exit_is_refused_inside_the_window() {
  !run(ExitShort, exit_tx() |> at(25 * day - 1, 25 * day + 600_000))
}

test exit_needs_short_mode_on() {
  let off = ShortState { ..s_active([]), active: False }
  !run(ExitShort, exit_tx() |> map_in(0, fn(_) { short_out(off) }))
}

test exit_must_record_the_exit_time() {
  !run(ExitShort, exit_tx() |> map_out(0, fn(_) { short_out(ShortState { ..s_active([]), active: False, last_exit: 0 }) })) && !run(
    ExitShort,
    exit_tx() |> map_out(0, fn(_) { short_out(ShortState { ..s_active([]), active: True, last_exit: 25 * day }) }),
  )
}

test exit_may_not_carry_other_queue_inputs_or_mint() {
  !run(ExitShort, exit_tx() |> add_in(inp(5, sink_out(1)))) && !run(
    ExitShort,
    exit_tx() |> minting(qtok(request_name, 1)),
  )
}

// -- CancelRegistered

fn cancel_current_tx() -> Transaction {
  let s0 = s_active([tally(20, 1_000_000_000), tally(21, 2_000_000_000)])
  let s1 = s_active([tally(21, 2_000_000_000)])
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> signed([alice])
    |> ins([inp(1, short_out(s0)), inp(10, req_out(reg(ra())))])
    |> outs([short_out(s1), wallet(alice, tsra(1_000_000_000))])
    |> minting(qtok(request_name, -1))
}

test cancelling_a_registered_request_lowers_its_days_tally() {
  run(CancelRegistered, cancel_current_tx())
}

test cancelling_part_of_a_day_leaves_the_rest() {
  let s0 = s_active([tally(20, 5_000_000_000)])
  let s1 = s_active([tally(20, 4_000_000_000)])
  run(
    CancelRegistered,
    cancel_current_tx() |> map_in(0, fn(_) { short_out(s0) }) |> map_out(0, fn(_) { short_out(s1) }),
  )
}

test cancelling_a_request_from_a_non_head_day_works() {
  let s0 = s_active([tally(19, 4), tally(20, 1_000_000_000)])
  let s1 = s_active([tally(19, 4)])
  run(
    CancelRegistered,
    cancel_current_tx() |> map_in(0, fn(_) { short_out(s0) }) |> map_out(0, fn(_) { short_out(s1) }),
  )
}

test the_tally_must_fall_by_exactly_the_requests_qty() {
  !run(CancelRegistered, cancel_current_tx() |> map_out(0, fn(_) { short_out(s_active([tally(20, 1), tally(21, 2_000_000_000)])) })) && !run(
    CancelRegistered,
    cancel_current_tx() |> map_out(0, fn(_) { short_out(s_active([tally(20, 1_000_000_000), tally(21, 2_000_000_000)])) }),
  )
}

test a_cancel_cannot_take_more_than_the_tally_holds() fail {
  let s0 = s_active([tally(20, 999_999_999)])
  run(
    CancelRegistered,
    cancel_current_tx() |> map_in(0, fn(_) { short_out(s0) }) |> map_out(0, fn(_) { short_out(s_active([])) }),
  )
}

test only_the_owner_can_cancel_a_registered_request() {
  !run(CancelRegistered, cancel_current_tx() |> signed([bob])) && !run(
    CancelRegistered,
    cancel_current_tx() |> signed([]),
  )
}

test a_registered_cancel_must_burn_the_marker() {
  !run(CancelRegistered, cancel_current_tx() |> minting(assets.zero)) && !run(
    CancelRegistered,
    cancel_current_tx() |> minting(qtok(request_name, -2)),
  )
}

test an_unregistered_request_has_no_registered_cancel() {
  !run(
    CancelRegistered,
    cancel_current_tx() |> map_in(1, fn(_) { req_out(ra()) }),
  )
}

fn cancel_stale_tx() -> Transaction {
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> signed([alice])
    |> refs([inp(92, short_out(ShortState { ..short0(), episode: 1 }))])
    |> ins([inp(10, req_out(reg(ra())))])
    |> outs([wallet(alice, tsra(1_000_000_000))])
    |> minting(qtok(request_name, -1))
}

test a_stale_registration_cancels_without_touching_the_short_state() {
  // short mode is off now
  run(CancelRegistered, cancel_stale_tx())
}

test a_registration_of_an_older_episode_cancels_while_a_newer_one_runs() {
  let s = ShortState { ..s_active([]), episode: 2 }
  run(CancelRegistered, cancel_stale_tx() |> refs([inp(92, short_out(s))]))
}

test a_current_registration_cannot_dodge_the_tally_by_referencing() {
  // short mode on, same episode, ShortState only referenced: refused
  !run(CancelRegistered, cancel_stale_tx() |> refs([inp(92, short_out(s_active([tally(20, 1_000_000_000)])))]))
}

test a_stale_cancel_needs_the_short_state_reference() fail {
  run(CancelRegistered, cancel_stale_tx() |> refs([]))
}

test a_stale_cancel_may_not_create_queue_outputs() {
  !run(CancelRegistered, cancel_stale_tx() |> add_out(sink_out(1)))
}

test cancelling_two_registered_requests_at_once_is_refused() fail {
  run(CancelRegistered, cancel_current_tx() |> add_in(inp(11, req_out(reg(rb())))))
}

// -- VetoDefund

fn pd() -> PendingDefund {
  PendingDefund { shard: 0, amount: 4_000_000_000, effective_at: lo_e() + 3 * day }
}

fn veto_cfg() -> QueueConfig {
  QueueConfig { ..cfg0(), pending_defund: Some(pd()) }
}

fn veto_tx() -> Transaction {
  // shard 0 holds 5,000; defunding 4,000 would leave 1,000; the payable
  // Requests shown owe 1,000 + 2,000 = 3,000 > 1,000
  let c1 = QueueConfig { ..veto_cfg(), pending_defund: None, epoch: 1 }
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> refs([
        inp(70, shard_out(0, shard0(), 5_000_000_000)),
        inp(60, req_out(ra())),
        inp(61, req_out(req(bob, 2_000_000_000, 21))),
      ])
    |> ins([inp(1, config_out(veto_cfg()))])
    |> outs([config_out(c1)])
}

test showing_enough_payable_requests_vetoes_the_defund() {
  run(VetoDefund, veto_tx())
}

test the_veto_needs_no_signature() {
  run(VetoDefund, veto_tx() |> signed([]))
}

test the_veto_is_refused_at_equality() {
  // balance - amount = 1,000; owed exactly 1,000 does not veto
  !run(
    VetoDefund,
    veto_tx() |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), inp(60, req_out(ra()))]),
  ) && run(
    VetoDefund,
    veto_tx() |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), inp(60, req_out(ra())), inp(61, req_out(req(bob, 1, 20)))]),
  )
}

test a_request_that_is_not_payable_yet_does_not_count() {
  // bucket 22 is payable from day 25
  !run(
    VetoDefund,
    veto_tx() |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), inp(60, req_out(ra())), inp(61, req_out(req(bob, 2_000_000_000, 22)))]),
  )
}

test a_planted_request_does_not_count() {
  let planted = qout(assets.from_asset(t_reserve, "TSRA", 2_000_000_000), Request(req(bob, 2_000_000_000, 21)))
  !run(
    VetoDefund,
    veto_tx() |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), inp(60, req_out(ra())), inp(61, planted)]),
  )
}

test the_veto_needs_the_pending_shard_referenced() fail {
  run(
    VetoDefund,
    veto_tx() |> refs([inp(71, shard_out(1, shard0(), 5_000_000_000)), inp(60, req_out(ra())), inp(61, req_out(req(bob, 2_000_000_000, 21)))]),
  )
}

test the_veto_needs_a_pending_defund() fail {
  run(VetoDefund, veto_tx() |> ins([inp(1, config_out(cfg0()))]))
}

test the_veto_clears_the_notice_and_nothing_else() {
  let tx = veto_tx()
  let bumped = QueueConfig { ..veto_cfg(), pending_defund: None, epoch: 2 }
  let changed = QueueConfig { ..veto_cfg(), pending_defund: None, epoch: 1, daily_limit: 1 }
  let kept = QueueConfig { ..veto_cfg(), epoch: 1 }
  !run(VetoDefund, tx |> map_out(0, fn(_) { config_out(bumped) })) && !run(
    VetoDefund,
    tx |> map_out(0, fn(_) { config_out(changed) }),
  ) && !run(VetoDefund, tx |> map_out(0, fn(_) { config_out(kept) }))
}

test the_veto_with_a_staked_config_output_fails() fail {
  run(VetoDefund, veto_tx() |> map_out(0, staked))
}

test the_veto_with_a_reference_script_fails() fail {
  run(VetoDefund, veto_tx() |> map_out(0, with_ref_script))
}

test the_veto_may_not_spend_another_queue_utxo() {
  !run(VetoDefund, veto_tx() |> add_in(inp(5, sink_out(1))))
}

test the_veto_may_not_mint() {
  !run(VetoDefund, veto_tx() |> minting(qtok(request_name, 1)))
}

// -- gate and publish

test the_short_withdrawal_must_be_zero() {
  !queue_short.withdraw(
    t_reserve,
    ShortRedeemer { queue: q, action: ExitShort },
    Script(t_short),
    Transaction { ..exit_tx(), withdrawals: [Pair(Script(t_short), 1)] },
  ) && !queue_short.withdraw(
    t_reserve,
    ShortRedeemer { queue: q, action: ExitShort },
    Script(t_short),
    exit_tx(),
  )
}

fn published(m: CertMirror) -> Bool {
  queue_short.publish(t_reserve, Void, cert(m), placeholder)
}

test registering_the_short_credential_is_accepted() {
  published(RegisterM { credential: Script(t_short), deposit: None })
}

test no_other_certificate_is_accepted_for_the_short_credential() {
  list.all(refused_certs(Script(t_short)), fn(m) { !published(m) })
}

// -- a transaction judged under a different action is refused

test an_entry_is_not_a_registration() fail {
  run(Register, enter_tx())
}

test a_registration_is_not_an_entry() fail {
  run(EnterShort, register_tx())
}

test an_exit_is_not_a_registration() {
  !run(Register, exit_tx())
}

test a_registration_is_not_an_exit() {
  !run(ExitShort, register_tx())
}

test a_veto_is_not_an_exit() fail {
  run(ExitShort, veto_tx())
}

test a_registered_cancel_is_not_an_exit() {
  !run(ExitShort, cancel_current_tx())
}

test a_registered_cancel_may_not_carry_a_sink() fail {
  run(CancelRegistered, cancel_current_tx() |> add_in(inp(5, sink_out(1))))
}

// -- execution budget (SPEC §4.13); see the matching tests in queue_flow and
// redeem_queue for the batch gates. `_build` tests only build the transaction.

fn bkey(i: Int) -> ByteArray {
  bytearray.concat(
    #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
    bytearray.push("", i),
  )
}

fn batch_reqs(n: Int) -> List<RequestState> {
  list.map(
    list.range(1, n),
    fn(i) { req(bkey(i), 100_000_000 + i * 1_000_000, 19 + i % 3) },
  )
}

fn register_batch(n: Int) -> Transaction {
  let rs = batch_reqs(n)
  let total = list.foldl(rs, [], fn(r, acc) { tally_add(acc, r.bucket, r.qty) })
  tx0()
    |> at(24 * day + 1_000, 24 * day + 600_000)
    |> ins([inp(1, short_out(s_active([]))), ..list.indexed_map(rs, fn(i, r) { inp(10 + i, req_out(r)) })])
    |> outs([short_out(s_active(total)), ..list.map(rs, fn(r) { req_out(reg(r)) })])
}

fn veto_batch(n: Int) -> Transaction {
  let c1 = QueueConfig { ..veto_cfg(), pending_defund: None, epoch: 1 }
  let owed = list.map(list.range(1, n), fn(i) { inp(100 + i, req_out(req(bkey(i), 1_000_000_000, 20))) })
  tx0()
    |> at(lo_e(), lo_e() + 600_000)
    |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), ..owed])
    |> ins([inp(1, config_out(veto_cfg()))])
    |> outs([config_out(c1)])
}

fn forced(tx: Transaction) -> Bool {
  list.length(tx.inputs) + list.length(tx.outputs) + list.length(tx.reference_inputs) > 0
}

test budget_register_20_build() {
  forced(register_batch(20))
}

test budget_register_20_run() {
  let tx = register_batch(20)
  forced(tx) && run(Register, tx)
}

test budget_veto_40_build() {
  forced(veto_batch(40))
}

test budget_veto_40_run() {
  let tx = veto_batch(40)
  forced(tx) && run(VetoDefund, tx)
}

test budget_enter_build() {
  forced(enter_tx())
}

test budget_enter_run() {
  let tx = enter_tx()
  forced(tx) && run(EnterShort, tx)
}

test budget_cancel_registered_build() {
  forced(cancel_current_tx())
}

test budget_cancel_registered_run() {
  let tx = cancel_current_tx()
  forced(tx) && run(CancelRegistered, tx)
}

test budget_exit_build() {
  forced(exit_tx())
}

test budget_exit_run() {
  let tx = exit_tx()
  forced(tx) && run(ExitShort, tx)
}

// -- tests added after the first mutation pass (each kills a surviving mutant)

fn enter_at(lo: Int, last_exit: Int) -> Transaction {
  let s0 = ShortState { ..short0(), last_exit: last_exit }
  let s1 =
    ShortState {
      ..short0(),
      active: True,
      episode: 1,
      since: lo,
      reg_deadline: lo + day,
      last_exit: last_exit,
    }
  enter_tx()
    |> at(lo, lo + 600_000)
    |> map_in(0, fn(_) { short_out(s0) })
    |> map_out(0, fn(_) { short_out(s1) })
}

test the_reentry_gap_is_exactly_a_day_after_the_last_exit() {
  run(EnterShort, enter_at(lo_e(), lo_e() - day)) && !run(EnterShort, enter_at(lo_e(), lo_e() - day + 1)) && !run(
    EnterShort,
    enter_at(lo_e(), lo_e() + day),
  )
}

test a_request_must_be_a_full_day_overdue_whatever_the_output_says() {
  run(EnterShort, enter_at(24 * day, 0)) && !run(EnterShort, enter_at(24 * day - 1, 0))
}

test entry_is_allowed_exactly_when_the_suspension_ends() {
  let c = QueueConfig { ..cfg0(), suspended_until: lo_e() }
  run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            [inp(90, config_out(c)), inp(91, reserve_config_out(rcfg0()))],
            [probe_in(), ..dry_shards()],
          ),
        ),
  )
}

test a_probe_of_exactly_probe_max_is_enough() {
  run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [inp(60, req_out(req(alice, 10_000_000_000, 20))), ..dry_shards()],
          ),
        ),
  )
}

test a_fifth_shard_reference_is_refused() {
  !run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [probe_in(), inp(74, shard_out(3, shard0(), 0)), ..dry_shards()],
          ),
        ),
  )
}

test a_shard_beyond_the_configured_count_is_refused() {
  !run(
    EnterShort,
    enter_tx()
      |> refs(
          list.concat(
            base_refs(),
            [
              probe_in(),
              inp(70, shard_out(0, shard0(), 0)),
              inp(71, shard_out(1, shard0(), 0)),
              inp(72, shard_out(2, shard0(), 0)),
              inp(73, shard_out(4, shard0(), 0)),
            ],
          ),
        ),
  )
}

test entry_may_not_mint() {
  !run(EnterShort, enter_tx() |> minting(qtok(request_name, 1)))
}

test entry_is_refused_when_already_active_even_with_a_consistent_output() {
  let a = s_active([])
  let next =
    ShortState {
      ..short0(),
      active: True,
      episode: 2,
      since: lo_e(),
      reg_deadline: lo_e() + day,
    }
  !run(
    EnterShort,
    enter_tx()
      |> map_in(0, fn(_) { short_out(a) })
      |> map_out(0, fn(_) { short_out(next) }),
  )
}

test registration_needs_short_mode_on_even_with_a_consistent_output() {
  let off = ShortState { ..s_active([]), active: False }
  let off_t =
    ShortState {
      ..off,
      tallies: [tally(20, 1_000_000_000), tally(21, 2_000_000_000)],
    }
  !run(
    Register,
    register_tx()
      |> map_in(0, fn(_) { short_out(off) })
      |> map_out(0, fn(_) { short_out(off_t) }),
  )
}

test exit_waits_for_the_registration_deadline_whatever_the_output_says() {
  let lo = 25 * day - 1
  !run(
    ExitShort,
    exit_tx()
      |> at(lo, lo + 600_000)
      |> map_out(
          0,
          fn(_) {
            short_out(ShortState { ..s_active([]), active: False, last_exit: lo })
          },
        ),
  )
}

test a_request_payable_exactly_at_the_lower_bound_counts_towards_the_veto() {
  let owed = RequestState { ..req(alice, 1_000_000_001, 20), payable_after: lo_e() }
  run(
    VetoDefund,
    veto_tx()
      |> refs([inp(70, shard_out(0, shard0(), 5_000_000_000)), inp(60, req_out(owed))]),
  )
}
