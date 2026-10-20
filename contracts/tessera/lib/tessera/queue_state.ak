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
use cardano/address.{Address}
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

/// At most this many Buffer shards.
pub const max_shards: Int = 16

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
  PayShort
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
