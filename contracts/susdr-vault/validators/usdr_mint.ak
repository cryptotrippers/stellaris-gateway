//// USDr — the non-yielding, USD-pegged Cardano native asset that `susdr_vault`
//// wraps. This is the stablecoin's OWN minting policy, distinct from the
//// vault: USDr exists (and can be minted/burned) independently of any vault
//// ever being bootstrapped, exactly as real-world USDr is described in
//// DESIGN.md — a pre-existing asset that depositors lock, not something the
//// vault itself creates.
////
//// Mint: gated by an M-of-N admin committee, baked into the script as
//// parameters (`admins`, `threshold`) rather than read from a mutable
//// datum. Rotating the committee therefore means deploying a new policy
//// (bumping to a new `admins`/`threshold` pins a new policy id) — the same
//// "redeploy for a new instance" posture `vault.ak`'s `_version` parameter
//// uses, just at the parameter level instead of a counter, because a
//// minting policy has no state UTxO to carry a mutable committee the way
//// `susdr_vault`'s State datum does.
////
//// Burn: unrestricted. Destroying value needs no permission — whoever is
//// spending the USDr-bearing input as part of a burn transaction already had
//// to satisfy THAT UTxO's own spending conditions, so no additional check is
//// meaningful here.
////
//// What this policy deliberately does NOT do: verify off-chain reserves. No
//// UTxO chain can attest that real USD sits in a bank account backing a
//// mint. The trust model is exactly what a fiat-backed, custodially-issued
//// stablecoin's mint has to be — M of N named admins attest, by signing the
//// mint transaction, that USDr is being created 1:1 against real off-chain
//// backing. Auditing that attestation is an off-chain governance/reporting
//// problem, not something this script can solve, and this build (Preprod
//// only, per CLAUDE.md / NETWORK.md) makes no claim otherwise.

use aiken/collection/dict
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use realfi/committee.{committee_valid, threshold_met}

/// Fixed token name for every unit minted under this policy: "USDr".
pub const usdr_asset_name: ByteArray = #"55534472"

validator usdr_mint(admins: List<ByteArray>, threshold: Int) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let minted = assets.tokens(tx.mint, policy_id)
    let quantity = assets.quantity_of(tx.mint, policy_id, usdr_asset_name)

    // Exactly one token name may ever move under this policy, and it must be
    // the canonical USDr name — this also rejects a mint that rides a foreign
    // token name along in the same transaction.
    let single_token = dict.size(minted) == 1

    if quantity > 0 {
      committee_valid(admins, threshold) && threshold_met(
        admins,
        threshold,
        tx.extra_signatories,
      ) && single_token
    } else if quantity < 0 {
      single_token
    } else {
      // A zero delta under this policy is meaningless — reject rather than
      // let the policy be attached as a no-op.
      False
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests — `aiken check`.
// ------------------------------------------------------------------

const admin1: ByteArray = #"aa111111111111111111111111111111111111111111111111111111"

const admin2: ByteArray = #"bb222222222222222222222222222222222222222222222222222222"

const admin3: ByteArray = #"cc333333333333333333333333333333333333333333333333333333"

const mallory: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

const policy: PolicyId = #"11111111111111111111111111111111111111111111111111111111"

const other_asset: ByteArray = #"deadbeef"

fn tx_minting(signers: List<ByteArray>, mint: assets.Value) -> Transaction {
  Transaction { ..transaction.placeholder, extra_signatories: signers, mint: mint }
}

test mint_ok_with_full_admin_threshold() {
  let t =
    tx_minting(
      [admin1, admin2],
      assets.from_asset(policy, usdr_asset_name, 100_000_000),
    )
  usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test mint_fails_below_admin_threshold() {
  let t =
    tx_minting([admin1], assets.from_asset(policy, usdr_asset_name, 100_000_000))
  !usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test mint_fails_when_a_non_admin_signs_instead() {
  let t =
    tx_minting(
      [admin1, mallory],
      assets.from_asset(policy, usdr_asset_name, 100_000_000),
    )
  !usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test mint_rejects_a_zero_quantity() {
  let t =
    tx_minting([admin1, admin2], assets.from_asset(policy, usdr_asset_name, 0))
  !usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test mint_cannot_smuggle_a_foreign_token_name() {
  let t =
    tx_minting(
      [admin1, admin2],
      assets.merge(
        assets.from_asset(policy, usdr_asset_name, 100_000_000),
        assets.from_asset(policy, other_asset, 1),
      ),
    )
  !usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test mint_rejects_an_unsatisfiable_admin_set() {
  // Threshold higher than the admin count can never be met — the policy
  // must refuse to mint at all rather than silently requiring "everyone".
  let t =
    tx_minting(
      [admin1, admin2, admin3],
      assets.from_asset(policy, usdr_asset_name, 1),
    )
  !usdr_mint.mint([admin1, admin2, admin3], 4, Void, policy, t)
}

test burn_is_unrestricted() {
  let t = tx_minting([], assets.from_asset(policy, usdr_asset_name, -50_000_000))
  usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}

test burn_cannot_smuggle_a_foreign_token_name() {
  let t =
    tx_minting(
      [],
      assets.merge(
        assets.from_asset(policy, usdr_asset_name, -50_000_000),
        assets.from_asset(policy, other_asset, 1),
      ),
    )
  !usdr_mint.mint([admin1, admin2, admin3], 2, Void, policy, t)
}
