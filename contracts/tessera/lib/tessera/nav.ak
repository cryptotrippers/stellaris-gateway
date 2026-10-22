//// The Tessera NAV: what the price of sTSRA and the reserve's health are, and
//// whether a reader may trust a published statement of them (Phase 2.7,
//// SPEC.md §7).
////
//// Pure functions, no transaction access:
//// * `derive` computes the `NavDatum` of SPEC §7.2 from the genuine States at a
////   time `lo`; `fold` is the vesting step the vault itself uses, so the price is
////   exactly what a stake or unstake at `lo` would use;
//// * `nav_usable` is the reader's check of rules 2-5 of SPEC §7.4 (rule 1, the
////   choice of the UTxO by its thread token, is the reader's selection logic);
//// * `strict_matches` is rule 6: the datum was derived from the State and Supply
////   epochs the reader sees.
////
//// The `nav` script (SPEC §7.8, D-44) is not built: a reader that does not use a
//// published NAV UTxO calls `derive` on the States it references and applies the
//// same rules. Third parties copy this module (Aiken libraries cannot be shared
//// across projects) together with its test vectors.

use aiken/collection/list
use tessera/exchange.{exchange_rate_e6}
use tessera/first_loss_state.{FirstLossState}
use tessera/loss_fixture.{config0, state0, supply0}
use tessera/reserve_state.{ConfigState, SupplyState}
use tessera/rules
use tessera/vault_state.{VaultState, fold}

pub const nav_version: Int = 1

/// A reader may accept a NAV at most this old (SPEC §7.4 rule 2); it can choose
/// shorter, never longer.
pub const nav_max_age_ms: Int = 86_400_000

/// Price of a share when a class has no shares: par, in TSRA micro-units.
pub const par_e6: Int = 1_000_000

pub type NavDatum {
  version: Int,
  short_price_e6: Int,
  long_price_e6: Int,
  short_assets: Int,
  short_shares: Int,
  long_assets: Int,
  long_shares: Int,
  ticket_escrow: Int,
  minted_supply: Int,
  attested_reserve: Int,
  mint_cap: Int,
  backing_bps: Int,
  first_loss_balance: Int,
  attested_at: Int,
  attestation_epoch: Int,
  loss_pending_until: Int,
  paused: Bool,
  vault_epoch: Int,
  supply_epoch: Int,
  published_at: Int,
}

/// `attested_reserve * 10_000 / minted_supply`; 0 when nothing is minted (no
/// TSRA exists, so there is nothing to price).
pub fn backing_bps(attested_reserve: Int, minted_supply: Int) -> Int {
  if minted_supply == 0 {
    0
  } else {
    attested_reserve * 10_000 / minted_supply
  }
}

/// The NAV at time `lo` from the genuine States (SPEC §7.2).
pub fn derive(
  vault: VaultState,
  supply: SupplyState,
  config: ConfigState,
  first_loss: FirstLossState,
  lo: Int,
) -> NavDatum {
  let v = fold(vault, lo)
  NavDatum {
    version: nav_version,
    short_price_e6: exchange_rate_e6(v.short_shares, v.short_assets),
    long_price_e6: exchange_rate_e6(v.long_shares, v.long_assets),
    short_assets: v.short_assets,
    short_shares: v.short_shares,
    long_assets: v.long_assets,
    long_shares: v.long_shares,
    ticket_escrow: v.ticket_escrow,
    minted_supply: supply.minted_supply,
    attested_reserve: supply.attested_reserve,
    mint_cap: supply.mint_cap,
    backing_bps: backing_bps(supply.attested_reserve, supply.minted_supply),
    first_loss_balance: first_loss.balance,
    attested_at: supply.attested_at,
    attestation_epoch: supply.attestation_epoch,
    loss_pending_until: config.loss_pending_until,
    paused: config.paused,
    vault_epoch: vault.epoch,
    supply_epoch: supply.epoch,
    published_at: lo,
  }
}

/// SPEC §7.4 rules 2-5, for a reader whose transaction has validity bounds
/// `lo`..`hi` and who has referenced the reserve Config (`config_loss_pending_until`).
///
/// * the datum is of a known version and was published already (`published_at <= lo`);
/// * rule 2: `hi - published_at <= max_age`, and `max_age` is at most the
///   24 h ceiling;
/// * rule 3: no freeze open at `lo`, in the datum or in the Config, and not paused;
/// * rule 4: the attestation was at most 7 days old when it was published.
///
/// Rule 5 (the haircut of TSRA's own value) is `haircut_bps`.
pub fn nav_usable(
  d: NavDatum,
  config_loss_pending_until: Int,
  lo: Int,
  hi: Int,
  max_age: Int,
) -> Bool {
  and {
    d.version == nav_version,
    max_age > 0,
    max_age <= nav_max_age_ms,
    d.published_at <= lo,
    hi - d.published_at <= max_age,
    d.loss_pending_until <= lo,
    config_loss_pending_until <= lo,
    !d.paused,
    d.published_at - d.attested_at <= rules.max_attestation_age,
  }
}

/// Rule 5: TSRA is worth at most par, and less when the attested reserve does
/// not cover the supply: `min(10_000, backing_bps)`.
pub fn haircut_bps(d: NavDatum) -> Int {
  if d.backing_bps < 10_000 {
    d.backing_bps
  } else {
    10_000
  }
}

/// `amount` TSRA at the haircut value, in TSRA units.
pub fn haircut_value(d: NavDatum, amount: Int) -> Int {
  amount * haircut_bps(d) / 10_000
}

/// `shares` sTSRA in TSRA units at the published short price (rounded down).
pub fn short_value(d: NavDatum, shares: Int) -> Int {
  shares * d.short_price_e6 / par_e6
}

/// Rule 6 (strict mode): the datum was derived from the State and Supply the
/// reader sees. If not, recompute with `derive`.
pub fn strict_matches(d: NavDatum, vault: VaultState, supply: SupplyState) -> Bool {
  d.vault_epoch == vault.epoch && d.supply_epoch == supply.epoch
}

// ------------------------------------------------------------------ tests

const day: Int = 86_400_000

const t0: Int = 1_000_000

fn fl() -> FirstLossState {
  FirstLossState { balance: 77_000_000, epoch: 2 }
}

fn calm_config() -> ConfigState {
  ConfigState { ..config0(), loss_pending_until: 0 }
}

fn vs_with(
  short_shares: Int,
  short_assets: Int,
  long_shares: Int,
  long_assets: Int,
) -> VaultState {
  VaultState {
    ..state0(),
    short_shares,
    short_assets,
    long_shares,
    long_assets,
    vest_short: 0,
    vest_long: 0,
  }
}

fn nav_at(lo: Int) -> NavDatum {
  derive(
    state0(),
    SupplyState { ..supply0(), attested_at: lo - day },
    calm_config(),
    fl(),
    lo,
  )
}

// -- prices

test a_class_at_par_prices_at_one() {
  let d = derive(vs_with(100, 100, 50, 50), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == 1_000_000 && d.long_price_e6 == 1_000_000
}

test earned_yield_lifts_the_price() {
  let d = derive(vs_with(100, 105, 400, 420), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == 1_050_000 && d.long_price_e6 == 1_050_000
}

test a_price_rounds_down() {
  let d = derive(vs_with(3, 4, 7, 8), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == 1_333_333 && d.long_price_e6 == 1_142_857
}

test a_class_with_no_shares_is_at_par() {
  let d = derive(vs_with(0, 0, 0, 0), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == par_e6 && d.long_price_e6 == par_e6
}

test a_dead_class_with_shares_outstanding_prices_at_zero() {
  let d = derive(vs_with(100, 0, 50, 0), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == 0 && d.long_price_e6 == 0
}

test a_price_below_par_after_a_loss() {
  let d = derive(vs_with(1_000, 600, 1_000, 900), supply0(), calm_config(), fl(), t0)
  d.short_price_e6 == 600_000 && d.long_price_e6 == 900_000
}

// -- vesting (state0: 40 short and 20 long units vest over 7 days from t0)

test nothing_has_vested_at_or_before_the_start() {
  let before = derive(state0(), supply0(), calm_config(), fl(), t0 - 1)
  let at = derive(state0(), supply0(), calm_config(), fl(), t0)
  before.short_assets == 1_000_000_000 && at.short_assets == 1_000_000_000 && before.short_price_e6 == 1_000_000 && at.long_assets == 2_000_000_000
}

test half_the_yield_has_vested_at_half_time() {
  let d = derive(state0(), supply0(), calm_config(), fl(), t0 + 7 * day / 2)
  d.short_assets == 1_020_000_000 && d.short_price_e6 == 1_020_000 && d.long_assets == 2_010_000_000 && d.long_price_e6 == 1_005_000
}

test all_the_yield_has_vested_at_and_after_the_end() {
  let at = derive(state0(), supply0(), calm_config(), fl(), t0 + 7 * day)
  let after = derive(state0(), supply0(), calm_config(), fl(), t0 + 100 * day)
  at.short_assets == 1_040_000_000 && at.short_price_e6 == 1_040_000 && at == NavDatum { ..after, published_at: at.published_at }
}

test the_price_never_falls_as_time_passes_through_vesting() {
  let a = derive(state0(), supply0(), calm_config(), fl(), t0 + day)
  let b = derive(state0(), supply0(), calm_config(), fl(), t0 + 2 * day)
  let c = derive(state0(), supply0(), calm_config(), fl(), t0 + 6 * day)
  a.short_price_e6 <= b.short_price_e6 && b.short_price_e6 <= c.short_price_e6
}

// -- the rest of the datum

test the_datum_carries_every_source_field() {
  let lo = t0 + 3 * day
  let s = supply0()
  let c = config0()
  let d = derive(state0(), s, c, fl(), lo)
  d == NavDatum {
    version: 1,
    short_price_e6: d.short_price_e6,
    long_price_e6: d.long_price_e6,
    short_assets: d.short_assets,
    short_shares: 1_000_000_000,
    long_assets: d.long_assets,
    long_shares: 2_000_000_000,
    ticket_escrow: 500_000_000,
    minted_supply: s.minted_supply,
    attested_reserve: s.attested_reserve,
    mint_cap: s.mint_cap,
    backing_bps: 10_000,
    first_loss_balance: 77_000_000,
    attested_at: s.attested_at,
    attestation_epoch: s.attestation_epoch,
    loss_pending_until: c.loss_pending_until,
    paused: c.paused,
    vault_epoch: 4,
    supply_epoch: 9,
    published_at: lo,
  }
}

test an_undercollateralised_supply_is_reported_as_it_is() {
  let sup = SupplyState { ..supply0(), attested_reserve: 9_000_000_000, minted_supply: 10_000_000_000, mint_cap: 12_345_000_000 }
  let d = derive(state0(), sup, calm_config(), fl(), t0)
  d.attested_reserve == 9_000_000_000 && d.minted_supply == 10_000_000_000 && d.mint_cap == 12_345_000_000 && d.backing_bps == 9_000 && haircut_bps(d) == 9_000
}

test published_at_is_the_lower_bound() {
  nav_at(5 * day).published_at == 5 * day && nav_at(6 * day).published_at == 6 * day
}

test paused_and_the_freeze_are_copied_from_the_config() {
  let c = ConfigState { ..calm_config(), paused: True, loss_pending_until: t0 + 9 }
  let d = derive(state0(), supply0(), c, fl(), t0)
  d.paused && d.loss_pending_until == t0 + 9
}

// -- backing

test nothing_minted_has_zero_backing() {
  backing_bps(5_000, 0) == 0 && backing_bps(0, 0) == 0
}

test backing_is_the_attested_reserve_over_the_supply() {
  backing_bps(10_000, 10_000) == 10_000 && backing_bps(9_999, 10_000) == 9_999 && backing_bps(15_000, 10_000) == 15_000 && backing_bps(1, 3) == 3_333 && backing_bps(0, 10_000) == 0
}

test the_haircut_never_exceeds_par() {
  let d = nav_at(t0 + day)
  let under = NavDatum { ..d, backing_bps: 9_999 }
  let at = NavDatum { ..d, backing_bps: 10_000 }
  let over = NavDatum { ..d, backing_bps: 15_000 }
  let none = NavDatum { ..d, backing_bps: 0 }
  haircut_bps(under) == 9_999 && haircut_bps(at) == 10_000 && haircut_bps(over) == 10_000 && haircut_bps(none) == 0
}

test the_haircut_value_rounds_down() {
  let d = NavDatum { ..nav_at(t0 + day), backing_bps: 9_000 }
  haircut_value(d, 1_000) == 900 && haircut_value(d, 1) == 0 && haircut_value(NavDatum { ..d, backing_bps: 12_000 }, 1_000) == 1_000
}

test sttsra_value_uses_the_published_price() {
  let d = NavDatum { ..nav_at(t0 + day), short_price_e6: 1_050_000 }
  short_value(d, 1_000_000) == 1_050_000 && short_value(d, 3) == 3 && short_value(d, 0) == 0
}

// -- nav_usable: rules 2-5 at their boundaries

fn usable(d: NavDatum, cfg_freeze: Int, lo: Int, hi: Int, max_age: Int) -> Bool {
  nav_usable(d, cfg_freeze, lo, hi, max_age)
}

fn fresh() -> NavDatum {
  nav_at(10 * day)
}

test a_fresh_nav_is_usable() {
  usable(fresh(), 0, 10 * day + 1_000, 10 * day + 2_000, nav_max_age_ms)
}

test rule_2_age_is_checked_against_the_upper_bound_at_exactly_24_hours() {
  let d = fresh()
  usable(d, 0, 11 * day, 11 * day, nav_max_age_ms) && !usable(d, 0, 11 * day, 11 * day + 1, nav_max_age_ms)
}

test a_reader_may_ask_for_a_shorter_age_but_never_a_longer_one() {
  let d = fresh()
  usable(d, 0, 10 * day, 10 * day + 3_600_000, 3_600_000) && !usable(d, 0, 10 * day, 10 * day + 3_600_001, 3_600_000) && !usable(
    d,
    0,
    10 * day,
    10 * day,
    nav_max_age_ms + 1,
  ) && !usable(d, 0, 10 * day, 10 * day, 0) && !usable(d, 0, 10 * day, 10 * day, -1)
}

test a_nav_from_the_future_is_not_usable() {
  let d = fresh()
  usable(d, 0, 10 * day, 10 * day, nav_max_age_ms) && !usable(d, 0, 10 * day - 1, 10 * day, nav_max_age_ms)
}

test rule_3_a_freeze_in_the_datum_blocks_until_it_ends() {
  let d = NavDatum { ..fresh(), loss_pending_until: 10 * day + 500 }
  !usable(d, 0, 10 * day + 499, 10 * day + 600, nav_max_age_ms) && usable(d, 0, 10 * day + 500, 10 * day + 600, nav_max_age_ms)
}

test rule_3_a_freeze_in_the_config_blocks_even_if_the_datum_is_calm() {
  let d = fresh()
  !usable(d, 10 * day + 500, 10 * day + 499, 10 * day + 600, nav_max_age_ms) && usable(d, 10 * day + 500, 10 * day + 500, 10 * day + 600, nav_max_age_ms)
}

test rule_3_a_paused_reserve_blocks() {
  let d = NavDatum { ..fresh(), paused: True }
  !usable(d, 0, 10 * day, 10 * day, nav_max_age_ms)
}

test rule_4_the_attestation_may_be_exactly_seven_days_old_at_publication() {
  let d = fresh()
  let ok = NavDatum { ..d, attested_at: d.published_at - 7 * day }
  let old = NavDatum { ..d, attested_at: d.published_at - 7 * day - 1 }
  usable(ok, 0, 10 * day, 10 * day, nav_max_age_ms) && !usable(old, 0, 10 * day, 10 * day, nav_max_age_ms)
}

test rule_4_counts_the_attestation_age_at_publication_not_at_reading() {
  // attested exactly seven days before it was published, read an hour later
  let d = fresh()
  let ok = NavDatum { ..d, attested_at: d.published_at - 7 * day }
  usable(ok, 0, 10 * day + 3_600_000, 10 * day + 3_600_000, nav_max_age_ms)
}

test an_unknown_version_is_not_usable() {
  !usable(NavDatum { ..fresh(), version: 2 }, 0, 10 * day, 10 * day, nav_max_age_ms) && !usable(
    NavDatum { ..fresh(), version: 0 },
    0,
    10 * day,
    10 * day,
    nav_max_age_ms,
  )
}

test every_rule_is_independent() {
  // each failing alone, everything else fine
  let d = fresh()
  let lo = 10 * day
  let hi = 10 * day + 1_000
  usable(d, 0, lo, hi, nav_max_age_ms) && !usable(
    NavDatum { ..d, paused: True },
    0,
    lo,
    hi,
    nav_max_age_ms,
  ) && !usable(NavDatum { ..d, loss_pending_until: hi }, 0, lo, hi, nav_max_age_ms) && !usable(
    d,
    hi,
    lo,
    hi,
    nav_max_age_ms,
  ) && !usable(NavDatum { ..d, attested_at: 0 }, 0, lo, hi, nav_max_age_ms)
}

// -- rule 6

test strict_mode_compares_both_epochs() {
  let d = nav_at(t0 + day)
  strict_matches(d, state0(), supply0()) && !strict_matches(d, VaultState { ..state0(), epoch: 5 }, supply0()) && !strict_matches(
    d,
    state0(),
    SupplyState { ..supply0(), epoch: 10 },
  )
}

// -- a deterministic spread against the vault's own exchange rate

fn spread(i: Int) -> Int {
  1_000 + i * 2_654_435_761 % 9_000_000_000
}

test the_published_price_is_the_exchange_rate_over_a_spread() {
  list.all(
    list.range(1, 40),
    fn(i) {
      let sh = spread(i)
      let a = spread(i + 100)
      let d = derive(vs_with(sh, a, sh + 7, a + 3), supply0(), calm_config(), fl(), t0)
      d.short_price_e6 == a * 1_000_000 / sh && d.long_price_e6 == (a + 3) * 1_000_000 / (sh + 7) && short_value(d, sh) <= a
    },
  )
}
