//// Redemption queue, committee flow (Phase 2.6, SPEC.md §4.1): `Genesis`,
//// `Suspend`, `Resume`, `AnnounceLimits`, `ApplyLimits`, `SyncFloor`, `Fund`,
//// `AnnounceDefund`, `Defund` and `GrantGrace`. A withdraw-zero script, like
//// `queue_flow`.
////
//// The committee is the reserve's current Config (read by reference), so a
//// reserve `Rotate` carries over. Its powers over the queue are bounded:
//// * suspension at most 3 days, then a 7-day gap (D-28);
//// * a limit decrease or a Defund is announced 7 days ahead (D-27, D-33);
//// * daily limit never below `max(10,000 TSRA, 1% of minted supply)`, checked
////   at every write and again when a decrease takes effect; `SyncFloor`
////   (anyone) lifts a limit the supply has outgrown (D-34).

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets.{
  PolicyId, flatten, from_asset, from_lovelace, lovelace_of, merge, quantity_of,
}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{Output, Transaction}
use stellaris/outputs.{continuing_ok, script_address}
use tessera/queue_ctx.{
  config_ref, datum_of, finite_bounds, is_empty_mint, q_ins, q_outs, shard_index,
  short_inactive, step, thread_among,
}
use tessera/queue_state.{
  AdminAction, AdminRedeemer, AnnounceDefund, AnnounceLimits, ApplyLimits,
  Config, Defund, Fund, Genesis, Grace, GraceState, GrantGrace, PendingDefund,
  PendingLimits, QueueConfig, Resume, Shard, ShardState, Short, ShortState,
  Suspend, SyncFloor, can_suspend, config_name, config_valid, defund_lapse_ms,
  limit_floor, limits_ok, notice_ms, short_name, shard_name, suspended,
}
use tessera/reserve_ref.{genuine_config, genuine_supply}
use tessera/reserve_state.{ConfigState, operators_valid, threshold_met}
use tessera/rules
// <hoisted test imports>
use cardano/address.{Script}
use cardano/transaction.{Input, placeholder}
use tessera/queue_fixture.{
  CertMirror, RegisterM, ada, add_in, add_out, alice, at, bob, cert, cfg0, config_out,
  day, drop_out, gate, grace_out, inp, ins, keeper, lovelace_plus, map_in,
  map_out, minting, now, op1, op2, op3, outs, q, qout, qtok, rcfg0, refs,
  refused_certs, reserve_config_out, reserve_supply_out, shard0, shard_out, short0,
  short_out, signed, sink_out, staked, supply0, t_admin, t_reserve, tx0, usd,
  wallet, with_datum, with_ref_script, with_value,
}
use cardano/assets.{Value}
use tessera/queue_state.{request_name}
use tessera/reserve_state.{SupplyState}
// </hoisted test imports>

fn committee(tx: Transaction, rc: ConfigState) -> Bool {
  operators_valid(rc.operators, rc.threshold) && threshold_met(
    rc.operators,
    rc.threshold,
    tx.extra_signatories,
  )
}

/// The Config is the only queue input and comes back as `c1`: the caller says
/// what `c1` must equal.
fn config_step(tx: Transaction, q: PolicyId) -> Option<(QueueConfig, QueueConfig)> {
  when step(tx, q, config_name) is {
    Some((Config(c0), Config(c1))) ->
      if list.length(q_ins(tx, q)) == 1 && is_empty_mint(tx, q) {
        Some((c0, c1))
      } else {
        None
      }
    _ -> None
  }
}

/// The only place a QueueConfig is rebuilt: every Config transition changes
/// some of these six fields, bumps `epoch` and leaves the rest alone.
fn next(
  c0: QueueConfig,
  daily: Int,
  monthly: Int,
  suspended_until: Int,
  pending_limits: Option<PendingLimits>,
  pending_defund: Option<PendingDefund>,
) -> QueueConfig {
  QueueConfig {
    ..c0,
    daily_limit: daily,
    monthly_limit: monthly,
    suspended_until,
    pending_limits,
    pending_defund,
    epoch: c0.epoch + 1,
  }
}

fn floor_of(tx: Transaction, reserve: PolicyId) -> Int {
  expect Some(sup) = genuine_supply(tx, reserve)
  limit_floor(sup.minted_supply)
}

/// A genesis queue UTxO: enterprise address, no reference script, lovelace and
/// the one thread token.
fn thread_out_ok(o: Output, q: PolicyId) -> Bool {
  o.address == script_address(q) && o.reference_script == None && list.length(
    flatten(o.value),
  ) == 2
}

// ------------------------------------------------------------------ Genesis

fn genesis(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((cfg_out, Config(c))) = thread_among(tx.outputs, q, config_name)
  expect Some((short_out, Short(sh))) = thread_among(tx.outputs, q, short_name)
  let shards =
    list.filter(q_outs(tx, q), fn(o) { shard_index(o, q) != None })
  let idxs = list.filter_map(shards, fn(o) { shard_index(o, q) })
  and {
    q_ins(tx, q) == [],
    config_valid(c, floor_of(tx, reserve)),
    thread_out_ok(cfg_out, q),
    thread_out_ok(short_out, q),
    sh == ShortState {
      active: False,
      episode: 0,
      since: 0,
      reg_deadline: 0,
      last_exit: 0,
      tallies: [],
    },
    list.length(shards) == c.shards,
    list.length(q_outs(tx, q)) == c.shards + 2,
    list.length(list.unique(idxs)) == c.shards,
    list.all(idxs, fn(i) { i < c.shards }),
    list.all(
      shards,
      fn(o) {
        thread_out_ok(o, q) && datum_of(o) == Shard(
          ShardState { day: 0, paid_day: 0, month: 0, paid_month: 0 },
        )
      },
    ),
    // exactly the config, short and shard threads, one each
    dict.size(assets.tokens(tx.mint, q)) == c.shards + 2,
    list.all(dict.values(assets.tokens(tx.mint, q)), fn(n) { n == 1 }),
  }
}

// ------------------------------------------------------- Config transitions

fn suspend(tx: Transaction, q: PolicyId, lo: Int, hi: Int, until: Int) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  and {
    can_suspend(lo, hi, until, c0.suspended_until),
    c1 == next(
      c0,
      c0.daily_limit,
      c0.monthly_limit,
      until,
      c0.pending_limits,
      c0.pending_defund,
    ),
  }
}

fn resume(tx: Transaction, q: PolicyId, lo: Int) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  and {
    suspended(c0.suspended_until, lo),
    c1 == next(
      c0,
      c0.daily_limit,
      c0.monthly_limit,
      lo,
      c0.pending_limits,
      c0.pending_defund,
    ),
  }
}

/// An increase of both limits applies at once; anything else is announced and
/// applies `notice_ms` later through `ApplyLimits`.
fn announce_limits(
  tx: Transaction,
  q: PolicyId,
  reserve: PolicyId,
  lo: Int,
  hi: Int,
  daily: Int,
  monthly: Int,
) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  and {
    hi >= lo,
    hi - lo <= 86_400_000,
    limits_ok(daily, monthly, floor_of(tx, reserve)),
    if daily >= c0.daily_limit && monthly >= c0.monthly_limit {
      c1 == next(c0, daily, monthly, c0.suspended_until, None, c0.pending_defund)
    } else {
      c1 == next(
        c0,
        c0.daily_limit,
        c0.monthly_limit,
        c0.suspended_until,
        Some(PendingLimits { daily, monthly, effective_at: lo + notice_ms }),
        c0.pending_defund,
      )
    },
  }
}

fn apply_limits(tx: Transaction, q: PolicyId, reserve: PolicyId, lo: Int) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  expect Some(p) = c0.pending_limits
  and {
    lo >= p.effective_at,
    // the floor again, at the moment the decrease takes effect
    limits_ok(p.daily, p.monthly, floor_of(tx, reserve)),
    c1 == next(c0, p.daily, p.monthly, c0.suspended_until, None, c0.pending_defund),
  }
}

/// Anyone may lift a limit the supply has outgrown to the current floor.
fn sync_floor(tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  let floor = floor_of(tx, reserve)
  and {
    c0.daily_limit < floor,
    c1 == next(
      c0,
      floor,
      if c0.monthly_limit > floor {
        c0.monthly_limit
      } else {
        floor
      },
      c0.suspended_until,
      c0.pending_limits,
      c0.pending_defund,
    ),
  }
}

fn announce_defund(
  tx: Transaction,
  q: PolicyId,
  lo: Int,
  hi: Int,
  shard: Int,
  amount: Int,
) -> Bool {
  expect Some((c0, c1)) = config_step(tx, q)
  and {
    hi >= lo,
    hi - lo <= 86_400_000,
    amount > 0,
    shard >= 0,
    shard < c0.shards,
    when c0.pending_defund is {
      None -> True
      Some(p) -> lo > p.effective_at + defund_lapse_ms
    },
    c1 == next(
      c0,
      c0.daily_limit,
      c0.monthly_limit,
      c0.suspended_until,
      c0.pending_limits,
      Some(PendingDefund { shard, amount, effective_at: lo + notice_ms }),
    ),
  }
}

// ----------------------------------------------------------- Fund and Defund

fn fund(tx: Transaction, q: PolicyId) -> Bool {
  expect Some(cfg) = config_ref(tx, q)
  expect [shard_in] = q_ins(tx, q)
  expect [shard_out] = q_outs(tx, q)
  let a =
    quantity_of(shard_out.value, cfg.payout_policy, cfg.payout_name) - quantity_of(
      shard_in.value,
      cfg.payout_policy,
      cfg.payout_name,
    )
  let l = lovelace_of(shard_out.value) - lovelace_of(shard_in.value)
  and {
    shard_index(shard_in, q) != None,
    is_empty_mint(tx, q),
    a > 0,
    l >= 0,
    continuing_ok(shard_out, shard_in),
    datum_of(shard_out) == datum_of(shard_in),
    shard_out.value == merge(
      shard_in.value,
      merge(from_asset(cfg.payout_policy, cfg.payout_name, a), from_lovelace(l)),
    ),
  }
}

fn defund(tx: Transaction, q: PolicyId, lo: Int) -> Bool {
  expect Some((Config(c0), Config(c1))) = step(tx, q, config_name)
  expect Some(p) = c0.pending_defund
  expect Some(shard_in) =
    list.find(q_ins(tx, q), fn(o) { shard_index(o, q) != None })
  expect Some(shard_out) =
    list.find(q_outs(tx, q), fn(o) { shard_index(o, q) != None })
  and {
    list.length(q_ins(tx, q)) == 2,
    list.length(q_outs(tx, q)) == 2,
    is_empty_mint(tx, q),
    shard_index(shard_in, q) == Some(p.shard),
    lo >= p.effective_at,
    lo <= p.effective_at + defund_lapse_ms,
    short_inactive(tx, q),
    c1 == next(
      c0,
      c0.daily_limit,
      c0.monthly_limit,
      c0.suspended_until,
      c0.pending_limits,
      None,
    ),
    continuing_ok(shard_out, shard_in),
    datum_of(shard_out) == datum_of(shard_in),
    shard_out.value == merge(
      shard_in.value,
      from_asset(c0.payout_policy, c0.payout_name, -p.amount),
    ),
  }
}

// --------------------------------------------------------------- GrantGrace

fn grant_grace(
  tx: Transaction,
  q: PolicyId,
  lo: Int,
  hi: Int,
  holder: ByteArray,
  until: Int,
) -> Bool {
  expect Some(cfg) = config_ref(tx, q)
  expect [g] = q_outs(tx, q)
  and {
    q_ins(tx, q) == [],
    bytearray.length(holder) == 28,
    hi >= lo,
    hi - lo <= 86_400_000,
    cfg.grace_ms > 0,
    until >= hi,
    until <= lo + cfg.grace_ms,
    dict.to_pairs(assets.tokens(tx.mint, q)) == [Pair(holder, 1)],
    thread_out_ok(g, q),
    quantity_of(g.value, q, holder) == 1,
    datum_of(g) == Grace(GraceState { until }),
  }
}

// ----------------------------------------------------------------- validator

fn admin_action(a: AdminAction, tx: Transaction, q: PolicyId, reserve: PolicyId) -> Bool {
  expect Some((lo, hi)) = finite_bounds(tx)
  expect Some(rc) = genuine_config(tx, reserve)
  let signed = committee(tx, rc)
  when a is {
    SyncFloor -> sync_floor(tx, q, reserve)
    Genesis -> signed && genesis(tx, q, reserve)
    Suspend { until } -> signed && suspend(tx, q, lo, hi, until)
    Resume -> signed && resume(tx, q, lo)
    AnnounceLimits { daily, monthly } ->
      signed && announce_limits(tx, q, reserve, lo, hi, daily, monthly)
    ApplyLimits -> signed && apply_limits(tx, q, reserve, lo)
    Fund -> signed && fund(tx, q)
    AnnounceDefund { shard, amount } ->
      signed && announce_defund(tx, q, lo, hi, shard, amount)
    Defund -> signed && defund(tx, q, lo)
    GrantGrace { holder, until } ->
      signed && grant_grace(tx, q, lo, hi, holder, until)
  }
}

validator queue_admin(reserve: PolicyId) {
  withdraw(redeemer: AdminRedeemer, account: Credential, tx: Transaction) {
    and {
      pairs.get_first(tx.withdrawals, account) == Some(0),
      admin_action(redeemer.action, tx, redeemer.queue, reserve),
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


fn run(a: AdminAction, tx: Transaction) -> Bool {
  queue_admin.withdraw(
    t_reserve,
    AdminRedeemer { queue: q, action: a },
    Script(t_admin),
    tx |> gate(t_admin),
  )
}

fn base_refs() -> List<Input> {
  [inp(90, reserve_config_out(rcfg0())), inp(91, reserve_supply_out(supply0()))]
}

fn refs_minted(m: Int) -> List<Input> {
  [
    inp(90, reserve_config_out(rcfg0())),
    inp(91, reserve_supply_out(SupplyState { ..supply0(), minted_supply: m })),
  ]
}

fn cfg_tx(c0: QueueConfig, c1: QueueConfig) -> Transaction {
  tx0()
    |> signed([op1, op2])
    |> refs(base_refs())
    |> ins([inp(1, config_out(c0))])
    |> outs([config_out(c1)])
}

fn bump(c: QueueConfig) -> QueueConfig {
  QueueConfig { ..c, epoch: c.epoch + 1 }
}

// -- Genesis

fn shard_tokens(n: Int) -> Value {
  list.foldl(
    list.range(0, n - 1),
    assets.zero,
    fn(i, acc) { assets.merge(acc, qtok(shard_name(i), 1)) },
  )
}

fn genesis_shard(i: Int) -> Output {
  qout(qtok(shard_name(i), 1), Shard(shard0()))
}

fn genesis_tx(c: QueueConfig) -> Transaction {
  let shards = list.map(list.range(0, c.shards - 1), genesis_shard)
  tx0()
    |> signed([op1, op2])
    |> refs(base_refs())
    |> outs(
        list.concat(
          [
            qout(qtok(config_name, 1), Config(c)),
            qout(qtok(short_name, 1), Short(short0())),
          ],
          shards,
        ),
      )
    |> minting(
        assets.merge(qtok(config_name, 1), qtok(short_name, 1))
          |> assets.merge(shard_tokens(c.shards)),
      )
}

test genesis_creates_the_config_the_short_state_and_the_shards() {
  run(Genesis, genesis_tx(cfg0()))
}

test genesis_works_for_one_shard_and_for_eight() {
  run(Genesis, genesis_tx(QueueConfig { ..cfg0(), shards: 1 })) && run(
    Genesis,
    genesis_tx(QueueConfig { ..cfg0(), shards: 8 }),
  )
}

test genesis_needs_the_committee() {
  !run(Genesis, genesis_tx(cfg0()) |> signed([op1])) && !run(
    Genesis,
    genesis_tx(cfg0()) |> signed([alice, bob]),
  )
}

test genesis_refuses_a_parameter_beyond_its_hard_bound() {
  let bad = [
    QueueConfig { ..cfg0(), settle_delay: 604_800_001 },
    QueueConfig { ..cfg0(), settle_delay: -1 },
    QueueConfig { ..cfg0(), settle_tip: 1_000_001 },
    QueueConfig { ..cfg0(), settle_tip: -1 },
    QueueConfig { ..cfg0(), shards: 0 },
    QueueConfig { ..cfg0(), shards: 9 },
    QueueConfig { ..cfg0(), grace_ms: 2_592_000_001 },
    QueueConfig { ..cfg0(), grace_ms: -1 },
    QueueConfig { ..cfg0(), min_request: 0 },
    QueueConfig { ..cfg0(), instant_max: 0 },
    QueueConfig { ..cfg0(), payout_policy: #"99" },
    QueueConfig { ..cfg0(), suspended_until: 1 },
    QueueConfig { ..cfg0(), epoch: 1 },
    QueueConfig { ..cfg0(), pending_limits: Some(PendingLimits { daily: 1, monthly: 1, effective_at: 1 }) },
    QueueConfig { ..cfg0(), pending_defund: Some(PendingDefund { shard: 0, amount: 1, effective_at: 1 }) },
  ]
  list.all(
    bad,
    fn(c) {
      // shards 0 / 17 cannot even be built as genesis outputs; judge the rule
      !config_valid(c, 10_000_000_000)
    },
  )
}

test genesis_refuses_limits_below_the_floor_or_a_monthly_below_the_daily() {
  !run(Genesis, genesis_tx(QueueConfig { ..cfg0(), daily_limit: 9_999_999_999 })) && !run(
    Genesis,
    genesis_tx(QueueConfig { ..cfg0(), daily_limit: 0, monthly_limit: 0 }),
  ) && !run(
    Genesis,
    genesis_tx(QueueConfig { ..cfg0(), monthly_limit: 39_999_999_999 }),
  ) && run(Genesis, genesis_tx(QueueConfig { ..cfg0(), daily_limit: 10_000_000_000, monthly_limit: 10_000_000_000 }))
}

test genesis_floor_follows_the_supply() {
  // 2,000,000 TSRA minted: 1% = 20,000 TSRA
  let c = QueueConfig { ..cfg0(), daily_limit: 15_000_000_000, monthly_limit: 150_000_000_000 }
  run(Genesis, genesis_tx(c)) && !run(Genesis, genesis_tx(c) |> refs(refs_minted(2_000_000_000_000)))
}

test genesis_refuses_a_non_initial_short_state() {
  let bad = ShortState { ..short0(), episode: 1 }
  !run(
    Genesis,
    genesis_tx(cfg0())
      |> map_out(1, fn(_) { qout(qtok(short_name, 1), Short(bad)) }),
  )
}

test genesis_refuses_a_shard_with_counters_or_a_balance() {
  let used = ShardState { day: 1, paid_day: 0, month: 0, paid_month: 0 }
  !run(Genesis, genesis_tx(cfg0()) |> map_out(2, fn(_) { qout(qtok(shard_name(0), 1), Shard(used)) })) && !run(
    Genesis,
    genesis_tx(cfg0()) |> map_out(2, fn(o) { with_value(o, usd(1)) }),
  )
}

test genesis_refuses_a_missing_or_duplicated_shard() {
  !run(Genesis, genesis_tx(cfg0()) |> drop_out(5)) && !run(
    Genesis,
    genesis_tx(cfg0()) |> map_out(5, fn(_) { genesis_shard(2) }),
  )
}

test genesis_refuses_an_extra_queue_output_or_a_stray_mint() {
  !run(Genesis, genesis_tx(cfg0()) |> add_out(sink_out(1))) && !run(
    Genesis,
    genesis_tx(cfg0()) |> minting(assets.merge(shard_tokens(4), qtok(config_name, 1)) |> assets.merge(qtok(short_name, 1)) |> assets.merge(qtok(request_name, 1))),
  ) && !run(
    Genesis,
    genesis_tx(cfg0()) |> minting(assets.merge(shard_tokens(4), qtok(config_name, 2)) |> assets.merge(qtok(short_name, 1))),
  )
}

test genesis_may_not_spend_a_queue_utxo() {
  !run(Genesis, genesis_tx(cfg0()) |> add_in(inp(5, sink_out(1))))
}

test genesis_outputs_are_pinned() {
  !run(Genesis, genesis_tx(cfg0()) |> map_out(0, staked)) && !run(
    Genesis,
    genesis_tx(cfg0()) |> map_out(1, with_ref_script),
  ) && !run(Genesis, genesis_tx(cfg0()) |> map_out(2, staked)) && !run(
    Genesis,
    genesis_tx(cfg0()) |> map_out(0, fn(o) { with_value(o, usd(1)) }),
  )
}

// -- Suspend and Resume

fn suspend_tx(until: Int) -> Transaction {
  cfg_tx(cfg0(), QueueConfig { ..bump(cfg0()), suspended_until: until })
    |> at(now, now + 600_000)
}

test a_three_day_suspension_is_accepted() {
  run(Suspend { until: now + 3 * day }, suspend_tx(now + 3 * day))
}

test a_suspension_longer_than_three_days_is_refused() {
  !run(Suspend { until: now + 3 * day + 1 }, suspend_tx(now + 3 * day + 1))
}

test a_suspension_must_outlast_the_transaction() {
  !run(Suspend { until: now + 600_000 }, suspend_tx(now + 600_000)) && run(
    Suspend { until: now + 600_001 },
    suspend_tx(now + 600_001),
  )
}

test a_suspension_window_of_more_than_a_day_is_refused() {
  !run(Suspend { until: now + 2 * day }, suspend_tx(now + 2 * day) |> at(now, now + day + 1))
}

test a_suspension_may_reopen_only_a_week_after_the_last_one_ended() {
  let prev_end = now - 7 * day
  let mk = fn(end: Int) {
    cfg_tx(
      QueueConfig { ..cfg0(), suspended_until: end },
      QueueConfig { ..cfg0(), suspended_until: now + day, epoch: 1 },
    )
  }
  run(Suspend { until: now + day }, mk(prev_end)) && !run(Suspend { until: now + day }, mk(prev_end + 1))
}

test a_suspension_needs_the_committee() {
  !run(Suspend { until: now + day }, suspend_tx(now + day) |> signed([op1])) && !run(
    Suspend { until: now + day },
    suspend_tx(now + day) |> signed([bob, alice]),
  )
}

test a_suspension_must_record_the_requested_until_and_bump_the_epoch() {
  !run(Suspend { until: now + day }, suspend_tx(now + 2 * day)) && !run(
    Suspend { until: now + day },
    cfg_tx(cfg0(), QueueConfig { ..cfg0(), suspended_until: now + day }) |> at(now, now + 600_000),
  )
}

test a_suspension_may_change_nothing_else() {
  let tx = suspend_tx(now + day)
  !run(Suspend { until: now + day }, tx |> map_out(0, fn(_) { config_out(QueueConfig { ..bump(cfg0()), suspended_until: now + day, daily_limit: 1 }) }))
}

fn resume_tx(c0: QueueConfig, c1: QueueConfig) -> Transaction {
  cfg_tx(c0, c1)
}

test resuming_ends_the_suspension_now() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now + day }
  run(Resume, resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now }))
}

test resume_is_refused_when_nothing_is_suspended() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now }
  !run(Resume, resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now })) && !run(
    Resume,
    resume_tx(cfg0(), QueueConfig { ..bump(cfg0()), suspended_until: now }),
  )
}

test resume_must_record_the_current_time() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now + day }
  !run(Resume, resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now + 1 })) && !run(
    Resume,
    resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: 0 }),
  )
}

test resume_needs_the_committee() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now + day }
  !run(Resume, resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now }) |> signed([op3]))
}

test a_config_transition_keeps_the_config_utxo_pinned() fail {
  run(Suspend { until: now + day }, suspend_tx(now + day) |> map_out(0, staked))
}

test a_config_transition_may_not_carry_another_queue_input() fail {
  run(Suspend { until: now + day }, suspend_tx(now + day) |> add_in(inp(5, sink_out(1))))
}

test a_config_transition_may_not_mint() fail {
  run(Suspend { until: now + day }, suspend_tx(now + day) |> minting(qtok(request_name, 1)))
}

test a_config_transition_needs_the_genuine_config() fail {
  let planted = qout(assets.zero, Config(cfg0()))
  run(Suspend { until: now + day }, suspend_tx(now + day) |> map_in(0, fn(_) { planted }))
}

// -- Limits

fn limits_tx(c0: QueueConfig, c1: QueueConfig) -> Transaction {
  cfg_tx(c0, c1) |> at(now, now + 600_000)
}

fn announced(daily: Int, monthly: Int) -> PendingLimits {
  PendingLimits { daily, monthly, effective_at: now + 7 * day }
}

test an_increase_of_both_limits_applies_at_once() {
  run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 500_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 50_000_000_000, monthly_limit: 500_000_000_000 }),
  )
}

test an_increase_clears_a_pending_decrease() {
  let c0 = QueueConfig { ..cfg0(), pending_limits: Some(announced(20_000_000_000, 200_000_000_000)) }
  run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 500_000_000_000 },
    limits_tx(c0, QueueConfig { ..bump(c0), daily_limit: 50_000_000_000, monthly_limit: 500_000_000_000, pending_limits: None }),
  )
}

test a_decrease_is_announced_not_applied() {
  run(
    AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(20_000_000_000, 200_000_000_000)) }),
  )
}

test a_decrease_cannot_be_applied_straight_away() {
  !run(
    AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 20_000_000_000, monthly_limit: 200_000_000_000 }),
  )
}

test the_notice_is_exactly_seven_days() {
  let l = fn(at_: Int) {
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(PendingLimits { daily: 20_000_000_000, monthly: 200_000_000_000, effective_at: at_ }) })
  }
  run(AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 }, l(now + 7 * day)) && !run(
    AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 },
    l(now + 7 * day - 1),
  )
}

test a_mixed_change_counts_as_a_decrease() {
  run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 300_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(50_000_000_000, 300_000_000_000)) }),
  )
}

test the_floor_is_enforced_at_announcement() {
  // floor = max(10,000, 1% of 500,000) = 10,000 TSRA
  run(
    AnnounceLimits { daily: 10_000_000_000, monthly: 10_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(10_000_000_000, 10_000_000_000)) }),
  ) && !run(
    AnnounceLimits { daily: 9_999_999_999, monthly: 100_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(9_999_999_999, 100_000_000_000)) }),
  )
}

test zero_limits_are_refused() {
  !run(
    AnnounceLimits { daily: 0, monthly: 0 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(0, 0)) }),
  )
}

test a_monthly_limit_below_the_daily_is_refused() {
  !run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 49_999_999_999 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), pending_limits: Some(announced(50_000_000_000, 49_999_999_999)) }),
  )
}

test the_floor_follows_one_percent_of_the_supply() {
  // 2,000,000 TSRA minted: the floor is 20,000 TSRA
  let c0 = QueueConfig { ..cfg0(), daily_limit: 30_000_000_000 }
  let ann = fn(d: Int) {
    limits_tx(c0, QueueConfig { ..bump(c0), pending_limits: Some(announced(d, 200_000_000_000)) })
      |> refs(refs_minted(2_000_000_000_000))
  }
  run(AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 }, ann(20_000_000_000)) && !run(
    AnnounceLimits { daily: 19_999_999_999, monthly: 200_000_000_000 },
    ann(19_999_999_999),
  )
}

test announcing_limits_needs_the_committee() {
  !run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 500_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 50_000_000_000, monthly_limit: 500_000_000_000 }) |> signed([op1]),
  )
}

test announcing_limits_with_a_window_over_a_day_is_refused() {
  !run(
    AnnounceLimits { daily: 50_000_000_000, monthly: 500_000_000_000 },
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 50_000_000_000, monthly_limit: 500_000_000_000 }) |> at(now, now + day + 1),
  )
}

fn apply_tx(c0: QueueConfig, c1: QueueConfig, lo: Int) -> Transaction {
  limits_tx(c0, c1) |> at(lo, lo + 600_000)
}

fn pending_cfg() -> QueueConfig {
  QueueConfig { ..cfg0(), pending_limits: Some(PendingLimits { daily: 20_000_000_000, monthly: 200_000_000_000, effective_at: now }) }
}

fn applied(c: QueueConfig) -> QueueConfig {
  QueueConfig { ..bump(c), daily_limit: 20_000_000_000, monthly_limit: 200_000_000_000, pending_limits: None }
}

test a_pending_decrease_applies_after_the_notice() {
  run(ApplyLimits, apply_tx(pending_cfg(), applied(pending_cfg()), now))
}

test a_pending_decrease_does_not_apply_one_millisecond_early() {
  !run(ApplyLimits, apply_tx(pending_cfg(), applied(pending_cfg()), now - 1))
}

test applying_must_set_exactly_the_announced_limits() {
  !run(ApplyLimits, apply_tx(pending_cfg(), QueueConfig { ..applied(pending_cfg()), daily_limit: 19_999_999_999 }, now)) && !run(
    ApplyLimits,
    apply_tx(pending_cfg(), QueueConfig { ..applied(pending_cfg()), pending_limits: pending_cfg().pending_limits }, now),
  )
}

test the_floor_is_checked_again_when_a_decrease_takes_effect() {
  // legal when announced; by the time it applies the supply has grown
  // (2,000,000 TSRA: floor 20,000 TSRA; the announced 20,000 still passes, 19,999 does not)
  let low = QueueConfig { ..cfg0(), pending_limits: Some(PendingLimits { daily: 19_999_999_999, monthly: 200_000_000_000, effective_at: now }) }
  let low_applied = QueueConfig { ..bump(low), daily_limit: 19_999_999_999, monthly_limit: 200_000_000_000, pending_limits: None }
  run(ApplyLimits, apply_tx(low, low_applied, now)) && !run(
    ApplyLimits,
    apply_tx(low, low_applied, now) |> refs(refs_minted(2_000_000_000_000)),
  ) && run(ApplyLimits, apply_tx(pending_cfg(), applied(pending_cfg()), now) |> refs(refs_minted(2_000_000_000_000)))
}

test applying_needs_a_pending_decrease() fail {
  run(ApplyLimits, apply_tx(cfg0(), bump(cfg0()), now))
}

test applying_needs_the_committee() {
  !run(ApplyLimits, apply_tx(pending_cfg(), applied(pending_cfg()), now) |> signed([bob]))
}

// SyncFloor

fn sync_tx(c0: QueueConfig, c1: QueueConfig, minted: Int) -> Transaction {
  cfg_tx(c0, c1) |> signed([]) |> refs(refs_minted(minted))
}

test anyone_can_lift_a_limit_the_supply_has_outgrown() {
  // 2,000,000 TSRA minted: floor 20,000; the daily 15,000 is below it
  let c0 = QueueConfig { ..cfg0(), daily_limit: 15_000_000_000, monthly_limit: 150_000_000_000 }
  run(SyncFloor, sync_tx(c0, QueueConfig { ..bump(c0), daily_limit: 20_000_000_000, monthly_limit: 150_000_000_000 }, 2_000_000_000_000))
}

test sync_floor_also_lifts_a_monthly_limit_that_would_fall_below_the_daily() {
  let c0 = QueueConfig { ..cfg0(), daily_limit: 15_000_000_000, monthly_limit: 15_000_000_000 }
  run(SyncFloor, sync_tx(c0, QueueConfig { ..bump(c0), daily_limit: 20_000_000_000, monthly_limit: 20_000_000_000 }, 2_000_000_000_000))
}

test sync_floor_never_lowers_a_limit() {
  // the daily limit is already at the floor: nothing to sync
  let c0 = QueueConfig { ..cfg0(), daily_limit: 20_000_000_000, monthly_limit: 150_000_000_000 }
  !run(SyncFloor, sync_tx(c0, bump(c0), 2_000_000_000_000)) && !run(
    SyncFloor,
    sync_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 10_000_000_000 }, 2_000_000_000_000),
  )
}

test sync_floor_must_land_exactly_on_the_floor() {
  let c0 = QueueConfig { ..cfg0(), daily_limit: 15_000_000_000, monthly_limit: 150_000_000_000 }
  !run(SyncFloor, sync_tx(c0, QueueConfig { ..bump(c0), daily_limit: 20_000_000_001, monthly_limit: 150_000_000_000 }, 2_000_000_000_000)) && !run(
    SyncFloor,
    sync_tx(c0, QueueConfig { ..bump(c0), daily_limit: 19_999_999_999, monthly_limit: 150_000_000_000 }, 2_000_000_000_000),
  )
}

test sync_floor_needs_the_genuine_supply() fail {
  let c0 = QueueConfig { ..cfg0(), daily_limit: 15_000_000_000, monthly_limit: 150_000_000_000 }
  let fake = Output { ..reserve_supply_out(SupplyState { ..supply0(), minted_supply: 2_000_000_000_000 }), value: ada(2_000_000) }
  run(
    SyncFloor,
    sync_tx(c0, QueueConfig { ..bump(c0), daily_limit: 20_000_000_000, monthly_limit: 150_000_000_000 }, 2_000_000_000_000)
      |> refs([inp(90, reserve_config_out(rcfg0())), inp(91, fake)]),
  )
}

// -- Fund

fn fund_tx(add: Int) -> Transaction {
  tx0()
    |> signed([op1, op2])
    |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, config_out(cfg0()))])
    |> ins([inp(1, shard_out(0, shard0(), 1_000_000_000)), inp(2, wallet(keeper, usd(add)))])
    |> outs([shard_out(0, shard0(), 1_000_000_000 + add)])
}

test the_committee_can_fund_a_shard() {
  run(Fund, fund_tx(5_000_000_000))
}

test funding_may_add_lovelace_too() {
  run(Fund, fund_tx(5_000_000_000) |> map_out(0, fn(o) { lovelace_plus(o, 1_000_000) }))
}

test funding_needs_the_committee() {
  !run(Fund, fund_tx(5_000_000_000) |> signed([op1])) && !run(Fund, fund_tx(5_000_000_000) |> signed([]))
}

test funding_must_raise_the_payout_balance() {
  !run(Fund, fund_tx(0)) && !run(Fund, fund_tx(5_000_000_000) |> map_out(0, fn(_) { shard_out(0, shard0(), 500_000_000) }))
}

test funding_may_not_lower_lovelace() {
  !run(Fund, fund_tx(5_000_000_000) |> map_out(0, fn(o) { lovelace_plus(o, -1) }))
}

test funding_may_not_add_other_assets() {
  !run(Fund, fund_tx(5_000_000_000) |> map_out(0, fn(o) { with_value(o, assets.from_asset(t_reserve, "x", 1)) }))
}

test funding_may_not_change_the_shard_datum() {
  let used = ShardState { day: 5, paid_day: 1, month: 0, paid_month: 1 }
  !run(Fund, fund_tx(5_000_000_000) |> map_out(0, fn(o) { with_datum(o, Shard(used)) }))
}

test funding_keeps_the_shard_pinned() {
  !run(Fund, fund_tx(5_000_000_000) |> map_out(0, staked)) && !run(
    Fund,
    fund_tx(5_000_000_000) |> map_out(0, with_ref_script),
  )
}

test funding_a_shard_that_is_not_genuine_fails() fail {
  run(Fund, fund_tx(5_000_000_000) |> map_in(0, fn(_) { qout(usd(1_000_000_000), Shard(shard0())) }))
}

test funding_may_not_mint() {
  !run(Fund, fund_tx(5_000_000_000) |> minting(qtok(request_name, 1)))
}

test funding_may_not_spend_another_queue_utxo() fail {
  run(Fund, fund_tx(5_000_000_000) |> add_in(inp(5, sink_out(1))))
}

// -- AnnounceDefund and Defund

fn defund_announce_tx(c0: QueueConfig, pd: PendingDefund, lo: Int) -> Transaction {
  cfg_tx(c0, QueueConfig { ..bump(c0), pending_defund: Some(pd) }) |> at(lo, lo + 600_000)
}

test a_defund_is_announced_for_seven_days_ahead() {
  run(
    AnnounceDefund { shard: 1, amount: 3_000_000_000 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 1, amount: 3_000_000_000, effective_at: now + 7 * day }, now),
  )
}

test the_defund_notice_is_exactly_seven_days() {
  !run(
    AnnounceDefund { shard: 1, amount: 3_000_000_000 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 1, amount: 3_000_000_000, effective_at: now + 7 * day - 1 }, now),
  )
}

test an_announcement_needs_a_real_shard_and_a_positive_amount() {
  !run(
    AnnounceDefund { shard: 4, amount: 1 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 4, amount: 1, effective_at: now + 7 * day }, now),
  ) && !run(
    AnnounceDefund { shard: -1, amount: 1 },
    defund_announce_tx(cfg0(), PendingDefund { shard: -1, amount: 1, effective_at: now + 7 * day }, now),
  ) && !run(
    AnnounceDefund { shard: 0, amount: 0 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 0, amount: 0, effective_at: now + 7 * day }, now),
  )
}

test only_one_defund_can_be_pending() {
  let c0 = QueueConfig { ..cfg0(), pending_defund: Some(PendingDefund { shard: 0, amount: 1, effective_at: now + 7 * day }) }
  !run(
    AnnounceDefund { shard: 1, amount: 2 },
    defund_announce_tx(c0, PendingDefund { shard: 1, amount: 2, effective_at: now + 7 * day }, now),
  )
}

test a_lapsed_defund_can_be_announced_again() {
  let old = PendingDefund { shard: 0, amount: 1, effective_at: now - 7 * day - 1 }
  let c0 = QueueConfig { ..cfg0(), pending_defund: Some(old) }
  run(
    AnnounceDefund { shard: 1, amount: 2 },
    defund_announce_tx(c0, PendingDefund { shard: 1, amount: 2, effective_at: now + 7 * day }, now),
  ) && !run(
    AnnounceDefund { shard: 1, amount: 2 },
    defund_announce_tx(
      QueueConfig { ..cfg0(), pending_defund: Some(PendingDefund { shard: 0, amount: 1, effective_at: now - 7 * day }) },
      PendingDefund { shard: 1, amount: 2, effective_at: now + 7 * day },
      now,
    ),
  )
}

test announcing_a_defund_needs_the_committee() {
  !run(
    AnnounceDefund { shard: 1, amount: 3_000_000_000 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 1, amount: 3_000_000_000, effective_at: now + 7 * day }, now) |> signed([op2]),
  )
}

fn pd_now() -> PendingDefund {
  PendingDefund { shard: 0, amount: 3_000_000_000, effective_at: now }
}

fn defund_tx(lo: Int) -> Transaction {
  let c0 = QueueConfig { ..cfg0(), pending_defund: Some(pd_now()) }
  tx0()
    |> at(lo, lo + 600_000)
    |> signed([op1, op2])
    |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, short_out(short0()))])
    |> ins([inp(1, config_out(c0)), inp(2, shard_out(0, shard0(), 5_000_000_000))])
    |> outs([
        config_out(QueueConfig { ..bump(c0), pending_defund: None }),
        shard_out(0, shard0(), 2_000_000_000),
        wallet(keeper, usd(3_000_000_000)),
      ])
}

test a_defund_executes_after_the_notice() {
  run(Defund, defund_tx(now))
}

test a_defund_is_refused_one_millisecond_early() {
  !run(Defund, defund_tx(now - 1))
}

test a_defund_lapses_a_week_after_it_became_effective() {
  run(Defund, defund_tx(now + 7 * day)) && !run(Defund, defund_tx(now + 7 * day + 1))
}

test a_defund_must_take_exactly_the_announced_amount() {
  !run(Defund, defund_tx(now) |> map_out(1, fn(_) { shard_out(0, shard0(), 2_000_000_001) })) && !run(
    Defund,
    defund_tx(now) |> map_out(1, fn(_) { shard_out(0, shard0(), 1_999_999_999) }),
  )
}

test a_defund_must_hit_the_announced_shard() {
  !run(
    Defund,
    defund_tx(now)
      |> map_in(1, fn(_) { shard_out(1, shard0(), 5_000_000_000) })
      |> map_out(1, fn(_) { shard_out(1, shard0(), 2_000_000_000) }),
  )
}

test a_defund_is_refused_in_short_mode() {
  let on = ShortState { ..short0(), active: True, episode: 1 }
  !run(Defund, defund_tx(now) |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, short_out(on))]))
}

test a_defund_needs_the_genuine_short_state() fail {
  let planted = qout(assets.zero, Short(short0()))
  run(Defund, defund_tx(now) |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, planted)]))
}

test a_defund_must_clear_the_notice() {
  let c0 = QueueConfig { ..cfg0(), pending_defund: Some(pd_now()) }
  !run(Defund, defund_tx(now) |> map_out(0, fn(_) { config_out(bump(c0)) }))
}

test a_defund_needs_the_committee() {
  !run(Defund, defund_tx(now) |> signed([op1]))
}

test a_defund_needs_an_announcement() fail {
  run(
    Defund,
    defund_tx(now)
      |> map_in(0, fn(_) { config_out(cfg0()) }),
  )
}

test a_defund_keeps_the_shard_pinned_and_datum_unchanged() {
  let used = ShardState { day: 5, paid_day: 1, month: 0, paid_month: 1 }
  !run(Defund, defund_tx(now) |> map_out(1, staked)) && !run(
    Defund,
    defund_tx(now) |> map_out(1, with_ref_script),
  ) && !run(Defund, defund_tx(now) |> map_out(1, fn(o) { with_datum(o, Shard(used)) }))
}

test a_defund_may_not_carry_another_queue_input_or_mint() {
  !run(Defund, defund_tx(now) |> add_in(inp(5, sink_out(1)))) && !run(
    Defund,
    defund_tx(now) |> minting(qtok(request_name, 1)),
  )
}

// -- GrantGrace

fn grace_tx(until: Int) -> Transaction {
  tx0()
    |> signed([op1, op2])
    |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, config_out(cfg0()))])
    |> outs([grace_out(alice, until)])
    |> minting(qtok(alice, 1))
}

test the_committee_can_grant_grace() {
  run(GrantGrace { holder: alice, until: now + 14 * day }, grace_tx(now + 14 * day))
}

test grace_is_capped_by_grace_ms() {
  !run(GrantGrace { holder: alice, until: now + 14 * day + 1 }, grace_tx(now + 14 * day + 1))
}

test grace_must_not_be_over_already() {
  !run(GrantGrace { holder: alice, until: now + 1_799_999 }, grace_tx(now + 1_799_999)) && run(
    GrantGrace { holder: alice, until: now + 1_800_000 },
    grace_tx(now + 1_800_000),
  )
}

test grace_is_disabled_when_grace_ms_is_zero() {
  !run(
    GrantGrace { holder: alice, until: now + day },
    grace_tx(now + day) |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, config_out(QueueConfig { ..cfg0(), grace_ms: 0 }))]),
  )
}

test grace_needs_the_committee() {
  !run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> signed([op3]))
}

test grace_is_a_token_named_by_the_holder_key_hash_only() {
  // a name that is not 28 bytes could collide with a thread token
  let name = "queue"
  !run(
    GrantGrace { holder: name, until: now + day },
    grace_tx(now + day)
      |> outs([qout(qtok(name, 1), Grace(GraceState { until: now + day }))])
      |> minting(qtok(name, 1)),
  )
}

test grace_mints_exactly_one_token_and_nothing_else() {
  !run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> minting(qtok(alice, 2))) && !run(
    GrantGrace { holder: alice, until: now + day },
    grace_tx(now + day) |> minting(assets.merge(qtok(alice, 1), qtok(bob, 1))),
  ) && !run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> minting(assets.zero))
}

test grace_output_must_carry_the_token_and_the_datum() {
  !run(
    GrantGrace { holder: alice, until: now + day },
    grace_tx(now + day) |> outs([grace_out(bob, now + day)]),
  ) && !run(
    GrantGrace { holder: alice, until: now + day },
    grace_tx(now + day) |> outs([grace_out(alice, now + day + 1)]),
  ) && !run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> map_out(0, staked))
}

test grace_may_not_spend_a_queue_utxo() {
  !run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> add_in(inp(5, sink_out(1))))
}

test grace_may_not_add_a_queue_output() fail {
  run(GrantGrace { holder: alice, until: now + day }, grace_tx(now + day) |> add_out(sink_out(1)))
}

// -- gate and publish

test the_admin_withdrawal_must_be_zero() {
  !queue_admin.withdraw(
    t_reserve,
    AdminRedeemer { queue: q, action: Resume },
    Script(t_admin),
    Transaction { ..suspend_tx(now + day), withdrawals: [Pair(Script(t_admin), 1)] },
  ) && !queue_admin.withdraw(
    t_reserve,
    AdminRedeemer { queue: q, action: Resume },
    Script(t_admin),
    suspend_tx(now + day),
  )
}

fn published(m: CertMirror) -> Bool {
  queue_admin.publish(t_reserve, Void, cert(m), placeholder)
}

test registering_the_admin_credential_is_accepted() {
  published(RegisterM { credential: Script(t_admin), deposit: None })
}

test no_other_certificate_is_accepted_for_the_admin_credential() {
  list.all(refused_certs(Script(t_admin)), fn(m) { !published(m) })
}

// -- a transaction judged under a different action is refused

test a_suspension_is_not_a_resume() {
  !run(Resume, suspend_tx(now + day))
}

test a_resume_is_not_a_suspension() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now + day }
  !run(Suspend { until: now }, resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now }))
}

test a_limit_announcement_is_not_a_floor_sync() {
  !run(
    SyncFloor,
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 50_000_000_000, monthly_limit: 500_000_000_000 }),
  )
}

test a_funding_is_not_a_defund() fail {
  run(Defund, fund_tx(5_000_000_000))
}

test a_defund_is_not_a_funding() fail {
  run(Fund, defund_tx(now))
}

test a_grace_grant_is_not_a_genesis() fail {
  run(Genesis, grace_tx(now + day))
}

test a_defund_announcement_is_not_a_limit_announcement() {
  !run(
    AnnounceLimits { daily: 20_000_000_000, monthly: 200_000_000_000 },
    defund_announce_tx(cfg0(), PendingDefund { shard: 1, amount: 3_000_000_000, effective_at: now + 7 * day }, now),
  )
}

// -- tests added after the first mutation pass (each kills a surviving mutant)

test genesis_refuses_a_shard_index_beyond_the_count() {
  let shards =
    [genesis_shard(0), genesis_shard(1), genesis_shard(2), genesis_shard(4)]
  !run(
    Genesis,
    genesis_tx(cfg0())
      |> outs(
          list.concat(
            [
              qout(qtok(config_name, 1), Config(cfg0())),
              qout(qtok(short_name, 1), Short(short0())),
            ],
            shards,
          ),
        )
      |> minting(
          assets.merge(qtok(config_name, 1), qtok(short_name, 1))
            |> assets.merge(qtok(shard_name(0), 1))
            |> assets.merge(qtok(shard_name(1), 1))
            |> assets.merge(qtok(shard_name(2), 1))
            |> assets.merge(qtok(shard_name(4), 1)),
        ),
  )
}

fn inc_both() -> Transaction {
  limits_tx(
    cfg0(),
    QueueConfig {
      ..bump(cfg0()),
      daily_limit: 50_000_000_000,
      monthly_limit: 500_000_000_000,
    },
  )
}

test announcing_limits_needs_a_forward_window_of_at_most_a_day() {
  let a = AnnounceLimits { daily: 50_000_000_000, monthly: 500_000_000_000 }
  !run(a, inc_both() |> at(now + 1_000, now)) && run(a, inc_both() |> at(now, now)) && run(
    a,
    inc_both() |> at(now, now + day),
  ) && !run(a, inc_both() |> at(now, now + day + 1))
}

test an_equal_limit_with_a_higher_other_limit_applies_at_once() {
  let d_equal = AnnounceLimits { daily: 40_000_000_000, monthly: 500_000_000_000 }
  let m_equal = AnnounceLimits { daily: 50_000_000_000, monthly: 400_000_000_000 }
  run(
    d_equal,
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), monthly_limit: 500_000_000_000 }),
  ) && run(
    m_equal,
    limits_tx(cfg0(), QueueConfig { ..bump(cfg0()), daily_limit: 50_000_000_000 }),
  )
}

fn announce_defund_at(lo: Int, hi: Int, shard: Int) -> Bool {
  run(
    AnnounceDefund { shard, amount: 3_000_000_000 },
    defund_announce_tx(
      cfg0(),
      PendingDefund { shard, amount: 3_000_000_000, effective_at: lo + 7 * day },
      lo,
    )
      |> at(lo, hi),
  )
}

test announcing_a_defund_needs_a_forward_window_of_at_most_a_day() {
  !announce_defund_at(now + 1_000, now, 1) && announce_defund_at(now, now, 1) && announce_defund_at(
    now,
    now + day,
    1,
  ) && !announce_defund_at(now, now + day + 1, 1)
}

test a_defund_can_be_announced_for_shard_zero() {
  announce_defund_at(now, now + 600_000, 0)
}

test funding_a_planted_shard_is_refused() {
  let planted = qout(usd(1_000_000_000), Shard(shard0()))
  let planted_out = qout(usd(6_000_000_000), Shard(shard0()))
  !run(
    Fund,
    fund_tx(5_000_000_000)
      |> map_in(0, fn(_) { planted })
      |> map_out(0, fn(_) { planted_out }),
  )
}

test a_defund_may_not_create_another_queue_output() {
  !run(Defund, defund_tx(now) |> add_out(sink_out(1)))
}

fn grace_window(lo: Int, hi: Int) -> Bool {
  run(GrantGrace { holder: alice, until: hi }, grace_tx(hi) |> at(lo, hi))
}

test granting_grace_needs_a_forward_window_of_at_most_a_day() {
  !grace_window(now + 1_000, now) && grace_window(now, now) && grace_window(
    now,
    now + day,
  ) && !grace_window(now, now + day + 1)
}

test grace_stays_off_when_grace_ms_is_zero_even_for_a_zero_length_window() {
  let off = QueueConfig { ..cfg0(), grace_ms: 0 }
  !run(
    GrantGrace { holder: alice, until: now },
    grace_tx(now)
      |> at(now, now)
      |> refs([inp(90, reserve_config_out(rcfg0())), inp(92, config_out(off))]),
  )
}

test the_admin_withdrawal_must_be_exactly_zero_for_a_valid_action() {
  let c0 = QueueConfig { ..cfg0(), suspended_until: now + day }
  let ok = resume_tx(c0, QueueConfig { ..bump(c0), suspended_until: now })
  let w =
    fn(amount: Int) {
      queue_admin.withdraw(
        t_reserve,
        AdminRedeemer { queue: q, action: Resume },
        Script(t_admin),
        Transaction { ..ok, withdrawals: [Pair(Script(t_admin), amount)] },
      )
    }
  w(0) && !w(1) && !queue_admin.withdraw(
    t_reserve,
    AdminRedeemer { queue: q, action: Resume },
    Script(t_admin),
    ok,
  )
}
