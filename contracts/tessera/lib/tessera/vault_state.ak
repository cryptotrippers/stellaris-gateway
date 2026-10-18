//// sTSRA vault datum types and hard limits (Phase 2.4, SPEC.md §3).
//// PROVISIONAL like the reserve datum: 2.5 (first-loss / ReportLoss) and 2.6
//// (redemption queue) may extend it.

use cardano/address.{Address}

/// Starting value of the cooldown loss index; only ReportLoss (2.5) lowers it.
pub const loss_index_start: Int = 1_000_000_000_000

/// Long-tier yield weight, basis points of the short tier's weight.
pub const min_long_weight_bps: Int = 10_000

pub const max_long_weight_bps: Int = 15_000

/// Short-tier unstake cooldown: 7 to 14 days.
pub const min_short_cooldown_ms: Int = 604_800_000

pub const max_short_cooldown_ms: Int = 1_209_600_000

/// Long-tier lock: at least the short cooldown, at most 90 days.
pub const max_long_lock_ms: Int = 7_776_000_000

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
    long_lock_ms >= short_cooldown_ms,
    long_lock_ms <= max_long_lock_ms,
    protocol_bps >= 0,
    protocol_bps <= max_protocol_bps,
  }
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
