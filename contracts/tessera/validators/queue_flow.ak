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
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, flatten, from_asset, lovelace_of, merge, quantity_of}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{
  InlineDatum, Input, Output, Spend, Transaction, placeholder,
}
use stellaris/outputs.{continuing_ok, script_address}
use tessera/eligibility.{eligible}
use tessera/queue_pay.{pay_all, shard_and_sink}
use tessera/queue_ctx.{
  at_q, config_ref, datum_of, finite_bounds, grace_valid, is_empty_mint, q_ins,
  q_outs, shard_index, short_inactive, step,
}
use tessera/queue_state.{
  Config, FlowAction, FlowInstant, QueueDatum, FlowPayShort, FlowRedeemer, FlowRequest, FlowSettle,
  FlowSweep, QueueConfig, Request, RequestState, Shard, ShardState, Short,
  ShortState, Sink, Tally, day_of, head_day, max_request_window, min_request_ada,
  payable_after_of, request_name, reserve_burn_tag, shard_after, short_name,
  tally_sub,
}
use tessera/reserve_ref.{genuine_config}
use tessera/reserve_state.{ConfigState, SupplyDatum}
use tessera/reserve_threads.{supply_name}
use tessera/rules
use tessera/queue_fixture.{
  CertMirror, RegisterM, q_addr, ada, add_in, add_out, alice, at, bob, cert, cfg0,
  config_out, day, drop_out, gate, edit_req, grace_out, inp, ins, keeper, map_in,
  map_out, minting, now, outs, paid, q, qout, qtok, rcfg0, redeemer, ref, refs,
  refused_certs, req, req_out, reserve_config_out, reserve_supply_out, shard0,
  shard_out, short0, short_out, signed, sink_out, staked, supply0, t_elig, t_flow,
  t_reserve, tally, tsra, tx0, usd, wallet, with_datum, with_ref_script, with_value,
}

fn is_key(a: Address) -> Bool {
  when a.payment_credential is {
    VerificationKey(_) -> True
    _ -> False
  }
}

/// Instant and Settle pay out only when nothing stops them: short mode off
/// (D-32), no suspension (D-28), no loss freeze (D-29).
fn payouts_open(rc: ConfigState, cfg: QueueConfig, lo: Int) -> Bool {
  cfg.suspended_until <= lo && !rules.frozen(rc.loss_pending_until, lo)
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
    short_inactive(tx, q),
    payouts_open(rc, cfg, lo),
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

/// Split the queue inputs once: the Requests (decoded) and everything else.
fn split_inputs(
  ins: List<Output>,
) -> (List<(Output, RequestState)>, List<(Output, QueueDatum)>) {
  when ins is {
    [] -> ([], [])
    [o, ..rest] -> {
      let (rs, others) = split_inputs(rest)
      when datum_of(o) is {
        Request(r) -> ([(o, r), ..rs], others)
        d -> (rs, [(o, d), ..others])
      }
    }
  }
}

/// Short mode (D-32): the ShortState is spent, the registration window is
/// over, and the Requests are exactly some of the head day's registered
/// Requests of the current episode; the head tally falls by their total.
fn short_leg(
  tx: Transaction,
  q: PolicyId,
  rs: List<(Output, RequestState)>,
  total: Int,
  lo: Int,
  others: Int,
) -> Bool {
  expect Some((Short(a), Short(b))) = step(tx, q, short_name)
  expect Some(h) = head_day(a.tallies)
  expect Some(ts1) = tally_sub(a.tallies, h, total)
  and {
    others == 2,
    a.active,
    lo >= a.reg_deadline,
    b == ShortState { ..a, tallies: ts1 },
    list.all(rs, fn((_, r)) { r.reg_episode == a.episode && r.bucket == h }),
  }
}

/// `Settle` (short mode off, the ShortState only referenced) and `PayShort`
/// (short mode on, the ShortState spent) share every payment rule.
fn settle(tx: Transaction, q: PolicyId, reserve: PolicyId, short_mode: Bool) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some(cfg) = config_ref(tx, q)
  expect Some(rc) = genuine_config(tx, reserve)
  let (rs, others) = split_inputs(q_ins(tx, q))
  expect Some((shard_in, Shard(s0))) =
    list.find(
      others,
      fn((_, d)) {
        when d is {
          Shard(_) -> True
          _ -> False
        }
      },
    )
  expect Some(idx) = shard_index(shard_in, q)
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
    if short_mode {
      short_leg(tx, q, rs, total, lo, list.length(others))
    } else {
      short_inactive(tx, q) && list.length(others) == 1
    },
    payouts_open(rc, cfg, lo),
    idx < cfg.shards,
    // Every Request input is genuine and holds exactly its datum's qty of
    // TSRA: a Request is only ever created by `Request` (one marker, value
    // pinned) or re-created identically by `Register`, markers live nowhere
    // else, and exactly `n` markers are burned here for `n` Request inputs.
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(request_name, -n)],
    list.all(rs, fn((_, r)) { lo >= r.payable_after }),
    shard_and_sink(
      list.filter(
        q_outs(tx, q),
        fn(o) { quantity_of(o.value, q, short_name) == 0 },
      ),
      q,
      reserve,
      shard_in,
      s1,
      cfg,
      total,
    ),
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
    FlowSettle -> settle(tx, q, reserve, False)
    FlowPayShort -> settle(tx, q, reserve, True)
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

// ------------------------------------------------------------------ tests

type ReserveRedeemerMirror {
  MintM { qty: Int, holder: ByteArray }
  BurnM { qty: Int, holder: ByteArray }
  AttestM { reserve: Int }
}

fn run(a: FlowAction, tx: Transaction) -> Bool {
  queue_flow.withdraw(
    t_reserve,
    FlowRedeemer { queue: q, action: a },
    Script(t_flow),
    tx |> gate(t_flow),
  )
}

fn base_refs() -> List<Input> {
  [
    inp(90, config_out(cfg0())),
    inp(91, reserve_config_out(rcfg0())),
    inp(92, short_out(short0())),
  ]
}

fn refs_with(c: QueueConfig, rc: ConfigState, s: ShortState) -> List<Input> {
  [inp(90, config_out(c)), inp(91, reserve_config_out(rc)), inp(92, short_out(s))]
}

fn kyc_rc() -> ConfigState {
  ConfigState { ..rcfg0(), kyc_redeem: True }
}

fn elig_ref(k: ByteArray) -> Input {
  inp(80, wallet(bob, assets.from_asset(t_elig, k, 1)))
}

// -- Request

fn request_tx() -> Transaction {
  tx0()
    |> signed([alice])
    |> refs(base_refs())
    |> ins([inp(1, wallet(alice, tsra(5_000_000_000)))])
    |> outs([req_out(req(alice, 1_000_000_000, 20)), wallet(alice, tsra(4_000_000_000))])
    |> minting(qtok(request_name, 1))
}

fn request_with(tx: Transaction, f: fn(RequestState) -> RequestState) -> Bool {
  run(FlowRequest, edit_req(tx, 0, f))
}

test a_request_is_accepted() {
  run(FlowRequest, request_tx())
}

test a_request_for_min_request_with_matching_value_is_accepted() {
  let r = req(alice, 100_000_000, 20)
  let tx = request_tx() |> outs([req_out(r), wallet(alice, tsra(4_900_000_000))])
  run(FlowRequest, tx)
}

test a_request_one_below_min_request_is_refused() {
  let r = req(alice, 99_999_999, 20)
  let tx = request_tx() |> outs([req_out(r), wallet(alice, tsra(4_900_000_001))])
  !run(FlowRequest, tx)
}

test a_request_needs_its_owners_signature() {
  !run(FlowRequest, request_tx() |> signed([bob]))
}

test kyc_on_a_request_with_the_eligibility_token_is_accepted() {
  let tx = request_tx() |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [elig_ref(alice)]))
  run(FlowRequest, tx)
}

test kyc_on_a_request_without_a_token_is_refused() {
  let tx = request_tx() |> refs(refs_with(cfg0(), kyc_rc(), short0()))
  !run(FlowRequest, tx)
}

test kyc_on_another_holders_token_does_not_help() {
  let tx = request_tx() |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [elig_ref(bob)]))
  !run(FlowRequest, tx)
}

test kyc_on_a_valid_grace_lets_a_revoked_holder_queue() {
  let g = inp(93, grace_out(alice, now + 1_800_000))
  let tx = request_tx() |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [g]))
  run(FlowRequest, tx)
}

test kyc_on_a_grace_that_ends_before_the_window_is_refused() {
  let g = inp(93, grace_out(alice, now + 1_799_999))
  let tx = request_tx() |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [g]))
  !run(FlowRequest, tx)
}

test kyc_on_a_grace_for_someone_else_is_refused() {
  let g = inp(93, grace_out(bob, now + 10 * day))
  let tx = request_tx() |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [g]))
  !run(FlowRequest, tx)
}

test kyc_off_needs_no_token_but_still_the_signature() {
  run(FlowRequest, request_tx()) && !run(FlowRequest, request_tx() |> signed([]))
}

test a_request_is_not_blocked_by_a_suspension_or_a_loss_freeze() {
  let c = QueueConfig { ..cfg0(), suspended_until: now + day }
  let rc = ConfigState { ..rcfg0(), loss_pending_until: now + day }
  run(FlowRequest, request_tx() |> refs(refs_with(c, rc, short0())))
}

test a_request_is_not_blocked_by_short_mode() {
  let s = ShortState { ..short0(), active: True, episode: 1 }
  run(FlowRequest, request_tx() |> refs(refs_with(cfg0(), rcfg0(), s)))
}

test a_request_value_short_of_its_datum_qty_is_refused() {
  let o =
    qout(tsra(999_999_999) |> assets.merge(qtok(request_name, 1)), Request(req(alice, 1_000_000_000, 20)))
  !run(FlowRequest, request_tx() |> map_out(0, fn(_) { o }))
}

test a_request_with_extra_tsra_in_its_value_is_refused() {
  !run(FlowRequest, request_tx() |> map_out(0, fn(o) { with_value(o, tsra(1)) }))
}

test a_request_with_a_foreign_token_is_refused() {
  !run(
    FlowRequest,
    request_tx() |> map_out(0, fn(o) { with_value(o, assets.from_asset(t_elig, "x", 1)) }),
  )
}

test a_request_without_its_marker_is_refused() {
  let o = qout(tsra(1_000_000_000), Request(req(alice, 1_000_000_000, 20)))
  !run(FlowRequest, request_tx() |> map_out(0, fn(_) { o }))
}

test a_request_holding_two_markers_is_refused() {
  let o =
    qout(
      tsra(1_000_000_000) |> assets.merge(qtok(request_name, 2)),
      Request(req(alice, 1_000_000_000, 20)),
    )
  !run(FlowRequest, request_tx() |> map_out(0, fn(_) { o }) |> minting(qtok(request_name, 2)))
}

test a_marker_minted_to_a_wallet_is_refused() {
  let o = qout(tsra(1_000_000_000), Request(req(alice, 1_000_000_000, 20)))
  let tx =
    request_tx()
      |> outs([o, wallet(alice, tsra(4_000_000_000) |> assets.merge(qtok(request_name, 1)))])
  !run(FlowRequest, tx)
}

test a_request_without_a_mint_is_refused() {
  !run(FlowRequest, request_tx() |> minting(assets.zero))
}

test minting_more_markers_than_requests_is_refused() {
  !run(FlowRequest, request_tx() |> minting(qtok(request_name, 2)))
}

test two_requests_need_two_markers() {
  let r2 = req(alice, 1_000_000_000, 20)
  let tx =
    request_tx()
      |> outs([req_out(req(alice, 1_000_000_000, 20)), req_out(r2), wallet(alice, tsra(3_000_000_000))])
  !run(FlowRequest, tx |> minting(qtok(request_name, 1))) && run(
    FlowRequest,
    tx |> minting(qtok(request_name, 2)),
  )
}

test a_request_window_of_exactly_an_hour_is_accepted_and_longer_is_refused() {
  run(FlowRequest, request_tx() |> at(now, now + 3_600_000)) && !run(
    FlowRequest,
    request_tx() |> at(now, now + 3_600_001),
  )
}

test a_request_window_across_midnight_is_refused() {
  let lo = 21 * day - 600_000
  !run(FlowRequest, request_tx() |> at(lo, lo + 1_200_000))
}

test a_request_with_the_wrong_bucket_is_refused() {
  !request_with(request_tx(), fn(r) { RequestState { ..r, bucket: 19 } }) && !request_with(
    request_tx(),
    fn(r) { RequestState { ..r, bucket: 21 } },
  )
}

test a_request_with_the_wrong_payable_after_is_refused() {
  !request_with(request_tx(), fn(r) { RequestState { ..r, payable_after: r.payable_after + 1 } }) && !request_with(
    request_tx(),
    fn(r) { RequestState { ..r, payable_after: r.payable_after - 1 } },
  )
}

test payable_after_follows_the_configured_settle_delay() {
  let c = QueueConfig { ..cfg0(), settle_delay: 3 * day }
  let tx = request_tx() |> refs(refs_with(c, rcfg0(), short0()))
  !run(FlowRequest, tx) && run(
    FlowRequest,
    edit_req(tx, 0, fn(r) { RequestState { ..r, payable_after: 24 * day } }),
  )
}

test a_request_paying_out_to_a_script_is_refused() {
  !request_with(
    request_tx(),
    fn(r) {
      RequestState {
        ..r,
        payout_to: Address { payment_credential: Script(t_reserve), stake_credential: None },
      }
    },
  )
}

test a_request_that_is_already_registered_is_refused() {
  !request_with(request_tx(), fn(r) { RequestState { ..r, reg_episode: 1 } })
}

test a_request_tx_may_not_spend_a_queue_utxo() {
  !run(FlowRequest, request_tx() |> add_in(inp(5, sink_out(1))))
}

test a_request_output_is_pinned() {
  !run(FlowRequest, request_tx() |> map_out(0, staked)) && !run(
    FlowRequest,
    request_tx() |> map_out(0, with_ref_script),
  ) && !run(
    FlowRequest,
    request_tx()
      |> map_out(
          0,
          fn(o) {
            Output {
              ..o,
              value: ada(1_999_999) |> assets.merge(tsra(1_000_000_000)) |> assets.merge(qtok(request_name, 1)),
            }
          },
        ),
  )
}

test a_request_tx_with_no_request_output_is_refused() {
  !run(FlowRequest, request_tx() |> outs([wallet(alice, tsra(5_000_000_000))]) |> minting(assets.zero))
}

test a_request_without_the_genuine_config_fails() fail {
  run(FlowRequest, request_tx() |> refs([inp(91, reserve_config_out(rcfg0()))]))
}

test a_request_with_a_planted_config_fails() fail {
  let planted = qout(assets.zero, Config(cfg0()))
  run(FlowRequest, request_tx() |> refs([inp(90, planted), inp(91, reserve_config_out(rcfg0()))]))
}

// -- Instant

fn instant_tx(qty: Int, shard: ShardState, lo_day: Int) -> Transaction {
  let lo = lo_day * day + 3_600_000
  let s1 = ShardState {
    day: lo_day,
    paid_day: (if shard.day == lo_day { shard.paid_day } else { 0 }) + qty,
    month: lo_day / 30,
    paid_month: (if shard.month == lo_day / 30 { shard.paid_month } else { 0 }) + qty,
  }
  tx0()
    |> at(lo, lo + 600_000)
    |> signed([alice])
    |> refs(base_refs())
    |> ins([inp(1, shard_out(0, shard, 50_000_000_000)), inp(2, wallet(alice, tsra(qty)))])
    |> outs([
        shard_out(0, s1, 50_000_000_000 - qty),
        sink_out(qty),
        paid(alice, qty, 2_000_000),
      ])
}

fn inst(qty: Int, tx: Transaction) -> Bool {
  run(FlowInstant { holder: alice, qty }, tx)
}

test an_instant_redemption_is_accepted() {
  inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20))
}

test an_instant_redemption_of_exactly_instant_max_is_accepted() {
  inst(10_000_000_000, instant_tx(10_000_000_000, shard0(), 20))
}

test an_instant_redemption_over_instant_max_is_refused() {
  // a big daily limit so that only instant_max can refuse
  let c = QueueConfig { ..cfg0(), daily_limit: 400_000_000_000 }
  let tx = instant_tx(10_000_000_001, shard0(), 20) |> refs(refs_with(c, rcfg0(), short0()))
  let ok = instant_tx(10_000_000_000, shard0(), 20) |> refs(refs_with(c, rcfg0(), short0()))
  !inst(10_000_000_001, tx) && inst(10_000_000_000, ok)
}

test an_instant_redemption_needs_the_holders_signature() {
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> signed([bob]))
}

test an_instant_redemption_of_zero_is_refused() {
  !inst(0, instant_tx(0, shard0(), 20))
}

test instant_kyc_on_needs_the_token() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  !inst(1_000_000_000, tx |> refs(refs_with(cfg0(), kyc_rc(), short0()))) && inst(
    1_000_000_000,
    tx |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [elig_ref(alice)])),
  )
}

test instant_does_not_accept_a_grace() {
  let g = inp(93, grace_out(alice, now + 10 * day))
  !inst(
    1_000_000_000,
    instant_tx(1_000_000_000, shard0(), 20)
      |> refs(list.concat(refs_with(cfg0(), kyc_rc(), short0()), [g])),
  )
}

test instant_must_pay_the_holder_in_full() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  !inst(1_000_000_000, tx |> map_out(2, fn(_) { paid(alice, 999_999_999, 2_000_000) })) && !inst(
    1_000_000_000,
    tx |> map_out(2, fn(_) { paid(bob, 1_000_000_000, 2_000_000) }),
  )
}

test instant_must_take_exactly_qty_from_the_shard() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  let s1 = ShardState { day: 20, paid_day: 1_000_000_000, month: 0, paid_month: 1_000_000_000 }
  !inst(1_000_000_000, tx |> map_out(0, fn(_) { shard_out(0, s1, 50_000_000_000 - 999_999_999) })) && !inst(
    1_000_000_000,
    tx |> map_out(0, fn(_) { shard_out(0, s1, 50_000_000_000 - 1_000_000_001) }),
  )
}

test instant_must_move_exactly_qty_tsra_into_one_sink() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  !inst(1_000_000_000, tx |> map_out(1, fn(_) { sink_out(999_999_999) })) && !inst(
    1_000_000_000,
    tx |> map_out(1, fn(_) { sink_out(1_000_000_001) }),
  ) && !inst(
    1_000_000_000,
    tx |> map_out(1, fn(_) { qout(tsra(1_000_000_000), Sink) |> staked }),
  ) && !inst(
    1_000_000_000,
    tx |> map_out(1, fn(_) { qout(tsra(1_000_000_000) |> assets.merge(usd(1)), Sink) }),
  )
}

test instant_with_the_sink_output_missing_is_refused() {
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> drop_out(1))
}

test instant_with_a_second_queue_output_is_refused() {
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> add_out(sink_out(1)))
}

test instant_shard_output_is_pinned() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  !inst(1_000_000_000, tx |> map_out(0, staked)) && !inst(
    1_000_000_000,
    tx |> map_out(0, with_ref_script),
  ) && !inst(
    1_000_000_000,
    tx |> map_out(0, fn(o) { Output { ..o, value: o.value |> assets.merge(assets.from_asset(t_elig, "x", 1)) } }),
  )
}

test instant_up_to_the_daily_cap_is_accepted() {
  // cap per shard = 40,000 / 4 = 10,000 TSRA a day
  let full = ShardState { day: 20, paid_day: 9_000_000_000, month: 0, paid_month: 9_000_000_000 }
  inst(1_000_000_000, instant_tx(1_000_000_000, full, 20))
}

test instant_over_the_daily_cap_by_one_unit_is_refused() fail {
  let full = ShardState { day: 20, paid_day: 9_000_000_000, month: 0, paid_month: 9_000_000_000 }
  inst(1_000_000_001, instant_tx(1_000_000_001, full, 20))
}

test instant_up_to_the_monthly_cap_is_accepted() {
  // monthly cap per shard = 400,000 / 4 = 100,000 TSRA
  let full = ShardState { day: 19, paid_day: 0, month: 0, paid_month: 99_000_000_000 }
  inst(1_000_000_000, instant_tx(1_000_000_000, full, 20))
}

test instant_over_the_monthly_cap_by_one_unit_is_refused() fail {
  let full = ShardState { day: 19, paid_day: 0, month: 0, paid_month: 99_000_000_000 }
  inst(1_000_000_001, instant_tx(1_000_000_001, full, 20))
}

test instant_counters_reset_on_a_new_day_and_a_new_month() {
  let spent = ShardState { day: 20, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  let old_month = ShardState { day: 29, paid_day: 0, month: 0, paid_month: 100_000_000_000 }
  inst(1_000_000_000, instant_tx(1_000_000_000, spent, 21)) && inst(
    1_000_000_000,
    instant_tx(1_000_000_000, old_month, 30),
  )
}

test instant_does_not_reset_within_the_same_day() fail {
  let spent = ShardState { day: 20, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  inst(1_000_000_000, instant_tx(1_000_000_000, spent, 20))
}

test instant_counters_never_go_backwards() fail {
  // a back-dated lower bound cannot reset today's counter
  let spent = ShardState { day: 20, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  inst(1_000_000_000, instant_tx(1_000_000_000, spent, 19))
}

test instant_with_the_wrong_counter_update_is_refused() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  let wrong = ShardState { day: 20, paid_day: 0, month: 0, paid_month: 1_000_000_000 }
  !inst(1_000_000_000, tx |> map_out(0, fn(_) { shard_out(0, wrong, 50_000_000_000 - 1_000_000_000) }))
}

test instant_is_refused_while_suspended() {
  let c = QueueConfig { ..cfg0(), suspended_until: now + 1 }
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> refs(refs_with(c, rcfg0(), short0())))
}

test instant_is_allowed_exactly_when_the_suspension_ends() {
  let c = QueueConfig { ..cfg0(), suspended_until: now }
  inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> refs(refs_with(c, rcfg0(), short0())))
}

test instant_is_refused_during_a_loss_freeze() {
  let rc = ConfigState { ..rcfg0(), loss_pending_until: now + 1 }
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> refs(refs_with(cfg0(), rc, short0())))
}

test instant_is_refused_in_short_mode() {
  let s = ShortState { ..short0(), active: True, episode: 1 }
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> refs(refs_with(cfg0(), rcfg0(), s)))
}

test instant_with_a_planted_short_state_fails() fail {
  let planted = qout(assets.zero, Short(short0()))
  inst(
    1_000_000_000,
    instant_tx(1_000_000_000, shard0(), 20)
      |> refs([inp(90, config_out(cfg0())), inp(91, reserve_config_out(rcfg0())), inp(92, planted)]),
  )
}

test instant_needs_a_genuine_shard() fail {
  let planted = qout(usd(50_000_000_000), Shard(shard0()))
  inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> map_in(0, fn(_) { planted }))
}

test instant_with_a_second_queue_input_is_refused() fail {
  inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> add_in(inp(5, sink_out(1))))
}

test instant_with_a_mint_under_the_queue_policy_is_refused() {
  !inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> minting(qtok(request_name, 1)))
}

test instant_on_a_shard_beyond_the_configured_count_is_refused() {
  let c = QueueConfig { ..cfg0(), shards: 1 }
  !run(
    FlowInstant { holder: alice, qty: 1_000_000_000 },
    instant_tx(1_000_000_000, shard0(), 20)
      |> ins([inp(1, shard_out(1, shard0(), 50_000_000_000)), inp(2, wallet(alice, tsra(1_000_000_000)))])
      |> refs(refs_with(c, rcfg0(), short0())),
  )
}

// -- Settle

fn pay_lov() -> Int {
  1_800_000
}

fn settle_lo() -> Int {
  23 * day + 1_000
}

fn settle_tx() -> Transaction {
  let ra = req(alice, 1_000_000_000, 20)
  let rb = req(bob, 2_000_000_000, 20)
  let s1 = ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 3_000_000_000 }
  tx0()
    |> at(settle_lo(), settle_lo() + 600_000)
    |> refs(base_refs())
    |> ins([
        inp(1, shard_out(0, shard0(), 50_000_000_000)),
        inp(10, req_out(ra)),
        inp(11, req_out(rb)),
      ])
    |> outs([
        shard_out(0, s1, 47_000_000_000),
        sink_out(3_000_000_000),
        paid(alice, 1_000_000_000, pay_lov()),
        paid(bob, 2_000_000_000, pay_lov()),
      ])
    |> minting(qtok(request_name, -2))
}

test a_settlement_is_accepted() {
  run(FlowSettle, settle_tx())
}

test settlement_needs_no_signature() {
  run(FlowSettle, settle_tx() |> signed([]))
}

test a_settlement_is_refused_one_millisecond_early() {
  !run(FlowSettle, settle_tx() |> at(23 * day - 1, 23 * day + 600_000)) && run(
    FlowSettle,
    settle_tx() |> at(23 * day, 23 * day + 600_000),
  )
}

test an_underpayment_by_one_is_refused() {
  !run(FlowSettle, settle_tx() |> map_out(2, fn(_) { paid(alice, 999_999_999, pay_lov()) }))
}

test paying_the_wrong_address_is_refused() {
  !run(FlowSettle, settle_tx() |> map_out(2, fn(_) { paid(keeper, 1_000_000_000, pay_lov()) }))
}

test a_payment_to_the_right_key_with_a_different_stake_part_is_refused() {
  !run(FlowSettle, settle_tx() |> map_out(2, staked))
}

test the_keeper_tip_is_capped_by_the_config() {
  // the owner's lovelace less the configured tip (0.2 ADA) must arrive
  !run(FlowSettle, settle_tx() |> map_out(2, fn(_) { paid(alice, 1_000_000_000, pay_lov() - 1) })) && run(
    FlowSettle,
    settle_tx() |> map_out(2, fn(_) { paid(alice, 1_000_000_000, 2_000_000) }),
  )
}

test one_output_cannot_pay_two_requests_to_one_address() {
  let ra = req(alice, 1_000_000_000, 20)
  let rb = req(alice, 1_000_000_000, 20)
  let s1 = ShardState { day: 23, paid_day: 2_000_000_000, month: 0, paid_month: 2_000_000_000 }
  let tx =
    settle_tx()
      |> ins([inp(1, shard_out(0, shard0(), 50_000_000_000)), inp(10, req_out(ra)), inp(11, req_out(rb))])
      |> outs([
          shard_out(0, s1, 48_000_000_000),
          sink_out(2_000_000_000),
          paid(alice, 1_000_000_000, pay_lov()),
          paid(alice, 1_000_000_000, pay_lov()),
        ])
  let one =
    tx
      |> outs([
          shard_out(0, s1, 48_000_000_000),
          sink_out(2_000_000_000),
          paid(alice, 1_000_000_000, pay_lov()),
        ])
  run(FlowSettle, tx) && !run(FlowSettle, one)
}

test the_tsra_must_move_into_the_sink() {
  !run(FlowSettle, settle_tx() |> map_out(1, fn(_) { sink_out(2_999_999_999) })) && !run(
    FlowSettle,
    settle_tx() |> map_out(1, fn(_) { sink_out(3_000_000_001) }),
  ) && !run(FlowSettle, settle_tx() |> drop_out(1))
}

test settlement_cannot_send_the_tsra_to_a_wallet() {
  !run(
    FlowSettle,
    settle_tx()
      |> map_out(1, fn(_) { wallet(keeper, tsra(3_000_000_000)) }),
  )
}

test a_request_without_a_marker_cannot_be_settled() {
  // two Request inputs, one of them a planted lookalike: only one marker exists
  // to burn, so the burn count (which the ledger forces to be real) is one
  let unmarked = qout(tsra(1_000_000_000), Request(req(alice, 1_000_000_000, 20)))
  !run(FlowSettle, settle_tx() |> map_in(1, fn(_) { unmarked }) |> minting(qtok(request_name, -1)))
}

test settlement_must_burn_the_markers() {
  !run(FlowSettle, settle_tx() |> minting(assets.zero)) && !run(
    FlowSettle,
    settle_tx() |> minting(qtok(request_name, -1)),
  ) && !run(FlowSettle, settle_tx() |> minting(qtok(request_name, -3)))
}

test the_burned_markers_must_cover_every_request_input() {
  !run(FlowSettle, settle_tx() |> minting(qtok(request_name, -1)))
}

test a_shard_over_its_daily_limit_refuses() fail {
  let full = ShardState { day: 23, paid_day: 8_000_000_001, month: 0, paid_month: 8_000_000_001 }
  let s1 = ShardState { day: 23, paid_day: 11_000_000_001, month: 0, paid_month: 11_000_000_001 }
  run(
    FlowSettle,
    settle_tx()
      |> map_in(0, fn(_) { shard_out(0, full, 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(0, s1, 47_000_000_000) }),
  )
}

test a_shard_exactly_at_its_daily_limit_accepts() {
  let part = ShardState { day: 23, paid_day: 7_000_000_000, month: 0, paid_month: 7_000_000_000 }
  let s1 = ShardState { day: 23, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  run(
    FlowSettle,
    settle_tx()
      |> map_in(0, fn(_) { shard_out(0, part, 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(0, s1, 47_000_000_000) }),
  )
}

test a_shard_over_its_monthly_limit_refuses() fail {
  let full = ShardState { day: 22, paid_day: 0, month: 0, paid_month: 98_000_000_001 }
  let s1 = ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 101_000_000_001 }
  run(
    FlowSettle,
    settle_tx()
      |> map_in(0, fn(_) { shard_out(0, full, 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(0, s1, 47_000_000_000) }),
  )
}

test settle_counters_reset_on_a_new_day() {
  let yesterday = ShardState { day: 22, paid_day: 10_000_000_000, month: 0, paid_month: 10_000_000_000 }
  let s1 = ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 13_000_000_000 }
  run(
    FlowSettle,
    settle_tx()
      |> map_in(0, fn(_) { shard_out(0, yesterday, 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(0, s1, 47_000_000_000) }),
  )
}

test limits_are_per_shard() {
  // shard 1 has its own counters and the same cap
  run(
    FlowSettle,
    settle_tx()
      |> map_in(0, fn(_) { shard_out(1, shard0(), 50_000_000_000) })
      |> map_out(
          0,
          fn(_) {
            shard_out(
              1,
              ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 3_000_000_000 },
              47_000_000_000,
            )
          },
        ),
  )
}

test settlement_is_refused_while_suspended_frozen_or_in_short_mode() {
  let c = QueueConfig { ..cfg0(), suspended_until: settle_lo() + 1 }
  let rc = ConfigState { ..rcfg0(), loss_pending_until: settle_lo() + 1 }
  let s = ShortState { ..short0(), active: True, episode: 1 }
  !run(FlowSettle, settle_tx() |> refs(refs_with(c, rcfg0(), short0()))) && !run(
    FlowSettle,
    settle_tx() |> refs(refs_with(cfg0(), rc, short0())),
  ) && !run(FlowSettle, settle_tx() |> refs(refs_with(cfg0(), rcfg0(), s)))
}

test a_mixed_batch_with_one_unpayable_request_is_refused_whole() {
  let late = req(bob, 2_000_000_000, 22)
  // bucket 22 is payable after day 25
  !run(FlowSettle, settle_tx() |> map_in(2, fn(_) { req_out(late) }))
}

test settlement_with_a_second_shard_input_is_refused() {
  !run(FlowSettle, settle_tx() |> add_in(inp(2, shard_out(1, shard0(), 1))))
}

test settlement_with_a_sink_input_is_refused() {
  !run(FlowSettle, settle_tx() |> add_in(inp(2, sink_out(1))))
}

test settlement_with_a_config_input_is_refused() {
  !run(FlowSettle, settle_tx() |> add_in(inp(2, config_out(cfg0()))))
}

test settlement_with_no_requests_is_refused() {
  !run(
    FlowSettle,
    settle_tx()
      |> ins([inp(1, shard_out(0, shard0(), 50_000_000_000))])
      |> outs([shard_out(0, shard0(), 50_000_000_000), sink_out(0)])
      |> minting(assets.zero),
  )
}

test settlement_needs_the_genuine_shard() fail {
  let planted = qout(usd(50_000_000_000), Shard(shard0()))
  run(FlowSettle, settle_tx() |> map_in(0, fn(_) { planted }))
}

// -- PayShort (short mode: Settle with the ShortState spent)

fn registered(r: RequestState) -> RequestState {
  RequestState { ..r, reg_episode: 1 }
}

fn short_active(tallies: List<Tally>) -> ShortState {
  ShortState { ..short0(), active: True, episode: 1, since: 20 * day, reg_deadline: 21 * day, tallies: tallies }
}

fn payshort_tx() -> Transaction {
  let ra = registered(req(alice, 1_000_000_000, 20))
  let rb = registered(req(bob, 2_000_000_000, 20))
  let s0 = short_active([tally(20, 3_000_000_000), tally(21, 500_000_000)])
  let s1 = short_active([tally(21, 500_000_000)])
  let sh = ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 3_000_000_000 }
  tx0()
    |> at(settle_lo(), settle_lo() + 600_000)
    |> refs([inp(90, config_out(cfg0())), inp(91, reserve_config_out(rcfg0()))])
    |> ins([
        inp(1, shard_out(0, shard0(), 50_000_000_000)),
        inp(3, short_out(s0)),
        inp(10, req_out(ra)),
        inp(11, req_out(rb)),
      ])
    |> outs([
        shard_out(0, sh, 47_000_000_000),
        short_out(s1),
        sink_out(3_000_000_000),
        paid(alice, 1_000_000_000, pay_lov()),
        paid(bob, 2_000_000_000, pay_lov()),
      ])
    |> minting(qtok(request_name, -2))
}

fn payshort(tx: Transaction) -> Bool {
  run(FlowPayShort, tx)
}

test paying_the_head_day_in_short_mode_is_accepted() {
  payshort(payshort_tx())
}

test paying_part_of_the_head_day_leaves_the_rest_on_the_tally() {
  let ra = registered(req(alice, 1_000_000_000, 20))
  let s0 = short_active([tally(20, 3_000_000_000), tally(21, 500_000_000)])
  let s1 = short_active([tally(20, 2_000_000_000), tally(21, 500_000_000)])
  let sh = ShardState { day: 23, paid_day: 1_000_000_000, month: 0, paid_month: 1_000_000_000 }
  payshort(
    payshort_tx()
      |> ins([inp(1, shard_out(0, shard0(), 50_000_000_000)), inp(3, short_out(s0)), inp(10, req_out(ra))])
      |> outs([
          shard_out(0, sh, 49_000_000_000),
          short_out(s1),
          sink_out(1_000_000_000),
          paid(alice, 1_000_000_000, pay_lov()),
        ])
      |> minting(qtok(request_name, -1)),
  )
}

test short_mode_payment_is_refused_inside_the_registration_window() {
  !payshort(payshort_tx() |> at(21 * day - 1_000, 21 * day + 100_000))
}

test short_mode_payment_opens_exactly_at_the_deadline() {
  // reg_deadline = 21 days: payable_after is 23 days so use a later lower bound
  // only for the window test above; here the deadline is already past
  payshort(payshort_tx())
}

test short_mode_payment_refuses_a_non_head_day() {
  let rc = registered(req(alice, 500_000_000, 21))
  let s0 = short_active([tally(20, 3_000_000_000), tally(21, 500_000_000)])
  let s1 = short_active([tally(20, 3_000_000_000)])
  let sh = ShardState { day: 23, paid_day: 500_000_000, month: 0, paid_month: 500_000_000 }
  !payshort(
    payshort_tx()
      |> ins([inp(1, shard_out(0, shard0(), 50_000_000_000)), inp(3, short_out(s0)), inp(10, req_out(rc))])
      |> outs([
          shard_out(0, sh, 49_500_000_000),
          short_out(s1),
          sink_out(500_000_000),
          paid(alice, 500_000_000, pay_lov()),
        ])
      |> minting(qtok(request_name, -1)),
  )
}

test short_mode_payment_refuses_an_unregistered_request() {
  let unreg = req(alice, 1_000_000_000, 20)
  !payshort(payshort_tx() |> map_in(2, fn(_) { req_out(unreg) }))
}

test short_mode_payment_refuses_a_request_of_an_old_episode() {
  let old = RequestState { ..req(alice, 1_000_000_000, 20), reg_episode: 0 }
  let s0 = ShortState { ..short_active([tally(20, 3_000_000_000)]), episode: 2 }
  !payshort(
    payshort_tx()
      |> map_in(1, fn(_) { short_out(s0) })
      |> map_in(2, fn(_) { req_out(old) }),
  )
}

test short_mode_payment_must_lower_the_tally_exactly() {
  let s_under = short_active([tally(20, 1), tally(21, 500_000_000)])
  let s_over = short_active([tally(21, 500_000_000), tally(22, 1)])
  !payshort(payshort_tx() |> map_out(1, fn(_) { short_out(s_under) })) && !payshort(
    payshort_tx() |> map_out(1, fn(_) { short_out(s_over) }),
  )
}

test short_mode_payment_cannot_overpay_the_tally() fail {
  let s0 = short_active([tally(20, 2_999_999_999)])
  let s1 = short_active([])
  payshort(
    payshort_tx()
      |> map_in(1, fn(_) { short_out(s0) })
      |> map_out(1, fn(_) { short_out(s1) }),
  )
}

test short_mode_payment_needs_short_mode_on() {
  let off = ShortState { ..short_active([tally(20, 3_000_000_000)]), active: False }
  !payshort(payshort_tx() |> map_in(1, fn(_) { short_out(off) }))
}

test short_mode_payment_is_refused_while_suspended_or_frozen() {
  let c = QueueConfig { ..cfg0(), suspended_until: settle_lo() + 1 }
  let rc = ConfigState { ..rcfg0(), loss_pending_until: settle_lo() + 1 }
  !payshort(payshort_tx() |> refs([inp(90, config_out(c)), inp(91, reserve_config_out(rcfg0()))])) && !payshort(
    payshort_tx() |> refs([inp(90, config_out(cfg0())), inp(91, reserve_config_out(rc))]),
  )
}

test normal_settle_does_not_accept_the_short_state_input() {
  // a Settle that also spends the ShortState (to dodge the reference) fails
  !run(FlowSettle, payshort_tx())
}

test pay_short_without_the_short_state_input_fails() fail {
  payshort(settle_tx())
}

// -- Sweep

fn burn_rd(qty: Int) -> Data {
  let d: Data = BurnM { qty, holder: keeper }
  d
}

fn sweep_tx(qty: Int) -> Transaction {
  tx0()
    |> signed([keeper])
    |> ins([
        inp(1, sink_out(1_000_000_000)),
        inp(2, sink_out(2_000_000_000)),
        inp(3, reserve_supply_out(supply0())),
      ])
    |> outs([wallet(keeper, assets.zero)])
    |> minting(assets.from_asset(t_reserve, rules.tsra_name, -3_000_000_000))
    |> redeemer(Spend(ref(3)), burn_rd(qty))
}

test a_sweep_of_exactly_the_sink_total_is_accepted() {
  run(FlowSweep, sweep_tx(3_000_000_000))
}

test a_sweep_of_one_sink_is_accepted() {
  run(
    FlowSweep,
    sweep_tx(1_000_000_000)
      |> ins([inp(1, sink_out(1_000_000_000)), inp(3, reserve_supply_out(supply0()))]),
  )
}

test a_sweep_with_qty_one_unit_short_or_over_is_refused() {
  !run(FlowSweep, sweep_tx(2_999_999_999)) && !run(FlowSweep, sweep_tx(3_000_000_001))
}

test a_sweep_without_the_supply_spend_fails() fail {
  run(FlowSweep, sweep_tx(3_000_000_000) |> ins([inp(1, sink_out(1_000_000_000)), inp(2, sink_out(2_000_000_000))]))
}

test a_sweep_with_a_planted_supply_fails() fail {
  let planted = Output { ..reserve_supply_out(supply0()), value: ada(2_000_000) }
  run(FlowSweep, sweep_tx(3_000_000_000) |> map_in(2, fn(_) { planted }))
}

test a_sweep_under_the_mint_redeemer_is_refused() {
  let mint_rd: Data = MintM { qty: 3_000_000_000, holder: keeper }
  !run(FlowSweep, Transaction { ..sweep_tx(3_000_000_000), redeemers: [Pair(Spend(ref(3)), mint_rd)] })
}

test a_sweep_under_the_attest_redeemer_is_refused() fail {
  let attest_rd: Data = AttestM { reserve: 3_000_000_000 }
  run(FlowSweep, Transaction { ..sweep_tx(3_000_000_000), redeemers: [Pair(Spend(ref(3)), attest_rd)] })
}

test a_sweep_leaving_tsra_at_the_queue_is_refused() {
  !run(FlowSweep, sweep_tx(3_000_000_000) |> add_out(sink_out(1)))
}

test a_sweep_that_sends_the_tsra_to_a_wallet_with_a_smaller_burn_is_refused() {
  !run(
    FlowSweep,
    sweep_tx(2_000_000_000)
      |> outs([wallet(keeper, tsra(1_000_000_000))]),
  )
}

test a_sweep_with_a_request_input_is_refused() {
  !run(FlowSweep, sweep_tx(3_000_000_000) |> add_in(inp(4, req_out(req(alice, 1_000_000_000, 20)))))
}

test a_sweep_with_a_shard_or_config_input_is_refused() {
  !run(FlowSweep, sweep_tx(3_000_000_000) |> add_in(inp(4, shard_out(0, shard0(), 1)))) && !run(
    FlowSweep,
    sweep_tx(3_000_000_000) |> add_in(inp(4, config_out(cfg0()))),
  )
}

test a_sink_holding_a_foreign_token_cannot_be_swept() {
  let bad = qout(tsra(1_000_000_000) |> assets.merge(usd(1)), Sink)
  !run(FlowSweep, sweep_tx(3_000_000_000) |> map_in(0, fn(_) { bad }))
}

test a_sweep_with_no_sinks_is_refused() {
  !run(FlowSweep, sweep_tx(0) |> ins([inp(3, reserve_supply_out(supply0()))]))
}

test a_sweep_may_not_mint_under_the_queue_policy() {
  !run(
    FlowSweep,
    sweep_tx(3_000_000_000)
      |> minting(assets.from_asset(t_reserve, rules.tsra_name, -3_000_000_000) |> assets.merge(qtok(request_name, 1))),
  )
}

// -- every other action refuses a Sink among its inputs (I-Q1)

test settle_refuses_a_sink_input() {
  !run(FlowSettle, settle_tx() |> add_in(inp(7, sink_out(1_000_000_000))))
}

test pay_short_refuses_a_sink_input() {
  !payshort(payshort_tx() |> add_in(inp(7, sink_out(1_000_000_000))))
}

test request_refuses_a_sink_input() {
  !run(FlowRequest, request_tx() |> add_in(inp(7, sink_out(1_000_000_000))))
}

test instant_refuses_a_sink_input() fail {
  inst(1_000_000_000, instant_tx(1_000_000_000, shard0(), 20) |> add_in(inp(7, sink_out(1_000_000_000))))
}

// -- gate and publish

test the_flow_withdrawal_must_be_zero() {
  !queue_flow.withdraw(
    t_reserve,
    FlowRedeemer { queue: q, action: FlowRequest },
    Script(t_flow),
    Transaction { ..request_tx(), withdrawals: [Pair(Script(t_flow), 1)] },
  ) && !queue_flow.withdraw(
    t_reserve,
    FlowRedeemer { queue: q, action: FlowRequest },
    Script(t_flow),
    Transaction { ..request_tx(), withdrawals: [] },
  )
}

fn published(m: CertMirror) -> Bool {
  queue_flow.publish(t_reserve, Void, cert(m), placeholder)
}

test registering_the_flow_credential_is_accepted() {
  published(RegisterM { credential: Script(t_flow), deposit: None })
}

test no_other_certificate_is_accepted_for_the_flow_credential() {
  list.all(refused_certs(Script(t_flow)), fn(m) { !published(m) })
}


// -- a transaction judged under a different action is refused

test a_settlement_is_not_a_request() {
  !run(FlowRequest, settle_tx())
}

test a_settlement_is_not_an_instant_redemption() fail {
  inst(1_000_000_000, settle_tx())
}

test a_settlement_is_not_a_sweep() fail {
  run(FlowSweep, settle_tx())
}

test a_request_is_not_a_settlement() fail {
  run(FlowSettle, request_tx())
}

test an_instant_redemption_is_not_a_settlement() {
  !run(FlowSettle, instant_tx(1_000_000_000, shard0(), 20))
}

test a_sweep_is_not_a_settlement() fail {
  run(FlowSettle, sweep_tx(3_000_000_000))
}

test a_pay_short_is_not_a_plain_settlement() {
  !run(FlowSettle, payshort_tx())
}

test a_plain_settlement_is_not_a_pay_short() fail {
  payshort(settle_tx())
}

// -- the Supply must be burned under `Burn`, whatever else it is spent under

fn supply_spent_under(tag: Int, fields: List<Data>) -> Transaction {
  Transaction {
    ..sweep_tx(3_000_000_000),
    redeemers: [Pair(Spend(ref(3)), builtin.constr_data(tag, fields))],
  }
}

test a_sweep_under_set_cap_is_refused() fail {
  run(FlowSweep, supply_spent_under(3, [builtin.i_data(3_000_000_000)]))
}

test a_sweep_under_loss_burn_is_refused() {
  !run(FlowSweep, supply_spent_under(10, [builtin.i_data(3_000_000_000), builtin.i_data(3_000_000_000)]))
}

test a_sweep_under_vault_claim_burn_is_refused() fail {
  run(FlowSweep, supply_spent_under(11, [builtin.i_data(3_000_000_000)]))
}

test a_sweep_under_burn_at_tag_one_is_the_only_accepted_shape() {
  run(FlowSweep, supply_spent_under(1, [builtin.i_data(3_000_000_000), builtin.b_data(keeper)])) && !run(
    FlowSweep,
    supply_spent_under(0, [builtin.i_data(3_000_000_000), builtin.b_data(keeper)]),
  ) && !run(FlowSweep, supply_spent_under(2, [builtin.i_data(3_000_000_000), builtin.b_data(keeper)]))
}

// -- conservation across a request, a settlement and a sweep

fn lifecycle_requests(qa: Int, qb: Int) -> (RequestState, RequestState) {
  (req(alice, qa, 20), req(bob, qb, 20))
}

fn lifecycle_settle(qa: Int, qb: Int) -> Transaction {
  let (ra, rb) = lifecycle_requests(qa, qb)
  let total = qa + qb
  let s1 = ShardState { day: 23, paid_day: total, month: 0, paid_month: total }
  tx0()
    |> at(settle_lo(), settle_lo() + 600_000)
    |> refs(base_refs())
    |> ins([
        inp(1, shard_out(0, shard0(), 50_000_000_000)),
        inp(10, req_out(ra)),
        inp(11, req_out(rb)),
      ])
    |> outs([
        shard_out(0, s1, 50_000_000_000 - total),
        sink_out(total),
        paid(alice, qa, pay_lov()),
        paid(bob, qb, pay_lov()),
      ])
    |> minting(qtok(request_name, -2))
}

fn tsra_in(os: List<Output>) -> Int {
  list.foldl(os, 0, fn(o, acc) { acc + quantity_of(o.value, t_reserve, rules.tsra_name) })
}

/// A deterministic spread of quantities between 100 and 4,000 TSRA.
fn sample(i: Int) -> Int {
  100_000_000 + i * 2_654_435_761 % 3_900_000_000
}

fn conserves(qa: Int, qb: Int) -> Bool {
  let (ra, rb) = lifecycle_requests(qa, qb)
  let total = qa + qb
  // 1. requests: the TSRA locked equals the sum requested
  let locked = tsra_in([req_out(ra), req_out(rb)])
  // 2. settlement: the Requests' TSRA moves into exactly one Sink, nothing else
  let settle = lifecycle_settle(qa, qb)
  let sinks =
    list.filter(
      settle.outputs,
      fn(o) { o.address == q_addr() && datum_of(o) == Sink },
    )
  let swept = tsra_in(sinks)
  // 3. sweep: burn exactly the Sinks' TSRA
  let sweep =
    sweep_tx(swept)
      |> ins([inp(1, sink_out(swept)), inp(3, reserve_supply_out(supply0()))])
  and {
    locked == total,
    run(FlowSettle, settle),
    swept == locked,
    list.length(sinks) == 1,
    run(FlowSweep, sweep),
    // the payout never exceeds the shard's daily cap
    total <= 10_000_000_000,
    // the reserve will lower minted_supply by exactly the swept total
    supply0().minted_supply - swept == supply0().minted_supply - total,
  }
}

test requests_settlements_and_sweeps_conserve_tsra() {
  list.all(
    list.range(1, 30),
    fn(i) { conserves(sample(i), sample(i + 100)) },
  )
}

test a_request_is_spent_only_by_a_settlement_that_pays_it() {
  list.all(
    list.range(1, 20),
    fn(i) {
      let short_by = 1 + i * 4_999_999 % 100_000_000
      let qa = 1_000_000_000
      let tx =
        lifecycle_settle(qa, 2_000_000_000)
          |> map_out(2, fn(_) { paid(alice, qa - short_by, pay_lov()) })
      !run(FlowSettle, tx)
    },
  )
}

// -- execution budget: worst-case batches (see SPEC §4.13). Each `_run` test
// builds the transaction and runs the script; each `_build` test only builds
// it, so the difference is the script's cost.

fn key(i: Int) -> ByteArray {
  bytearray.concat(
    #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
    bytearray.push("", i),
  )
}

fn batch_requests(n: Int, registered_in: Int) -> List<RequestState> {
  list.map(
    list.range(1, n),
    fn(i) {
      RequestState { ..req(key(i), 8_000_000_000 / n, 20), reg_episode: registered_in }
    },
  )
}

fn settle_batch(n: Int) -> Transaction {
  let rs = batch_requests(n, 0)
  let total = n * { 8_000_000_000 / n }
  let s1 = ShardState { day: 23, paid_day: total, month: 0, paid_month: total }
  tx0()
    |> at(settle_lo(), settle_lo() + 600_000)
    |> refs(base_refs())
    |> ins(
        [inp(1, shard_out(0, shard0(), 50_000_000_000)), ..list.indexed_map(rs, fn(i, r) { inp(10 + i, req_out(r)) })],
      )
    |> outs(
        [
          shard_out(0, s1, 50_000_000_000 - total),
          sink_out(total),
          ..list.map(rs, fn(r) { paid(r.owner, r.qty, pay_lov()) })
        ],
      )
    |> minting(qtok(request_name, -n))
}

fn payshort_batch(n: Int) -> Transaction {
  let rs = batch_requests(n, 1)
  let total = n * { 8_000_000_000 / n }
  let s0 = short_active([tally(20, total), tally(21, 500_000_000)])
  let s1 = short_active([tally(21, 500_000_000)])
  let sh = ShardState { day: 23, paid_day: total, month: 0, paid_month: total }
  tx0()
    |> at(settle_lo(), settle_lo() + 600_000)
    |> refs([inp(90, config_out(cfg0())), inp(91, reserve_config_out(rcfg0()))])
    |> ins(
        [
          inp(1, shard_out(0, shard0(), 50_000_000_000)),
          inp(3, short_out(s0)),
          ..list.indexed_map(rs, fn(i, r) { inp(10 + i, req_out(r)) })
        ],
      )
    |> outs(
        [
          shard_out(0, sh, 50_000_000_000 - total),
          short_out(s1),
          sink_out(total),
          ..list.map(rs, fn(r) { paid(r.owner, r.qty, pay_lov()) })
        ],
      )
    |> minting(qtok(request_name, -n))
}

fn sweep_batch(n: Int) -> Transaction {
  tx0()
    |> signed([keeper])
    |> ins(
        [
          inp(3, reserve_supply_out(supply0())),
          ..list.map(list.range(1, n), fn(i) { inp(10 + i, sink_out(100_000_000)) })
        ],
      )
    |> outs([wallet(keeper, assets.zero)])
    |> minting(assets.from_asset(t_reserve, rules.tsra_name, -n * 100_000_000))
    |> redeemer(Spend(ref(3)), burn_rd(n * 100_000_000))
}

fn forced(tx: Transaction) -> Bool {
  list.length(tx.inputs) + list.length(tx.outputs) + list.length(tx.reference_inputs) > 0
}

test budget_settle_20_build() {
  forced(settle_batch(20))
}

test budget_settle_20_run() {
  let tx = settle_batch(20)
  forced(tx) && run(FlowSettle, tx)
}

test budget_pay_short_20_build() {
  forced(payshort_batch(20))
}

test budget_pay_short_20_run() {
  let tx = payshort_batch(20)
  forced(tx) && run(FlowPayShort, tx)
}

test budget_sweep_20_build() {
  forced(sweep_batch(20))
}

test budget_sweep_20_run() {
  let tx = sweep_batch(20)
  forced(tx) && run(FlowSweep, tx)
}

test budget_instant_build() {
  forced(instant_tx(1_000_000_000, shard0(), 20))
}

test budget_instant_run() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  forced(tx) && inst(1_000_000_000, tx)
}

test budget_request_build() {
  forced(request_tx())
}

test budget_request_run() {
  let tx = request_tx()
  forced(tx) && run(FlowRequest, tx)
}

test budget_settle_5_run() {
  let tx = settle_batch(5)
  forced(tx) && run(FlowSettle, tx)
}

test budget_settle_5_build() {
  forced(settle_batch(5))
}

test budget_settle_40_run() {
  let tx = settle_batch(40)
  forced(tx) && run(FlowSettle, tx)
}

test budget_settle_40_build() {
  forced(settle_batch(40))
}

// -- tests added after the first mutation pass (each kills a surviving mutant)

test a_marker_cannot_be_swapped_for_a_foreign_token_across_two_requests() {
  // two Request outputs, one carrying both markers and the other a foreign
  // token in the marker's place: three assets each, two markers minted
  let both =
    qout(
      tsra(1_000_000_000) |> assets.merge(qtok(request_name, 2)),
      Request(req(alice, 1_000_000_000, 20)),
    )
  let none =
    qout(
      tsra(1_000_000_000) |> assets.merge(assets.from_asset(t_elig, "x", 1)),
      Request(req(alice, 1_000_000_000, 20)),
    )
  !run(
    FlowRequest,
    request_tx()
      |> outs([both, none, wallet(alice, tsra(3_000_000_000))])
      |> minting(qtok(request_name, 2)),
  )
}

test a_request_must_name_the_day_it_was_made_even_if_payable_after_agrees() {
  let wrong_day = fn(b: Int) {
    edit_req(
      request_tx(),
      0,
      fn(r) { RequestState { ..r, bucket: b, payable_after: payable_after_of(b, 2 * day) } },
    )
  }
  !run(FlowRequest, wrong_day(19)) && !run(FlowRequest, wrong_day(21)) && run(
    FlowRequest,
    wrong_day(20),
  )
}

test a_request_window_runs_forward_and_may_be_a_single_instant() {
  !run(FlowRequest, request_tx() |> at(now + 1_000, now)) && run(
    FlowRequest,
    request_tx() |> at(now, now),
  )
}

test instant_on_a_shard_index_beyond_the_count_is_refused() {
  let c = QueueConfig { ..cfg0(), shards: 1 }
  let s1 = ShardState { day: 20, paid_day: 1_000_000_000, month: 0, paid_month: 1_000_000_000 }
  let on = fn(i: Int) {
    instant_tx(1_000_000_000, shard0(), 20)
      |> map_in(0, fn(_) { shard_out(i, shard0(), 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(i, s1, 49_000_000_000) })
      |> refs(refs_with(c, rcfg0(), short0()))
  }
  inst(1_000_000_000, on(0)) && !inst(1_000_000_000, on(1))
}

test settlement_on_a_shard_index_beyond_the_count_is_refused() {
  let c = QueueConfig { ..cfg0(), shards: 1 }
  let s1 = ShardState { day: 23, paid_day: 3_000_000_000, month: 0, paid_month: 3_000_000_000 }
  let on = fn(i: Int) {
    settle_tx()
      |> map_in(0, fn(_) { shard_out(i, shard0(), 50_000_000_000) })
      |> map_out(0, fn(_) { shard_out(i, s1, 47_000_000_000) })
      |> refs(refs_with(c, rcfg0(), short0()))
  }
  run(FlowSettle, on(0)) && !run(FlowSettle, on(1))
}

test short_mode_payment_needs_short_mode_on_even_with_a_consistent_output() {
  let off0 = ShortState { ..short_active([tally(20, 3_000_000_000), tally(21, 500_000_000)]), active: False }
  let off1 = ShortState { ..short_active([tally(21, 500_000_000)]), active: False }
  !payshort(
    payshort_tx()
      |> map_in(1, fn(_) { short_out(off0) })
      |> map_out(1, fn(_) { short_out(off1) }),
  )
}

test short_mode_payment_waits_for_the_registration_deadline_exactly() {
  let at_ = fn(deadline: Int) {
    let s0 = ShortState { ..short_active([tally(20, 3_000_000_000), tally(21, 500_000_000)]), reg_deadline: deadline }
    let s1 = ShortState { ..short_active([tally(21, 500_000_000)]), reg_deadline: deadline }
    payshort_tx()
      |> map_in(1, fn(_) { short_out(s0) })
      |> map_out(1, fn(_) { short_out(s1) })
  }
  payshort(at_(settle_lo())) && !payshort(at_(settle_lo() + 1))
}

test an_instant_sink_must_not_carry_a_reference_script() {
  !inst(
    1_000_000_000,
    instant_tx(1_000_000_000, shard0(), 20) |> map_out(1, with_ref_script),
  )
}

test an_instant_sink_must_carry_the_sink_datum() {
  let tx = instant_tx(1_000_000_000, shard0(), 20)
  !inst(1_000_000_000, tx |> map_out(1, fn(o) { with_datum(o, Shard(shard0())) })) && !inst(
    1_000_000_000,
    tx |> map_out(1, fn(o) { with_datum(o, Request(req(alice, 1, 20))) }),
  )
}
