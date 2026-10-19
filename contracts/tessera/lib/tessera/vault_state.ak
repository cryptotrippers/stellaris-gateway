//// sTSRA vault datum types and hard limits (Phase 2.4, SPEC.md §3).
//// PROVISIONAL like the reserve datum: 2.5 (first-loss / ReportLoss) and 2.6
//// (redemption queue) may extend it.

use aiken/collection/list
use cardano/address.{Address, VerificationKey}

/// Starting value of the cooldown loss index; only ReportLoss (2.5) lowers it.
pub const loss_index_start: Int = 1_000_000_000_000

/// Long-tier yield weight, basis points of the short tier's weight.
pub const min_long_weight_bps: Int = 10_000

pub const max_long_weight_bps: Int = 15_000

/// Short-tier unstake cooldown: 7 to 14 days.
pub const min_short_cooldown_ms: Int = 604_800_000

pub const max_short_cooldown_ms: Int = 1_209_600_000

/// Long-tier lock: at least twice the short cooldown (H2.2), at most 90 days.
pub const max_long_lock_ms: Int = 7_776_000_000

/// Reported yield vests linearly into the share prices over 7 days (H2.1).
/// A hard constant, not a committee bound.
pub const vest_period_ms: Int = 604_800_000

/// Asset name of the fungible short-tier share token.
pub const stsra_name: ByteArray = "sTSRA"

/// The vault's single State: both share classes' books and the bounds.
pub type VaultState {
  /// Total sTSRA in existence (class S shares).
  short_shares: Int,
  /// TSRA owned by class S.
  short_assets: Int,
  /// Sum of `shares` over live long-tier Positions (class L).
  long_shares: Int,
  /// TSRA owned by class L.
  long_assets: Int,
  /// Cooldown loss index (`loss_index_start` at genesis).
  loss_index: Int,
  /// Reported yield not yet in the share prices (H2.1), per class. It is
  /// held in the State's TSRA and vests linearly from `vest_from` to
  /// `vest_until`; `fold` moves what has vested into `short_assets` /
  /// `long_assets`.
  vest_short: Int,
  vest_long: Int,
  vest_from: Int,
  vest_until: Int,
  long_weight_bps: Int,
  short_cooldown_ms: Int,
  long_lock_ms: Int,
  /// Protocol share of gross yield, at most `exchange.max_yield_fee_bps`.
  protocol_bps: Int,
  /// Receives half the protocol cut (bootstrap parameter until 2.5).
  first_loss_addr: Address,
  /// Receives the other half.
  treasury_addr: Address,
  epoch: Int,
}

/// A long-tier lock: `shares` of class L, payable to `owner` from `unlock_at`.
pub type Position {
  owner: Address,
  shares: Int,
  unlock_at: Int,
}

/// A short-tier cooldown claim: `value` TSRA escrowed at request time,
/// payable to `owner` from `claim_after`, scaled by the loss index.
pub type Ticket {
  owner: Address,
  value: Int,
  index_at_request: Int,
  claim_after: Int,
}

/// Every UTxO at the vault address carries one of these (distinct
/// constructors, so a Position can never be read as a State, etc.).
pub type VaultDatum {
  StateDatum(VaultState)
  PositionDatum(Position)
  TicketDatum(Ticket)
}

/// The committee-adjustable bounds are inside their hard limits.
pub fn bounds_ok(
  long_weight_bps: Int,
  short_cooldown_ms: Int,
  long_lock_ms: Int,
  protocol_bps: Int,
  max_protocol_bps: Int,
) -> Bool {
  and {
    long_weight_bps >= min_long_weight_bps,
    long_weight_bps <= max_long_weight_bps,
    short_cooldown_ms >= min_short_cooldown_ms,
    short_cooldown_ms <= max_short_cooldown_ms,
    long_lock_ms >= 2 * short_cooldown_ms,
    long_lock_ms <= max_long_lock_ms,
    protocol_bps >= 0,
    protocol_bps <= max_protocol_bps,
  }
}

/// The part of `unvested` that has vested by time `t` on the straight line
/// from (`from`, `unvested`) to (`until`, 0): clamped to [0, unvested] and
/// rounded down, so rounding dust stays unvested in the pool.
pub fn vested(unvested: Int, from: Int, until: Int, t: Int) -> Int {
  if t <= from {
    0
  } else if t >= until {
    unvested
  } else {
    unvested * ( t - from ) / ( until - from )
  }
}

/// Book what has vested by `t` into the class assets and restart the line at
/// `t` (clamped into [vest_from, vest_until], so the schedule never runs
/// backwards or past its end). The line's slope is unchanged, so folding at
/// any time leaves the vesting schedule as it was, up to rounding dust.
/// Only ever called with the validity LOWER bound: the ledger guarantees
/// that time has been reached.
pub fn fold(s: VaultState, t: Int) -> VaultState {
  let t1 =
    if t < s.vest_from {
      s.vest_from
    } else if t > s.vest_until {
      s.vest_until
    } else {
      t
    }
  let vs = vested(s.vest_short, s.vest_from, s.vest_until, t1)
  let vl = vested(s.vest_long, s.vest_from, s.vest_until, t1)
  VaultState {
    ..s,
    short_assets: s.short_assets + vs,
    long_assets: s.long_assets + vl,
    vest_short: s.vest_short - vs,
    vest_long: s.vest_long - vl,
    vest_from: t1,
  }
}

/// Class S assets at time `t` for pricing: booked plus vested-by-`t`.
pub fn short_assets_at(s: VaultState, t: Int) -> Int {
  s.short_assets + vested(s.vest_short, s.vest_from, s.vest_until, t)
}

/// Class L assets at time `t` for pricing: booked plus vested-by-`t`.
pub fn long_assets_at(s: VaultState, t: Int) -> Int {
  s.long_assets + vested(s.vest_long, s.vest_from, s.vest_until, t)
}

/// ReportYield split (SPEC.md §3.5). Returns
/// (to_first_loss, to_treasury, y_short, y_long), with
/// `to_first_loss + to_treasury + y_short + y_long == gross` exactly: the
/// short tier takes the rounding remainder, so dust stays in the pool.
pub fn split_yield(
  gross: Int,
  protocol_bps: Int,
  short_assets: Int,
  long_assets: Int,
  long_weight_bps: Int,
) -> (Int, Int, Int, Int) {
  let cut = gross * protocol_bps / 10_000
  let to_first_loss = cut / 2
  let to_treasury = cut - to_first_loss
  let net = gross - cut
  let w_short = short_assets * 10_000
  let w_long = long_assets * long_weight_bps
  let y_long = net * w_long / ( w_short + w_long )
  (to_first_loss, to_treasury, net - y_long, y_long)
}

// ------------------------------------------------------------------ tests

test split_conserves_gross_exactly() {
  // a table of awkward values, including heavy rounding
  let cases =
    [
      (1, 1_250, 1, 1, 12_500),
      (999_999, 1_250, 3, 7, 12_500),
      (10_000_000, 1_250, 100_000_000, 50_000_000, 12_500),
      (7_777_777, 2_000, 1, 999_999_999, 15_000),
      (123_456_789, 0, 5, 0, 10_000),
      (123_456_789, 2_000, 0, 5, 15_000),
    ]
  cases
    |> fold_all(
        fn(c) {
          let (g, p, s, l, w) = c
          let (a, b, ys, yl) = split_yield(g, p, s, l, w)
          a + b + ys + yl == g && a >= 0 && b >= 0 && ys >= 0 && yl >= 0
        },
      )
}

fn fold_all(xs: List<a>, f: fn(a) -> Bool) -> Bool {
  when xs is {
    [] -> True
    [x, ..rest] -> f(x) && fold_all(rest, f)
  }
}

test long_tier_earns_the_weight_per_tsra() {
  // equal TSRA in both tiers, 1.25x weight: long gets 1.25 / 2.25 of net
  let (_, _, ys, yl) = split_yield(9_000_000, 0, 100_000_000, 100_000_000, 12_500)
  yl == 5_000_000 && ys == 4_000_000
}

test the_weighting_never_touches_the_protocol_cut() {
  let (a1, b1, _, _) = split_yield(10_000_000, 1_250, 100, 100, 10_000)
  let (a2, b2, _, _) = split_yield(10_000_000, 1_250, 100, 100, 15_000)
  a1 == a2 && b1 == b2 && a1 + b1 == 1_250_000
}

test half_the_cut_goes_to_first_loss() {
  let (a, b, _, _) = split_yield(10_000_001, 1_250, 1, 1, 12_500)
  // cut = 1_250_000 (floor); half and the other half (odd remainder to treasury)
  a == 625_000 && b == 625_000
}

test bounds_hard_limits() {
  let p = 2_000
  bounds_ok(12_500, 604_800_000, 2_592_000_000, 1_250, p) && !bounds_ok(
    15_001,
    604_800_000,
    2_592_000_000,
    1_250,
    p,
  ) && !bounds_ok(9_999, 604_800_000, 2_592_000_000, 1_250, p) && !bounds_ok(
    12_500,
    604_799_999,
    2_592_000_000,
    1_250,
    p,
  ) && !bounds_ok(12_500, 1_209_600_001, 2_592_000_000, 1_250, p) && !bounds_ok(
    12_500,
    604_800_000,
    7_776_000_001,
    1_250,
    p,
  ) && !bounds_ok(12_500, 864_000_000, 777_600_000, 1_250, p) && !bounds_ok(
    12_500,
    604_800_000,
    2_592_000_000,
    2_001,
    p,
  ) && !bounds_ok(12_500, 604_800_000, 2_592_000_000, -1, p)
}

test bounds_lock_is_at_least_twice_the_cooldown() {
  let p = 2_000
  bounds_ok(12_500, 604_800_000, 1_209_600_000, 1_250, p) && !bounds_ok(
    12_500,
    604_800_000,
    1_209_599_999,
    1_250,
    p,
  ) && bounds_ok(12_500, 1_209_600_000, 2_419_200_000, 1_250, p) && !bounds_ok(
    12_500,
    1_209_600_000,
    2_419_199_999,
    1_250,
    p,
  )
}

// -- H2.1 vesting

fn t_key(k: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(k), stake_credential: None }
}

/// `y` TSRA of short-tier yield (and `y / 3` long) vesting from 1_000 over a week.
fn t_vesting(y: Int) -> VaultState {
  VaultState {
    short_shares: 100,
    short_assets: 1_000_003,
    long_shares: 100,
    long_assets: 2_000_005,
    loss_index: loss_index_start,
    vest_short: y,
    vest_long: y / 3,
    vest_from: 1_000,
    vest_until: 1_000 + vest_period_ms,
    long_weight_bps: 12_500,
    short_cooldown_ms: 604_800_000,
    long_lock_ms: 1_209_600_000,
    protocol_bps: 1_250,
    first_loss_addr: t_key(#"f1"),
    treasury_addr: t_key(#"f2"),
    epoch: 0,
  }
}

test vested_is_clamped_to_the_unvested_amount() {
  and {
    vested(7, 10, 20, 0) == 0,
    vested(7, 10, 20, 10) == 0,
    vested(7, 10, 20, 15) == 3,
    vested(7, 10, 20, 19) == 6,
    vested(7, 10, 20, 20) == 7,
    vested(7, 10, 20, 999) == 7,
  }
}

/// Fold `s` at each time in turn, checking that booked + vesting stays
/// exactly the same and that neither part ever goes negative.
fn conserves(s: VaultState, times: List<Int>) -> Bool {
  let total_s = s.short_assets + s.vest_short
  let total_l = s.long_assets + s.vest_long
  when times is {
    [] -> True
    [t, ..rest] -> {
      let f = fold(s, t)
      and {
        f.short_assets + f.vest_short == total_s,
        f.long_assets + f.vest_long == total_l,
        f.vest_short >= 0,
        f.vest_long >= 0,
        f.short_assets >= s.short_assets,
        f.long_assets >= s.long_assets,
        f.vest_from >= s.vest_from,
        f.vest_from <= f.vest_until,
        conserves(f, rest),
      }
    }
  }
}

test vesting_conserves_the_yield_exactly() {
  // awkward amounts and times, including out-of-order and stale times
  let times = [0, 1_001, 77_777, 12_345, 201_600_001, 302_400_000, 604_800_999, 604_801_000, 9_999_999_999]
  conserves(t_vesting(7_000_001), times) && conserves(t_vesting(1), times) && conserves(
    t_vesting(999_999_937),
    times,
  )
}

test vesting_completes_at_the_end_of_the_week() {
  let s = t_vesting(7_000_001)
  let f = fold(fold(fold(s, 302_400_000), 500_000_000), 1_000 + vest_period_ms)
  f.vest_short == 0 && f.vest_long == 0 && f.short_assets == s.short_assets + s.vest_short && f.long_assets == s.long_assets + s.vest_long
}

test folding_early_never_raises_a_price() {
  // the price at `b` after a fold at `a` is never above the unfolded price,
  // and never below it by more than one unit of rounding dust
  let s = t_vesting(7_000_001)
  let pairs =
    [(5_000, 6_000), (77_777, 302_400_000), (302_400_000, 302_400_001), (1, 604_800_999), (500_000_000, 700_000_000)]
  list.all(
    pairs,
    fn(p) {
      let (a, b) = p
      let f = fold(s, a)
      let d_short = short_assets_at(s, b) - short_assets_at(f, b)
      let d_long = long_assets_at(s, b) - long_assets_at(f, b)
      d_short >= 0 && d_short <= 1 && d_long >= 0 && d_long <= 1
    },
  )
}

test prices_never_fall_with_time() {
  // so a staker (priced at hi >= now) never pays less than the price at now,
  // and an exit (priced at lo <= now) never gets more
  let s = t_vesting(7_000_001)
  let times = [0, 1_000, 1_001, 50_000, 302_400_000, 604_800_999, 604_801_000, 604_801_001]
  rising(s, times)
}

fn rising(s: VaultState, times: List<Int>) -> Bool {
  when times is {
    [a, b, ..rest] ->
      short_assets_at(s, a) <= short_assets_at(s, b) && long_assets_at(s, a) <= long_assets_at(
        s,
        b,
      ) && rising(s, [b, ..rest])
    _ -> True
  }
}
