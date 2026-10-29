//// fraction_vault v2 — shared types and arithmetic (SPEC-v2.md §4).
////
//// Three scripts share these types:
////
////   * `offering_v2` — the single State UTxO of one offering, identified by
////     its one-shot thread token (AUDIT.md F-1);
////   * `pledge`      — one UTxO per investor commitment, marked by a pledge
////     token minted under the pledge script's own policy (AUDIT.md F-4);
////   * `fraction_v2` — the fraction token, minted and burned only in step
////     with the State's `outstanding` counter.
////
//// The State datum is split into three parts so each spend can compare the
//// parts that must not move with one equality:
////
////   * `Terms` — fixed at `Open`, never changes (invariant 6);
////   * `Book`  — the money counters (invariants 3, 4 and 5);
////   * the governed fields in `OfferingV2` itself (status, fee rate, period,
////     manifest root, committee), each moved only by its own redeemer.
////
//// All arithmetic is integer and floored. A rounding remainder always stays in
//// the State for the remaining holders.

use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, VerificationKey}
use cardano/assets.{PolicyId, Value}
use stellaris/units.{is_ada, min_rider_lovelace, unit_of}

/// Hard cap on the settlement fee: 5%, as in v1.
pub const max_fee_bps: Int = 500

/// Asset name of the pledge marker, under the pledge script's own policy.
pub const pledge_marker: ByteArray = "pledge"

/// Lifecycle (SPEC-v2.md §2). A move is legal only along the spec's arrows.
pub type Status {
  Raising
  Operating
  Refunding
  WindingDown
  Closed
}

/// Fixed at `Open`. Every spend must return these unchanged.
pub type Terms {
  /// Hard cap in fractions.
  total_fractions: Int,
  /// Fractions that must be settled for the raise to succeed.
  soft_cap: Int,
  /// Deposit units per fraction.
  price: Int,
  /// Last moment (POSIX ms) a pledge can be made.
  deadline: Int,
  /// Time after the deadline for settling outstanding pledges.
  settle_window: Int,
  /// Units that may never be released to the SPV (D-7 hold-back).
  retained: Int,
  /// Hash of the offering documents investors accepted.
  docs_hash: ByteArray,
  /// The only payment credential `Release` may pay.
  spv_payout: Credential,
  /// The only key hash `ClaimFee` may pay.
  treasury: ByteArray,
  /// Signs `Open` with the committee.
  issuer: ByteArray,
  /// May run `Settle` without the committee.
  keeper: ByteArray,
  /// The fraction token's minting policy (`fraction_v2` by default).
  fraction_policy: PolicyId,
  /// If set, a pledge settles only when its owner holds this token.
  eligibility_policy: Option<PolicyId>,
  /// The deposit unit. Must equal the script's own parameters.
  unit_policy: PolicyId,
  unit_name: ByteArray,
}

/// The money counters. Invariant 4: the State holds exactly
/// `escrowed - released + pool` deposit units.
pub type Book {
  /// Fractions minted by `Settle`, cumulative.
  settled: Int,
  /// Fractions in circulation.
  outstanding: Int,
  /// Units paid in by settled pledges, less fees claimed and refunds paid.
  /// Includes `fees` until they are claimed.
  escrowed: Int,
  /// Units released to the SPV so far.
  released: Int,
  /// Accrued platform fees, unclaimed (held inside `escrowed`).
  fees: Int,
  /// Units held for holders in `WindingDown`.
  pool: Int,
  /// `escrowed - fees` at `CloseRaise`; 0 before.
  net_proceeds: Int,
}

/// The single State UTxO of an offering.
pub type OfferingV2 {
  status: Status,
  terms: Terms,
  book: Book,
  /// Fee on settled proceeds. Moves only by `SetFees`, only while `Raising`.
  fee_bps: Int,
  /// Last committed distribution period.
  period: Int,
  /// Merkle root of the last committed period's payout manifest.
  manifest_root: ByteArray,
  /// Offering committee, M-of-N. Moves only by `Rotate`.
  committee: List<ByteArray>,
  threshold: Int,
}

/// One investor's commitment.
pub type PledgeDatum {
  /// Which offering: its State's thread-token policy (= offering script hash).
  offering: PolicyId,
  /// Refunds and fractions go only to this address. Key payment credential.
  owner: Address,
  /// Fractions pledged.
  qty: Int,
  /// Lower validity bound of the pledge transaction (checked at mint).
  created: Int,
}

// ------------------------------------------------------------------
// Arithmetic
// ------------------------------------------------------------------

/// Floored basis points of a non-negative amount.
pub fn bps_of(amount: Int, bps: Int) -> Int {
  if amount <= 0 || bps <= 0 {
    0
  } else {
    amount * bps / 10_000
  }
}

pub fn fee_bps_ok(bps: Int) -> Bool {
  bps >= 0 && bps <= max_fee_bps
}

/// Deposit units the State must hold for `book` (invariant 4).
pub fn accounted(book: Book) -> Int {
  book.escrowed - book.released + book.pool
}

/// Units the State may still release to the SPV.
pub fn release_room(book: Book, terms: Terms) -> Int {
  book.net_proceeds - terms.retained - book.released
}

/// Deposit units held in `value`. For an ADA unit the min-ADA rider is not
/// part of the balance, so it is subtracted.
pub fn units_in(value: Value, policy: PolicyId, name: ByteArray) -> Int {
  if is_ada(policy) {
    assets.lovelace_of(value) - min_rider_lovelace
  } else {
    unit_of(value, policy, name)
  }
}

/// Lovelace in `value` that is NOT deposit units (the rider), so it can be
/// returned to its owner.
pub fn rider_of(value: Value, policy: PolicyId) -> Int {
  if is_ada(policy) {
    min_rider_lovelace
  } else {
    assets.lovelace_of(value)
  }
}

/// Pro-rata share of `pool` for `qty` of `outstanding` fractions, floored.
pub fn pro_rata(pool: Int, qty: Int, outstanding: Int) -> Int {
  if pool <= 0 || qty <= 0 || outstanding <= 0 || qty > outstanding {
    0
  } else {
    pool * qty / outstanding
  }
}

// ------------------------------------------------------------------
// Well-formedness
// ------------------------------------------------------------------

/// M-of-N: at least `threshold` DISTINCT committee members signed.
pub fn threshold_met(
  committee: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signed =
    list.filter(list.unique(committee), fn(k) { list.has(signatories, k) })
  threshold >= 1 && list.length(signed) >= threshold
}

/// A committee list must be unique, non-empty and cover its threshold.
pub fn committee_ok(committee: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(committee)
  threshold >= 1 && threshold <= n && list.length(list.unique(committee)) == n
}

/// The fixed terms are internally consistent.
pub fn terms_ok(t: Terms) -> Bool {
  and {
    t.total_fractions > 0,
    t.soft_cap > 0,
    t.soft_cap <= t.total_fractions,
    t.price > 0,
    t.settle_window >= 0,
    t.retained >= 0,
    bytearray.length(t.docs_hash) == 32,
    bytearray.length(t.treasury) == 28,
    bytearray.length(t.fraction_policy) == 28,
  }
}

/// The counters never go negative or out of order, and the escrow always
/// covers what was released plus the unclaimed fees.
pub fn book_ok(b: Book, t: Terms) -> Bool {
  and {
    b.settled >= 0,
    b.settled <= t.total_fractions,
    b.outstanding >= 0,
    b.outstanding <= b.settled,
    b.fees >= 0,
    b.released >= 0,
    b.pool >= 0,
    b.escrowed - b.released - b.fees >= 0,
  }
}

/// The key hash behind a key address, if it is one.
pub fn key_of(a: Address) -> Option<ByteArray> {
  when a.payment_credential is {
    VerificationKey(k) -> Some(k)
    _ -> None
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

test bps_is_floored_and_zero_guarded() {
  bps_of(10_000_001, 100) == 100_000 && bps_of(0, 500) == 0 && bps_of(
    100,
    0,
  ) == 0
}

test fee_cap_is_five_percent() {
  fee_bps_ok(0) && fee_bps_ok(500) && !fee_bps_ok(501) && !fee_bps_ok(-1)
}

test pro_rata_floors_and_last_takes_all() {
  pro_rata(10, 1, 3) == 3 && pro_rata(7_777_777, 5, 5) == 7_777_777 && pro_rata(
    100,
    6,
    5,
  ) == 0
}

test threshold_counts_distinct_signers() {
  let c = [#"aa", #"bb", #"cc"]
  threshold_met(c, 2, [#"aa", #"bb"]) && !threshold_met(c, 2, [#"aa", #"aa"])
}

test committee_must_be_unique_and_cover_the_threshold() {
  committee_ok([#"aa", #"bb"], 2) && !committee_ok([#"aa", #"aa"], 2) && !committee_ok(
    [#"aa"],
    2,
  ) && !committee_ok([], 0)
}

test units_in_subtracts_the_rider_for_ada() {
  units_in(assets.from_lovelace(12_000_000), #"", #"") == 10_000_000
}
