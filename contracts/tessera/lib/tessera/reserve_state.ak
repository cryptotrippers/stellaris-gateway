//// The Reserve State datum and committee rules, shared by `reserve.ak` and
//// `eligibility.ak` (which reads the committee from the genuine Reserve State
//// so that a reserve `Rotate` carries over to eligibility issuance too).

use aiken/collection/list
use cardano/assets.{PolicyId}
use tessera/rules

/// PROVISIONAL until counsel answers (SPEC.md §1): the committee model, the
/// attestation format, any on-chain reserve asset and the KYC switches may
/// still change.
pub type ReserveState {
  /// TSRA currently in existence (1e-6 TSRA units).
  minted_supply: Int,
  /// Reserve the committee last attested to, in the same units.
  attested_reserve: Int,
  /// Committee-set ceiling on `minted_supply`, at most `rules.max_mint_cap`.
  mint_cap: Int,
  /// Number of attestations recorded so far (0 at genesis).
  attestation_epoch: Int,
  /// POSIX ms of the last attestation (genesis: the bootstrap tx's lower bound).
  attested_at: Int,
  /// Monotonic replay counter: exactly one State transition per tx.
  epoch: Int,
  operators: List<ByteArray>,
  threshold: Int,
  paused: Bool,
  /// Per-action eligibility switches (Phase 2.3). When on, the action calls
  /// `tessera/eligibility.eligible`. All off on Preprod.
  kyc_mint: Bool,
  kyc_redeem: Bool,
  /// Read by the sTessera vault (not written yet); stored here so one
  /// committee transaction controls every switch.
  kyc_stake: Bool,
  /// Policy of the eligibility tokens (`validators/eligibility.ak`). Fixed at
  /// genesis: `SetKyc` changes only the three switches.
  eligibility_policy: PolicyId,
}

/// At least `threshold` distinct members of `operators` signed the tx.
pub fn threshold_met(
  operators: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signers =
    operators
      |> list.filter(fn(op) { list.has(signatories, op) })
      |> list.unique
  list.length(signers) >= threshold
}

/// A usable committee: no duplicate keys, and `rules.min_threshold <=
/// threshold <= size` (so it is never empty and never a single key).
pub fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  threshold >= rules.min_threshold && threshold <= n && list.length(
    list.unique(operators),
  ) == n
}
