//// ReportLoss arithmetic (Phase 2.5b, SPEC.md §3a.2, §3a.6). Pure: no
//// transaction or datum access, so the whole waterfall is unit-testable.
////
//// A loss `L` is absorbed in this order, entirely recomputed on chain so the
//// committee chooses the amount and never the allocation:
////
////   1. unvested yield `u = min(L, vest_short + vest_long)`;
////   2. the first-loss reserve `d = min(L - u, balance)`;
////   3. the stakers and the open Tickets, spread over `E = A + T` pro rata
////      (`A` the booked assets of both classes, `T` the TSRA escrowed in open
////      Tickets), so a Ticket bears exactly the stakers' rate and nothing is
////      charged twice. `rem' = min(L - u - d, E)`.
////
//// Only the stakers' share is burned now; the Tickets' share is burned Ticket
//// by Ticket, as each Claim's excess, once `loss_index'` is applied.

use aiken/collection/list
use tessera/rules

/// Everything `ReportLoss` derives from `(state, balance, loss)`.
pub type LossSplit {
  /// Unvested yield absorbed, in total and per class.
  u: Int,
  u_short: Int,
  u_long: Int,
  /// First-loss reserve drawn.
  d: Int,
  /// Stakers' share, in total and per class (floored for the short class).
  r_stakers: Int,
  r_short: Int,
  r_long: Int,
  /// Open Tickets' share (not burned now).
  r_tickets: Int,
  /// Loss beyond everything exposed: not an on-chain event.
  residual: Int,
  /// The new cooldown loss index.
  loss_index: Int,
  /// What is burned now: `u + d + r_stakers`.
  qty: Int,
  /// The backing the loss destroyed: `u + d + r_stakers + r_tickets`.
  written_off: Int,
}

fn min(a: Int, b: Int) -> Int {
  if a < b {
    a
  } else {
    b
  }
}

/// The waterfall. `short_assets` / `long_assets` are the booked assets AFTER
/// folding the vesting at `lo`.
pub fn split_loss(
  loss: Int,
  vest_short: Int,
  vest_long: Int,
  balance: Int,
  short_assets: Int,
  long_assets: Int,
  ticket_escrow: Int,
  loss_index: Int,
) -> LossSplit {
  let unvested = vest_short + vest_long
  let u = min(loss, unvested)
  let u_short =
    if unvested == 0 {
      0
    } else {
      u * vest_short / unvested
    }
  let d = min(loss - u, balance)
  let rem = loss - u - d
  let a = short_assets + long_assets
  let e = a + ticket_escrow
  let rem1 = min(rem, e)
  let r_stakers =
    if e == 0 {
      0
    } else {
      rem1 * a / e
    }
  let r_short =
    if a == 0 {
      0
    } else {
      r_stakers * short_assets / a
    }
  let index1 =
    if e == 0 || rem1 == 0 {
      loss_index
    } else {
      let scaled = loss_index * ( e - rem1 ) / e
      if scaled < rules.min_loss_index {
        rules.min_loss_index
      } else {
        scaled
      }
    }
  LossSplit {
    u,
    u_short,
    u_long: u - u_short,
    d,
    r_stakers,
    r_short,
    r_long: r_stakers - r_short,
    r_tickets: rem1 - r_stakers,
    residual: rem - rem1,
    loss_index: index1,
    qty: u + d + r_stakers,
    written_off: u + d + rem1,
  }
}

/// A class is dead after a loss when shares are outstanding and the price
/// fell below 1/1000 TSRA per share (this includes exactly 0).
pub fn class_dead(shares: Int, assets_after: Int) -> Bool {
  shares > 0 && assets_after * rules.dead_price_den < shares
}

// ------------------------------------------------------------------ tests

fn split(loss: Int) -> LossSplit {
  // 40 + 20 unvested, 100 first-loss, 600 + 400 staked, 500 in Tickets
  split_loss(loss, 40, 20, 100, 600, 400, 500, 1_000_000_000_000)
}

test a_small_loss_eats_only_unvested_yield() {
  let s = split(30)
  s.u == 30 && s.u_short == 20 && s.u_long == 10 && s.d == 0 && s.r_stakers == 0 && s.r_tickets == 0 && s.residual == 0 && s.qty == 30 && s.written_off == 30 && s.loss_index == 1_000_000_000_000
}

test a_loss_equal_to_the_unvested_yield_stops_there() {
  let s = split(60)
  s.u == 60 && s.d == 0 && s.r_stakers == 0 && s.qty == 60
}

test the_first_loss_reserve_is_next() {
  let s = split(110)
  s.u == 60 && s.d == 50 && s.r_stakers == 0 && s.qty == 110 && s.loss_index == 1_000_000_000_000
}

test the_first_loss_reserve_can_be_exactly_exhausted() {
  let s = split(160)
  s.u == 60 && s.d == 100 && s.r_stakers == 0 && s.r_tickets == 0
}

test stakers_and_tickets_share_the_rest_pro_rata() {
  // rem = 300 over E = 1000 + 500 = 1500: stakers 1000/1500 of it = 200,
  // tickets 100; index falls by 300/1500 = 20%
  let s = split(460)
  and {
    s.u == 60,
    s.d == 100,
    s.r_stakers == 200,
    s.r_short == 120,
    s.r_long == 80,
    s.r_tickets == 100,
    s.residual == 0,
    s.loss_index == 800_000_000_000,
    s.qty == 360,
    s.written_off == 460,
  }
}

test a_loss_beyond_everything_leaves_a_residual() {
  // E = 1500: rem' = 1500, residual = the rest
  let s = split(60 + 100 + 1_500 + 77)
  and {
    s.r_stakers == 1_000,
    s.r_tickets == 500,
    s.residual == 77,
    s.loss_index == 1_000_000,
    s.written_off == 60 + 100 + 1_500,
    s.qty == 60 + 100 + 1_000,
  }
}

test with_no_open_tickets_the_stakers_take_all_of_it() {
  let s = split_loss(300, 0, 0, 0, 600, 400, 0, 1_000_000_000_000)
  s.r_stakers == 300 && s.r_tickets == 0 && s.r_short == 180 && s.r_long == 120 && s.loss_index == 700_000_000_000
}

test with_no_staked_assets_the_tickets_absorb_alone() {
  let s = split_loss(100, 0, 0, 0, 0, 0, 500, 1_000_000_000_000)
  s.r_stakers == 0 && s.r_short == 0 && s.r_long == 0 && s.r_tickets == 100 && s.qty == 0 && s.written_off == 100 && s.loss_index == 800_000_000_000
}

test with_nothing_exposed_it_is_all_residual() {
  let s = split_loss(100, 0, 0, 0, 0, 0, 0, 1_000_000_000_000)
  s.r_stakers == 0 && s.r_tickets == 0 && s.residual == 100 && s.written_off == 0 && s.qty == 0 && s.loss_index == 1_000_000_000_000
}

test the_index_never_falls_below_the_floor() {
  let s = split_loss(1_000_000, 0, 0, 0, 1_000_000, 0, 0, 2_000_000)
  s.loss_index == rules.min_loss_index
}

test the_stakers_split_adds_up_with_rounding() {
  // awkward numbers: the class shares always add up and the long class never
  // pays more than it owns
  let cases =
    [
      split_loss(1_001, 0, 0, 0, 7, 11, 3, 999_999_999_999),
      split_loss(999_983, 5, 9, 17, 100_003, 200_009, 77, 123_456_789_012),
      split_loss(5, 0, 0, 0, 1, 1, 1, 1_000_000_000_000),
      split_loss(123_456, 1_001, 0, 33, 333_333, 1, 0, 1_000_000_000_000),
    ]
  list.all(
    cases,
    fn(s) {
      s.r_short + s.r_long == s.r_stakers && s.r_short >= 0 && s.r_long >= 0 && s.r_tickets >= 0 && s.residual >= 0 && s.qty + s.r_tickets == s.written_off
    },
  )
}

test the_long_class_never_pays_more_than_it_owns() {
  let s = split_loss(999, 0, 0, 0, 1, 1_000_000, 0, 1_000_000_000_000)
  s.r_long <= 1_000_000 && s.r_short <= 1
}

test a_class_is_dead_below_a_thousandth_of_a_tsra_per_share() {
  and {
    class_dead(1_000_000, 0),
    class_dead(1_000_000, 999),
    !class_dead(1_000_000, 1_000),
    !class_dead(0, 0),
    !class_dead(1, 1),
  }
}
