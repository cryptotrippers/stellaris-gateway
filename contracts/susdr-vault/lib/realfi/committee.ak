//// M-of-N committee authorization — shared by `susdr_vault` (the operator
//// committee that may Accrue/pause/rotate/set fee) and `usdr_mint` (the
//// admin committee that may mint USDr).
////
//// This is new code, not part of the verbatim `stellaris/shares` port: Aiken
//// cannot import a private helper defined inside one validator file from
//// another validator file, and `yield_vault.ak`'s `threshold_met` /
//// `operators_valid` were defined that way. Rather than hand-duplicate this
//// authorization logic across `susdr_vault.ak` and `usdr_mint.ak` — exactly
//// the "same rule written twice, drifts once" bug class CLAUDE.md and
//// AUDIT.md O-02 warn about for datum encoding — it is pulled out into this
//// tiny shared module and tested once here.

use aiken/collection/list

/// M-of-N: at least `threshold` DISTINCT members of `committee` signed.
pub fn threshold_met(
  committee: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signed =
    list.filter(list.unique(committee), fn(m) { list.has(signatories, m) })
  threshold >= 1 && list.length(signed) >= threshold
}

/// A committee is well-formed iff the threshold is achievable (1..=N) and
/// every member is distinct — a duplicated entry would let one signature
/// count twice toward the threshold.
pub fn committee_valid(committee: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(committee)
  threshold >= 1 && threshold <= n && list.length(list.unique(committee)) == n
}

// ------------------------------------------------------------------
// Tests — `aiken check`.
// ------------------------------------------------------------------

const op1: ByteArray = #"aa111111111111111111111111111111111111111111111111111111"

const op2: ByteArray = #"bb222222222222222222222222222222222222222222222222222222"

const op3: ByteArray = #"cc333333333333333333333333333333333333333333333333333333"

const mallory: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

test threshold_met_with_exact_quorum() {
  threshold_met([op1, op2, op3], 2, [op1, op2])
}

test threshold_met_fails_below_quorum() {
  !threshold_met([op1, op2, op3], 2, [op1])
}

test threshold_met_ignores_non_committee_signers() {
  !threshold_met([op1, op2, op3], 2, [op1, mallory])
}

test threshold_met_deduplicates_repeated_committee_entries() {
  // A duplicated committee entry must not let a single signature count twice.
  !threshold_met([op1, op1, op3], 2, [op1])
}

test threshold_of_zero_is_never_met() {
  !threshold_met([op1, op2], 0, [op1, op2])
}

test committee_valid_rejects_zero_threshold() {
  !committee_valid([op1, op2], 0)
}

test committee_valid_rejects_threshold_above_n() {
  !committee_valid([op1, op2], 3)
}

test committee_valid_rejects_duplicate_members() {
  !committee_valid([op1, op1], 1)
}

test committee_valid_accepts_a_sane_committee() {
  committee_valid([op1, op2, op3], 2)
}
