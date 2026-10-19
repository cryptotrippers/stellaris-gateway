//// The Reserve State datums and committee rules, shared by `reserve.ak`,
//// `eligibility.ak` and the vault (which read the committee and the switches
//// from the genuine Config so that a reserve `Rotate` carries over to
//// eligibility issuance and the vault too).

use aiken/collection/list
use cardano/assets.{PolicyId}
use tessera/rules

/// The Reserve State is two UTxOs at the reserve address (Phase 2.5a), told
/// apart by their thread token (`reserve_threads.ak`) and by distinct datum
/// constructors, so a Config can never be read as a Supply or the reverse.
///
/// * Config: rarely changes (committee, switches). Exits, stakes and the
///   eligibility registry read it by reference, so it is not spent by every
///   TSRA mint or burn.
/// * Supply: the hot books. Spent by every mint, burn, attestation and cap
///   change.
///
/// PROVISIONAL until counsel answers (SPEC.md §1): the committee model, the
/// attestation format, any on-chain reserve asset and the KYC switches may
/// still change.
pub type ReserveDatum {
  ConfigDatum(ConfigState)
  SupplyDatum(SupplyState)
}

pub type ConfigState {
  operators: List<ByteArray>,
  threshold: Int,
  paused: Bool,
  /// Per-action eligibility switches (Phase 2.3). When on, the action calls
  /// `tessera/eligibility.eligible`. All off on Preprod.
  kyc_mint: Bool,
  kyc_redeem: Bool,
  /// Read by the sTessera vault; stored here so one committee transaction
  /// controls every switch.
  kyc_stake: Bool,
  /// Policy of the eligibility tokens (`validators/eligibility.ak` at launch).
  /// Set at genesis; `SetKyc` (committee) may repoint it, e.g. to a
  /// Midnight-issued credential policy, without a new reserve script.
  eligibility_policy: PolicyId,
  /// Monotonic replay counter for Config transitions.
  epoch: Int,
}

pub type SupplyState {
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
  /// Monotonic replay counter for Supply transitions.
  epoch: Int,
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
