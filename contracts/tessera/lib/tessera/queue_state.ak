//// The redemption queue's datums, redeemers, constants and pure rules
//// (Phase 2.6, SPEC.md §4). No transaction access here, so each rule is
//// unit-testable on its own and the four queue scripts share one definition.
////
//// Everything lives at one script address, `redeem_queue`, told apart by the
//// datum constructor and by tokens minted under the same policy. The real
//// work is done once per transaction by three withdraw-zero scripts
//// (`queue_flow`, `queue_admin`, `queue_short`).
////
//// Units: TSRA and the payout asset both have 6 decimals and redeem at par.
//// Times are POSIX milliseconds.

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId}

// ---------------------------------------------------------------- constants

pub const day_ms: Int = 86_400_000

/// Month windows are 30-day blocks (SPEC §4.7), not calendar months.
pub const month_days: Int = 30

/// `settle_delay` is at most 7 days (hard rule, not a vote).
pub const max_settle_delay: Int = 604_800_000

/// A keeper's tip is at most 1 ADA per Request (hard cap).
pub const max_settle_tip: Int = 1_000_000

/// The grace period for a revoked holder is at most 30 days.
pub const max_grace_ms: Int = 2_592_000_000

/// A limit decrease and a Defund are announced this long before they apply.
pub const notice_ms: Int = 604_800_000

/// A pending Defund lapses this long after `effective_at`.
pub const defund_lapse_ms: Int = 604_800_000

/// One suspension lasts at most 3 days; the next may open 7 days after the
/// previous one ended (mirrors the reserve's loss freeze).
pub const max_suspend_ms: Int = 259_200_000

pub const suspend_reopen_gap_ms: Int = 604_800_000

/// A Request's creating transaction lies in one day and spans at most 1 hour.
pub const max_request_window: Int = 3_600_000

/// Short mode (D-32): the Request that proves a shortage is this long overdue,
/// registration is open this long before anything is paid, and a new episode
/// may open this long after the last exit.
pub const short_overdue_ms: Int = 86_400_000

pub const short_window_ms: Int = 86_400_000

pub const short_reentry_ms: Int = 86_400_000

/// Lovelace a Request UTxO carries at least.
pub const min_request_ada: Int = 2_000_000

/// The daily-limit floor's fixed part (D-34): 10,000 TSRA.
pub const min_daily_limit: Int = 10_000_000_000

/// The floor's supply part: `minted_supply / floor_div` (1%).
pub const floor_div: Int = 100


pub const max_shards: Int = 8

// Token names under the queue policy (the queue script hash).
pub const config_name: ByteArray = "queue"

pub const short_name: ByteArray = "short"

pub const request_name: ByteArray = "request"

/// `shard` followed by one byte, the shard's index.
pub fn shard_name(index: Int) -> ByteArray {
  bytearray.concat("shard", bytearray.push("", index))
}

/// Constructor index of `Burn` in the reserve's `ReserveRedeemer` (pinned in CI
/// against the reserve blueprint, SPEC §4.2).
pub const reserve_burn_tag: Int = 1

// ------------------------------------------------------------------- datums

pub type QueueDatum {
  Config(QueueConfig)
  Request(RequestState)
  /// TSRA that has been paid out and awaits burning. No owner, no branch to
  /// give it one (I-Q1, D-35).
  Sink
  Shard(ShardState)
  Short(ShortState)
  Grace(GraceState)
}

pub type QueueConfig {
  payout_policy: PolicyId,
  payout_name: ByteArray,
  settle_delay: Int,
  min_request: Int,
  instant_max: Int,
  settle_tip: Int,
  daily_limit: Int,
  monthly_limit: Int,
  shards: Int,
  grace_ms: Int,
  suspended_until: Int,
  pending_limits: Option<PendingLimits>,
  pending_defund: Option<PendingDefund>,
  epoch: Int,
}

pub type PendingLimits {
  daily: Int,
  monthly: Int,
  effective_at: Int,
}

pub type PendingDefund {
  shard: Int,
  amount: Int,
  effective_at: Int,
}

pub type RequestState {
  owner: ByteArray,
  payout_to: Address,
  qty: Int,
  bucket: Int,
  payable_after: Int,
  /// 0 = not registered; otherwise the short-mode episode it was registered in.
  reg_episode: Int,
}

pub type ShardState {
  day: Int,
  paid_day: Int,
  month: Int,
  paid_month: Int,
}

pub type ShortState {
  active: Bool,
  episode: Int,
  since: Int,
  reg_deadline: Int,
  last_exit: Int,
  tallies: List<Tally>,
}

pub type Tally {
  day: Int,
  open: Int,
}

pub type GraceState {
  until: Int,
}

// --------------------------------------------------------------- redeemers

/// Spend redeemer of `redeem_queue`: the owner's plain cancel, or the gate to
/// one of the three withdraw-zero scripts (which check everything else).
pub type QueueSpend {
  Cancel
  Run
}

/// Mint redeemer is unused.
/// The redeemer of each withdraw-zero script: the queue policy it works on,
/// and the action. Each script names its own action type below.
pub type FlowAction {
  FlowRequest
  FlowInstant { holder: ByteArray, qty: Int }
  FlowSettle
  FlowSweep
  /// Short mode (D-32): pay the head day's registered Requests. Lives here
  /// because it is `Settle` with the ShortState spent instead of referenced.
  FlowPayShort
}

pub type FlowRedeemer {
  queue: PolicyId,
  action: FlowAction,
}

/// What `redeem_queue` reads of any of the three withdraw redeemers: the queue
/// they name (always the first field) and nothing else.
pub type QueueEnvelope {
  queue: PolicyId,
  action: Data,
}

pub type AdminAction {
  Genesis
  Suspend { until: Int }
  Resume
  AnnounceLimits { daily: Int, monthly: Int }
  ApplyLimits
  SyncFloor
  Fund
  AnnounceDefund { shard: Int, amount: Int }
  Defund
  GrantGrace { holder: ByteArray, until: Int }
}

pub type AdminRedeemer {
  queue: PolicyId,
  action: AdminAction,
}

pub type ShortAction {
  EnterShort
  Register
  ExitShort
  CancelRegistered
  VetoDefund
}

pub type ShortRedeemer {
  queue: PolicyId,
  action: ShortAction,
}

// -------------------------------------------------------------- pure rules

/// Day index of a POSIX time.
pub fn day_of(t: Int) -> Int {
  t / day_ms
}

/// Month (30-day block) index of a day index.
pub fn month_of(day: Int) -> Int {
  day / month_days
}

/// A Request's `payable_after`, fixed when it is created.
pub fn payable_after_of(bucket: Int, settle_delay: Int) -> Int {
  ( bucket + 1 ) * day_ms + settle_delay
}

/// `floor = max(min_daily_limit, minted_supply / 100)` (D-34).
pub fn limit_floor(minted_supply: Int) -> Int {
  let share = minted_supply / floor_div
  if share > min_daily_limit {
    share
  } else {
    min_daily_limit
  }
}

/// Both limits at or above the floor, monthly never below daily.
pub fn limits_ok(daily: Int, monthly: Int, floor: Int) -> Bool {
  daily >= floor && monthly >= daily
}

/// A Request fits a shard today: counters reset when the window index moved,
/// never go backwards, and the cap (global limit / shards) holds.
pub fn shard_after(
  s: ShardState,
  day: Int,
  qty: Int,
  daily_cap: Int,
  monthly_cap: Int,
) -> Option<ShardState> {
  let month = month_of(day)
  if day >= s.day && month >= s.month {
    let pd =
      if day == s.day {
        s.paid_day
      } else {
        0
      } + qty
    let pm =
      if month == s.month {
        s.paid_month
      } else {
        0
      } + qty
    if pd <= daily_cap && pm <= monthly_cap {
      Some(ShardState { day, paid_day: pd, month, paid_month: pm })
    } else {
      None
    }
  } else {
    None
  }
}

/// Add `qty` to the tally of `day`, keeping the list sorted by day.
pub fn tally_add(ts: List<Tally>, day: Int, qty: Int) -> List<Tally> {
  when ts is {
    [] -> [Tally { day, open: qty }]
    [t, ..rest] ->
      if day == t.day {
        [Tally { day, open: t.open + qty }, ..rest]
      } else if day < t.day {
        [Tally { day, open: qty }, ..ts]
      } else {
        [t, ..tally_add(rest, day, qty)]
      }
  }
}

/// Take `qty` off the tally of `day`; `None` if the day is absent or holds
/// less. A tally that reaches 0 is removed.
pub fn tally_sub(ts: List<Tally>, day: Int, qty: Int) -> Option<List<Tally>> {
  when ts is {
    [] -> None
    [t, ..rest] ->
      if day == t.day {
        if t.open > qty {
          Some([Tally { day, open: t.open - qty }, ..rest])
        } else if t.open == qty {
          Some(rest)
        } else {
          None
        }
      } else if day < t.day {
        None
      } else {
        when tally_sub(rest, day, qty) is {
          Some(r) -> Some([t, ..r])
          None -> None
        }
      }
  }
}

/// The tallies are strictly increasing by day with positive amounts.
pub fn tallies_sorted(ts: List<Tally>) -> Bool {
  when ts is {
    [] -> True
    [t] -> t.open > 0
    [t, u, ..rest] -> t.open > 0 && t.day < u.day && tallies_sorted([u, ..rest])
  }
}

/// The head day of the tallies, if any.
pub fn head_day(ts: List<Tally>) -> Option<Int> {
  when ts is {
    [] -> None
    [t, ..] -> Some(t.day)
  }
}

pub fn tallies_empty(ts: List<Tally>) -> Bool {
  list.is_empty(ts)
}

/// A genesis QueueConfig: every parameter within its hard bound, nothing
/// pending, no suspension, limits at or above the floor.
pub fn config_valid(c: QueueConfig, floor: Int) -> Bool {
  bytearray.length(c.payout_policy) == 28 && bytearray.length(c.payout_name) <= 32 && c.settle_delay >= 0 && c.settle_delay <= max_settle_delay && c.min_request > 0 && c.instant_max > 0 && c.settle_tip >= 0 && c.settle_tip <= max_settle_tip && c.shards >= 1 && c.shards <= max_shards && c.grace_ms >= 0 && c.grace_ms <= max_grace_ms && c.suspended_until == 0 && c.pending_limits == None && c.pending_defund == None && c.epoch == 0 && limits_ok(
    c.daily_limit,
    c.monthly_limit,
    floor,
  )
}

/// `Suspend`: a finite window of at most a day, the previous suspension ended
/// at least the reopen gap ago, the new one outlasts the transaction and is at
/// most 3 days long from `lo`.
pub fn can_suspend(lo: Int, hi: Int, until: Int, previous_until: Int) -> Bool {
  hi >= lo && hi - lo <= day_ms && lo >= previous_until + suspend_reopen_gap_ms && hi < until && until <= lo + max_suspend_ms
}

/// A suspension is in force at `lo`.
pub fn suspended(until: Int, lo: Int) -> Bool {
  until > lo
}

// ------------------------------------------------------------------ tests

fn cfg_ok() -> QueueConfig {
  QueueConfig {
    payout_policy: #"99999999999999999999999999999999999999999999999999999999",
    payout_name: "USDM",
    settle_delay: 2 * day_ms,
    min_request: 100_000_000,
    instant_max: 10_000_000_000,
    settle_tip: 200_000,
    daily_limit: 40_000_000_000,
    monthly_limit: 400_000_000_000,
    shards: 4,
    grace_ms: 14 * day_ms,
    suspended_until: 0,
    pending_limits: None,
    pending_defund: None,
    epoch: 0,
  }
}

test the_floor_is_ten_thousand_tsra_for_a_small_supply() {
  limit_floor(0) == 10_000_000_000 && limit_floor(500_000_000_000) == 10_000_000_000
}

test the_floor_is_one_percent_of_a_large_supply() {
  limit_floor(2_000_000_000_000) == 20_000_000_000 && limit_floor(1_000_000_000_000) == 10_000_000_000 && limit_floor(
    1_000_000_000_100,
  ) == 10_000_000_001
}

test the_floor_uses_whole_division() {
  limit_floor(1_000_000_000_099) == 10_000_000_000
}

test limits_must_reach_the_floor_and_the_monthly_the_daily() {
  limits_ok(10_000_000_000, 10_000_000_000, 10_000_000_000) && !limits_ok(
    9_999_999_999,
    10_000_000_000,
    10_000_000_000,
  ) && !limits_ok(10_000_000_000, 9_999_999_999, 10_000_000_000) && !limits_ok(0, 0, 10_000_000_000)
}

test day_and_month_windows() {
  day_of(0) == 0 && day_of(day_ms - 1) == 0 && day_of(day_ms) == 1 && month_of(29) == 0 && month_of(
    30,
  ) == 1 && month_of(59) == 1 && month_of(60) == 2
}

test payable_after_is_the_end_of_the_bucket_plus_the_delay() {
  payable_after_of(20, 2 * day_ms) == 23 * day_ms && payable_after_of(0, 0) == day_ms
}

test shard_names_are_distinct_six_byte_names() {
  shard_name(0) != shard_name(1) && bytearray.length(shard_name(15)) == 6 && bytearray.at(
    shard_name(15),
    5,
  ) == 15 && bytearray.take(shard_name(3), 5) == "shard"
}

fn sh(day: Int, pd: Int, month: Int, pm: Int) -> ShardState {
  ShardState { day, paid_day: pd, month, paid_month: pm }
}

test a_shard_accepts_up_to_its_caps_and_not_a_unit_more() {
  shard_after(sh(20, 9, 0, 9), 20, 1, 10, 10) == Some(sh(20, 10, 0, 10)) && shard_after(sh(20, 9, 0, 9), 20, 2, 10, 10) == None && shard_after(
    sh(20, 0, 0, 99),
    20,
    1,
    10,
    100,
  ) == Some(sh(20, 1, 0, 100)) && shard_after(sh(20, 0, 0, 99), 20, 2, 10, 100) == None
}

test a_new_day_resets_the_daily_counter_only() {
  shard_after(sh(20, 10, 0, 50), 21, 5, 10, 100) == Some(sh(21, 5, 0, 55))
}

test a_new_month_resets_the_monthly_counter() {
  shard_after(sh(29, 0, 0, 100), 30, 5, 10, 100) == Some(sh(30, 5, 1, 5))
}

test a_shard_never_moves_to_an_earlier_window() {
  shard_after(sh(20, 0, 0, 0), 19, 1, 10, 100) == None && shard_after(sh(30, 0, 1, 0), 29, 1, 10, 100) == None
}

test tally_add_keeps_the_days_sorted_and_merges_equal_days() {
  let a = tally_add([], 5, 1)
  let b = tally_add(a, 3, 2)
  let c = tally_add(b, 9, 3)
  let d = tally_add(c, 5, 10)
  b == [Tally { day: 3, open: 2 }, Tally { day: 5, open: 1 }] && d == [
    Tally { day: 3, open: 2 },
    Tally { day: 5, open: 11 },
    Tally { day: 9, open: 3 },
  ] && tallies_sorted(d)
}

test tally_sub_lowers_one_day_and_drops_it_at_zero() {
  let ts = [Tally { day: 3, open: 2 }, Tally { day: 5, open: 11 }, Tally { day: 9, open: 3 }]
  tally_sub(ts, 5, 1) == Some([Tally { day: 3, open: 2 }, Tally { day: 5, open: 10 }, Tally { day: 9, open: 3 }]) && tally_sub(
    ts,
    3,
    2,
  ) == Some([Tally { day: 5, open: 11 }, Tally { day: 9, open: 3 }]) && tally_sub(ts, 9, 3) == Some(
    [Tally { day: 3, open: 2 }, Tally { day: 5, open: 11 }],
  )
}

test tally_sub_refuses_an_absent_day_or_more_than_it_holds() {
  let ts = [Tally { day: 3, open: 2 }, Tally { day: 5, open: 11 }]
  tally_sub(ts, 4, 1) == None && tally_sub(ts, 3, 3) == None && tally_sub(ts, 6, 1) == None && tally_sub([], 1, 1) == None
}

test tallies_must_be_strictly_increasing_and_positive() {
  tallies_sorted([]) && tallies_sorted([Tally { day: 1, open: 1 }, Tally { day: 2, open: 1 }]) && !tallies_sorted(
    [Tally { day: 2, open: 1 }, Tally { day: 1, open: 1 }],
  ) && !tallies_sorted([Tally { day: 1, open: 1 }, Tally { day: 1, open: 1 }]) && !tallies_sorted(
    [Tally { day: 1, open: 0 }],
  )
}

test the_head_day_is_the_oldest() {
  head_day([]) == None && head_day([Tally { day: 4, open: 1 }, Tally { day: 6, open: 1 }]) == Some(4) && tallies_empty([]) && !tallies_empty(
    [Tally { day: 4, open: 1 }],
  )
}

test a_genesis_config_within_every_bound_is_valid() {
  config_valid(cfg_ok(), 10_000_000_000)
}

test every_genesis_bound_is_exact() {
  let c = cfg_ok()
  config_valid(QueueConfig { ..c, settle_delay: max_settle_delay }, 10_000_000_000) && !config_valid(
    QueueConfig { ..c, settle_delay: max_settle_delay + 1 },
    10_000_000_000,
  ) && config_valid(QueueConfig { ..c, settle_tip: max_settle_tip }, 10_000_000_000) && !config_valid(
    QueueConfig { ..c, settle_tip: max_settle_tip + 1 },
    10_000_000_000,
  ) && config_valid(QueueConfig { ..c, grace_ms: max_grace_ms }, 10_000_000_000) && !config_valid(
    QueueConfig { ..c, grace_ms: max_grace_ms + 1 },
    10_000_000_000,
  ) && config_valid(QueueConfig { ..c, shards: max_shards }, 10_000_000_000) && !config_valid(
    QueueConfig { ..c, shards: max_shards + 1 },
    10_000_000_000,
  ) && !config_valid(QueueConfig { ..c, shards: 0 }, 10_000_000_000) && config_valid(
    QueueConfig { ..c, settle_delay: 0, settle_tip: 0, grace_ms: 0 },
    10_000_000_000,
  ) && !config_valid(c, 40_000_000_001)
}

test genesis_config_names_are_bounded() {
  let c = cfg_ok()
  config_valid(QueueConfig { ..c, payout_name: "" }, 10_000_000_000) && config_valid(
    QueueConfig { ..c, payout_name: "12345678901234567890123456789012" },
    10_000_000_000,
  ) && !config_valid(
    QueueConfig { ..c, payout_name: "123456789012345678901234567890123" },
    10_000_000_000,
  ) && !config_valid(QueueConfig { ..c, payout_policy: #"9999" }, 10_000_000_000)
}

test a_suspension_is_bounded_in_length_and_spacing() {
  let lo = 10 * day_ms
  can_suspend(lo, lo + 1, lo + max_suspend_ms, 0) && !can_suspend(lo, lo + 1, lo + max_suspend_ms + 1, 0) && !can_suspend(
    lo,
    lo + 1,
    lo + 1,
    0,
  ) && can_suspend(lo, lo + 1, lo + 2, lo - suspend_reopen_gap_ms) && !can_suspend(
    lo,
    lo + 1,
    lo + 2,
    lo - suspend_reopen_gap_ms + 1,
  ) && can_suspend(lo, lo + day_ms, lo + day_ms + 1, 0) && !can_suspend(lo, lo + day_ms + 1, lo + day_ms + 2, 0)
}

test a_suspension_is_in_force_until_its_end() {
  suspended(10, 9) && !suspended(10, 10) && !suspended(0, 0)
}

test a_zero_tally_is_never_sorted_even_before_another_day() {
  !tallies_sorted([Tally { day: 1, open: 0 }, Tally { day: 2, open: 1 }])
}

test a_suspension_may_open_and_end_in_a_zero_length_window() {
  can_suspend(10 * day_ms, 10 * day_ms, 10 * day_ms + 1, 0)
}
