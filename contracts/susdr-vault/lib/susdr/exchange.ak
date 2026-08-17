//// Pure exchange-rate math for the sUSDr vault.
////
//// Mirrors the conventions of stellaris/shares.ak: floor rounding always in
//// the protocol's favour, no transaction/datum access, standalone testable.
////
//// Units: `usdr` amounts are in the stablecoin's smallest unit (1e-6 USDr,
//// matching Cardano native-asset integer quantities). `shares` are sUSDr
//// units, same precision.

/// Minimum first deposit: 10 USDr. Blocks the classic first-depositor
/// share-price inflation attack (mint 1 share cheap, donate to skew rate).
pub const min_initial_deposit: Int = 10_000_000

/// Minimum surviving position value in USDr units after a partial
/// redemption; below this the position must close fully.
pub const min_position_value: Int = 2_000_000

/// Hard cap on the protocol fee taken on reported yield: 20.00%.
/// Unlike the ADA vault's fee-on-assets model, sUSDr charges fee-on-yield
/// only: zero yield reported => zero fee, ever.
pub const max_yield_fee_bps: Int = 2000

/// sUSDr minted for a USDr deposit at the current exchange rate.
/// Bootstrap is exactly 1:1.
pub fn mint_shares(deposit: Int, total_shares: Int, total_assets: Int) -> Int {
  if total_shares == 0 {
    deposit
  } else {
    deposit * total_shares / total_assets
  }
}

/// USDr paid out for redeeming `shares` sUSDr.
pub fn redeem_value(shares: Int, total_shares: Int, total_assets: Int) -> Int {
  if shares >= total_shares {
    total_assets
  } else {
    shares * total_assets / total_shares
  }
}

/// Exchange rate scaled by 1e6: USDr units per 1e6 sUSDr units.
/// Starts at 1_000_000 (1:1) and increases as yield accrues.
pub fn exchange_rate_e6(total_shares: Int, total_assets: Int) -> Int {
  if total_shares == 0 {
    1_000_000
  } else {
    total_assets * 1_000_000 / total_shares
  }
}

/// Protocol fee in USDr units on a reported yield amount.
pub fn yield_fee(gross_yield: Int, fee_bps: Int) -> Int {
  gross_yield * fee_bps / 10_000
}

pub fn fee_bps_ok(fee_bps: Int) -> Bool {
  fee_bps >= 0 && fee_bps <= max_yield_fee_bps
}

/// Fee is settled by minting treasury shares (dilution), never by moving
/// assets out, exactly as the ADA vault does: solve
///   fee_assets = fee_shares * total_assets / (total_shares + fee_shares)
pub fn fee_shares_for(total_shares: Int, total_assets: Int, fee_assets: Int) -> Int {
  if fee_assets <= 0 || fee_assets >= total_assets {
    0
  } else {
    fee_assets * total_shares / ( total_assets - fee_assets )
  }
}

pub fn deposit_ok(deposit: Int, total_shares: Int, total_assets: Int) -> Bool {
  let minted = mint_shares(deposit, total_shares, total_assets)
  if total_shares == 0 {
    deposit >= min_initial_deposit
  } else {
    minted > 0
  }
}

/// A withdrawal is valid if it doesn't exceed the position and doesn't
/// strand a dust remainder below min_position_value.
pub fn withdraw_ok(
  shares: Int,
  position_shares: Int,
  total_shares: Int,
  total_assets: Int,
) -> Bool {
  if shares <= 0 || shares > position_shares {
    False
  } else if shares == position_shares {
    True
  } else {
    let remaining = position_shares - shares
    redeem_value(remaining, total_shares - shares, total_assets - redeem_value(shares, total_shares, total_assets)) >= min_position_value
  }
}

// ------------------------------------------------------------------ tests

test bootstrap_is_one_to_one() {
  mint_shares(10_000_000, 0, 0) == 10_000_000
}

test bootstrap_below_minimum_is_rejected() {
  !deposit_ok(9_999_999, 0, 0)
}

test rate_starts_at_par() {
  exchange_rate_e6(10_000_000, 10_000_000) == 1_000_000
}

test yield_raises_rate_without_minting() {
  // 100 USDr in, 8 USDr yield reported: rate becomes 1.08
  exchange_rate_e6(100_000_000, 108_000_000) == 1_080_000
}

test redeem_includes_accrued_yield() {
  // All shares redeem all assets, including yield
  redeem_value(100_000_000, 100_000_000, 108_000_000) == 108_000_000
}

test second_depositor_pays_the_accrued_rate() {
  // At rate 1.08, 108 USDr mints exactly 100 shares
  mint_shares(108_000_000, 100_000_000, 108_000_000) == 100_000_000
}

test minting_rounds_down_never_up() {
  // 107.999999 at rate 1.08 must floor
  mint_shares(107_999_999, 100_000_000, 108_000_000) == 99_999_999
}

test redemption_rounds_down_never_up() {
  redeem_value(1, 3, 10) == 3
}

test zero_yield_means_zero_fee() {
  yield_fee(0, 2000) == 0
}

test fee_cap_is_enforced() {
  fee_bps_ok(2000) && !fee_bps_ok(2001)
}

test fee_is_taken_on_yield_not_assets() {
  // 10 USDr yield at 10% fee = 1 USDr fee, regardless of pool size
  yield_fee(10_000_000, 1000) == 1_000_000
}

test fee_shares_redeem_to_the_fee_amount() {
  let shares = fee_shares_for(100_000_000, 110_000_000, 1_000_000)
  let redeemed = redeem_value(shares, 100_000_000 + shares, 110_000_000)
  // Within 1 unit of dust, in the protocol's favour
  redeemed <= 1_000_000 && redeemed >= 999_999
}

test cannot_redeem_more_than_position() {
  !withdraw_ok(11, 10, 100, 100)
}

test partial_redeem_stranding_dust_is_rejected() {
  // leaving 1 unit behind is below min_position_value
  !withdraw_ok(9_999_999, 10_000_000, 10_000_000, 10_000_000)
}

test full_close_is_always_allowed() {
  withdraw_ok(10, 10, 100, 100)
}
