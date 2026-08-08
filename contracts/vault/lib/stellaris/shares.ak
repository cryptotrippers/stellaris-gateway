//// Stellaris yield engine — pure share accounting (Stage 4, Step 2).
////
//// This module holds ONLY arithmetic. It has no access to the transaction,
//// signatures, or datums, so it can be reasoned about and tested in
//// isolation before it is wired into the validator (Step 3).
////
//// Model: share accrual. Depositors mint shares against the vault's accounted
//// assets; the issuer raises `total_assets` via `Accrue`, which lifts every
//// holder's redeemable value pro rata without touching share counts.
////
//// Rounding is ALWAYS floor in the protocol's favour: minted shares round
//// down, redeemed lovelace rounds down. The residue stays in the vault and
//// accrues to the remaining holders. Loss per action is bounded by 1 unit.
////
//// See contracts/vault/YIELD.md for the full specification.

/// Aggregate accounting carried by the single vault state UTxO.
pub type VaultAccounting {
  total_shares: Int,
  total_assets: Int,
}

/// Minimum first deposit, in lovelace. Blocks the classic share-price
/// inflation grief where the first depositor mints 1 share and then donates
/// a large amount to skew `assets / shares` against later depositors.
pub const min_initial_deposit: Int = 10_000_000

/// Minimum lovelace a position may hold after a partial redemption. Below
/// this a position cannot satisfy Cardano's min-ADA rule, so the redemption
/// must close the position entirely.
pub const min_position_value: Int = 2_000_000

/// Shares minted for a deposit of `deposit` lovelace.
///
/// Bootstrap case (`total_shares == 0`): shares are 1:1 with lovelace, which
/// fixes the initial share price at exactly 1.
pub fn mint_shares(acc: VaultAccounting, deposit: Int) -> Int {
  if deposit <= 0 {
    0
  } else if acc.total_shares <= 0 || acc.total_assets <= 0 {
    deposit
  } else {
    deposit * acc.total_shares / acc.total_assets
  }
}

/// Lovelace redeemable for `shares`, floored.
pub fn redeem_value(acc: VaultAccounting, shares: Int) -> Int {
  if shares <= 0 || acc.total_shares <= 0 {
    0
  } else if shares >= acc.total_shares {
    acc.total_assets
  } else {
    shares * acc.total_assets / acc.total_shares
  }
}

/// Accounting after a deposit that minted `minted` shares.
pub fn after_deposit(
  acc: VaultAccounting,
  deposit: Int,
  minted: Int,
) -> VaultAccounting {
  VaultAccounting {
    total_shares: acc.total_shares + minted,
    total_assets: acc.total_assets + deposit,
  }
}

/// Accounting after burning `shares` and paying out `paid` lovelace.
pub fn after_withdraw(
  acc: VaultAccounting,
  shares: Int,
  paid: Int,
) -> VaultAccounting {
  VaultAccounting {
    total_shares: acc.total_shares - shares,
    total_assets: acc.total_assets - paid,
  }
}

/// Accounting after the operators accrue `amount` lovelace of yield.
/// Share count is untouched — this is the only path that raises share price.
pub fn after_accrue(acc: VaultAccounting, amount: Int) -> VaultAccounting {
  VaultAccounting { ..acc, total_assets: acc.total_assets + amount }
}

/// Is this deposit acceptable? Rejects dust deposits that would mint zero
/// shares, and enforces the minimum bootstrap deposit.
pub fn deposit_ok(acc: VaultAccounting, deposit: Int) -> Bool {
  if acc.total_shares <= 0 {
    deposit >= min_initial_deposit
  } else {
    deposit > 0 && mint_shares(acc, deposit) > 0
  }
}

/// Is this redemption acceptable? A partial redemption must leave both a
/// non-zero share balance and a viable (min-ADA) remaining value.
pub fn withdraw_ok(
  acc: VaultAccounting,
  position_shares: Int,
  shares: Int,
) -> Bool {
  if shares <= 0 || shares > position_shares || position_shares > acc.total_shares {
    False
  } else if shares == position_shares {
    // Full close — always allowed.
    True
  } else {
    let remaining = position_shares - shares
    redeem_value(acc, shares) > 0 && redeem_value(acc, remaining) >= min_position_value
  }
}

/// Solvency check for a returned state output: claims can never exceed the
/// lovelace actually locked at the script address.
pub fn solvent(acc: VaultAccounting, locked_lovelace: Int) -> Bool {
  acc.total_assets >= 0 && acc.total_shares >= 0 && acc.total_assets <= locked_lovelace
}

// ------------------------------------------------------------------
// Tests — `aiken check`.
// ------------------------------------------------------------------

fn empty() -> VaultAccounting {
  VaultAccounting { total_shares: 0, total_assets: 0 }
}

test bootstrap_mints_one_to_one() {
  mint_shares(empty(), 10_000_000) == 10_000_000
}

test bootstrap_below_minimum_is_rejected() {
  !deposit_ok(empty(), 9_999_999) && deposit_ok(empty(), 10_000_000)
}

test share_price_is_one_after_bootstrap() {
  let acc = after_deposit(empty(), 10_000_000, 10_000_000)
  redeem_value(acc, 10_000_000) == 10_000_000
}

test accrue_raises_redeemable_value_without_minting() {
  let acc = after_accrue(
    VaultAccounting { total_shares: 10_000_000, total_assets: 10_000_000 },
    2_000_000,
  )
  acc.total_shares == 10_000_000 && redeem_value(acc, 10_000_000) == 12_000_000
}

test second_depositor_pays_the_accrued_price() {
  // Vault is at 1.2 lovelace/share; a 12 ADA deposit must mint 10 ADA of shares.
  let acc = VaultAccounting { total_shares: 10_000_000, total_assets: 12_000_000 }
  mint_shares(acc, 12_000_000) == 10_000_000
}

test accrual_is_split_pro_rata_between_two_holders() {
  // A deposits 10, B deposits 10 at price 1, then 4 accrues: each redeems 12.
  let a = after_deposit(empty(), 10_000_000, 10_000_000)
  let minted_b = mint_shares(a, 10_000_000)
  let ab = after_deposit(a, 10_000_000, minted_b)
  let grown = after_accrue(ab, 4_000_000)
  redeem_value(grown, 10_000_000) == 12_000_000 && redeem_value(grown, minted_b) == 12_000_000
}

test minting_rounds_down_never_up() {
  // 7 lovelace into a 3-share / 10-asset vault: floor(7*3/10) = 2, not 3.
  let acc = VaultAccounting { total_shares: 3, total_assets: 10 }
  mint_shares(acc, 7) == 2
}

test redemption_rounds_down_never_up() {
  let acc = VaultAccounting { total_shares: 3, total_assets: 10 }
  redeem_value(acc, 1) == 3
}

test rounding_dust_stays_in_the_vault() {
  // Redeeming 1 of 3 shares against 10 assets pays 3 and leaves 7 for 2 shares,
  // i.e. the remaining holders are never worse off per share.
  let acc = VaultAccounting { total_shares: 3, total_assets: 10 }
  let paid = redeem_value(acc, 1)
  let next = after_withdraw(acc, 1, paid)
  next.total_assets * acc.total_shares >= acc.total_assets * next.total_shares
}

test dust_deposit_minting_zero_shares_is_rejected() {
  // Vault price is 1000 lovelace/share; a 999 lovelace deposit mints nothing.
  let acc = VaultAccounting { total_shares: 1, total_assets: 1000 }
  !deposit_ok(acc, 999) && deposit_ok(acc, 1000)
}

test full_close_is_always_allowed() {
  let acc = VaultAccounting { total_shares: 10_000_000, total_assets: 10_000_000 }
  withdraw_ok(acc, 3_000_000, 3_000_000)
}

test partial_redeem_leaving_dust_position_is_rejected() {
  // Position worth 3 ADA redeeming 2.5 ADA would strand 0.5 ADA — below min-ADA.
  let acc = VaultAccounting { total_shares: 10_000_000, total_assets: 10_000_000 }
  !withdraw_ok(acc, 3_000_000, 2_500_000) && withdraw_ok(acc, 3_000_000, 1_000_000)
}

test cannot_redeem_more_than_the_position_holds() {
  let acc = VaultAccounting { total_shares: 10_000_000, total_assets: 10_000_000 }
  !withdraw_ok(acc, 3_000_000, 3_000_001)
}

test redeeming_all_shares_drains_exactly_all_assets() {
  let acc = VaultAccounting { total_shares: 7, total_assets: 10 }
  let next = after_withdraw(acc, 7, redeem_value(acc, 7))
  next.total_shares == 0 && next.total_assets == 0
}

test solvency_rejects_overstated_assets() {
  let acc = VaultAccounting { total_shares: 5, total_assets: 11 }
  !solvent(acc, 10) && solvent(acc, 11)
}

test deposit_then_immediate_withdraw_never_profits() {
  // Round-trip at the same price must return at most what was put in.
  let acc = VaultAccounting { total_shares: 10_000_000, total_assets: 12_000_000 }
  let minted = mint_shares(acc, 6_000_000)
  let next = after_deposit(acc, 6_000_000, minted)
  redeem_value(next, minted) <= 6_000_000
}
