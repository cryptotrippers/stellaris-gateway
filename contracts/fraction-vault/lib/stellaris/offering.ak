//// Stellaris fraction offering — shared types and arithmetic.
////
//// A fraction offering is the on-chain record of one real-world asset that
//// has been split into a fixed number of equal, transferable fractions.
//// Unlike the retired yield vault there are no per-depositor UTxOs: ownership
//// IS the fraction token, held in the owner's own wallet, transferable
//// without touching this contract. The script holds exactly ONE UTxO — the
//// offering state — plus the units paid in for the fractions and any income
//// distributed against them.
////
//// All arithmetic here is integer and floored, and every rounding remainder
//// is left INSIDE the pool, i.e. it accrues to the remaining holders rather
//// than to the person redeeming. Nothing here can create value.

use aiken/collection/list

/// Hard cap on either fee rate. 5% each, and only a committee can move them.
pub const max_fee_bps: Int = 500

/// Lifecycle of an offering.
pub type Status {
  /// Fractions can be bought. No redemption.
  Open
  /// No buying, no redemption — the asset is funded and running.
  Closed
  /// The asset is being wound up or income is being paid out: holders may
  /// burn fractions for their pro-rata slice of the pool.
  Redeeming
}

/// The single state UTxO of an offering.
pub type OfferingDatum {
  Offering {
    /// Fractions that may ever exist. Immutable.
    total_fractions: Int,
    /// Fractions minted so far, cumulative. Never decreases.
    minted: Int,
    /// Fractions currently in circulation (minted minus burned).
    outstanding: Int,
    /// Price of one fraction, in base units of the deposit denomination.
    price: Int,
    /// Units held for holders: buy proceeds plus distributed income, less
    /// what redemption has already paid out.
    pool: Int,
    /// Units owed to the treasury and not yet claimed.
    fees: Int,
    /// Issuer key hash — the party that lists and funds the asset.
    issuer: ByteArray,
    /// Treasury key hash — the only address `ClaimFee` may pay.
    treasury: ByteArray,
    /// Committee that can move status and fees.
    operators: List<ByteArray>,
    /// M of N.
    threshold: Int,
    status: Status,
    /// Fee taken on a purchase, in basis points of the purchase cost.
    mint_fee_bps: Int,
    /// Fee taken on a redemption, in basis points of the gross payout.
    redeem_fee_bps: Int,
    /// Minting policy of the fraction token. Bound to this script.
    fraction_policy: ByteArray,
  }
}

/// Is a fee rate inside the hard cap?
pub fn fee_bps_ok(bps: Int) -> Bool {
  bps >= 0 && bps <= max_fee_bps
}

/// Floored basis points of a non-negative amount. Zero-guarded both ways.
pub fn bps_of(amount: Int, bps: Int) -> Int {
  if amount <= 0 || bps <= 0 {
    0
  } else {
    amount * bps / 10_000
  }
}

/// Cost of `qty` fractions at `price` each.
pub fn buy_cost(price: Int, qty: Int) -> Int {
  if price <= 0 || qty <= 0 {
    0
  } else {
    price * qty
  }
}

/// Gross pro-rata claim of `qty` fractions on `pool`, floored.
pub fn redeem_gross(pool: Int, qty: Int, outstanding: Int) -> Int {
  if pool <= 0 || qty <= 0 || outstanding <= 0 || qty > outstanding {
    0
  } else {
    pool * qty / outstanding
  }
}

/// Structural sanity of an offering's counters.
pub fn supply_ok(
  total_fractions: Int,
  minted: Int,
  outstanding: Int,
  pool: Int,
  fees: Int,
  price: Int,
) -> Bool {
  total_fractions > 0 && minted >= 0 && minted <= total_fractions && outstanding >= 0 && outstanding <= minted && pool >= 0 && fees >= 0 && price > 0
}

/// M-of-N: at least `threshold` DISTINCT committee members signed.
pub fn threshold_met(
  operators: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signed =
    list.filter(list.unique(operators), fn(op) { list.has(signatories, op) })
  threshold >= 1 && list.length(signed) >= threshold
}

/// The committee list itself must be well formed.
pub fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  threshold >= 1 && threshold <= n && list.length(list.unique(operators)) == n
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

test fee_cap_is_five_percent() {
  fee_bps_ok(0) && fee_bps_ok(500) && !fee_bps_ok(501) && !fee_bps_ok(-1)
}

test bps_is_floored() {
  bps_of(10_000_001, 100) == 100_000
}

test bps_of_zero_rate_charges_nothing() {
  bps_of(1_000_000, 0) == 0
}

test bps_of_non_positive_amount_is_zero() {
  bps_of(0, 500) == 0 && bps_of(-5, 500) == 0
}

test buy_cost_multiplies() {
  buy_cost(25_000_000, 4) == 100_000_000
}

test buy_cost_guards_non_positive() {
  buy_cost(0, 4) == 0 && buy_cost(25_000_000, 0) == 0
}

test redeem_is_pro_rata() {
  // 100 ADA pool, 200 fractions out, redeem 50 -> 25 ADA.
  redeem_gross(100_000_000, 50, 200) == 25_000_000
}

test redeem_rounding_stays_with_remaining_holders() {
  // 10 units across 3 fractions: redeeming 1 pays 3, not 3.33.
  redeem_gross(10, 1, 3) == 3
}

test redeem_of_the_last_fraction_takes_the_whole_pool() {
  redeem_gross(7_777_777, 5, 5) == 7_777_777
}

test redeem_more_than_outstanding_pays_nothing() {
  redeem_gross(100, 6, 5) == 0
}

test supply_ok_accepts_a_fresh_offering() {
  supply_ok(1_000, 0, 0, 0, 0, 25_000_000)
}

test supply_ok_rejects_overminting() {
  !supply_ok(1_000, 1_001, 0, 0, 0, 25_000_000)
}

test supply_ok_rejects_outstanding_above_minted() {
  !supply_ok(1_000, 10, 11, 0, 0, 25_000_000)
}

test supply_ok_rejects_zero_price() {
  !supply_ok(1_000, 0, 0, 0, 0, 0)
}

test threshold_counts_distinct_signers() {
  let ops = [#"aa", #"bb", #"cc"]
  threshold_met(ops, 2, [#"aa", #"bb"]) && !threshold_met(ops, 2, [#"aa", #"aa"])
}

test operators_must_be_unique_and_cover_the_threshold() {
  operators_valid([#"aa", #"bb"], 2) && !operators_valid([#"aa", #"aa"], 2) && !operators_valid(
    [#"aa"],
    2,
  )
}
