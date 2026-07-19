//// Stellaris per-user vault — Phase 1.1 (hardened).
////
//// Datum pins the owner's payment key hash. Spending is authorized when:
////   1. The owner (datum.owner) signed the transaction (`extra_signatories`), AND
////   2. The redeemer is a well-typed `VaultRedeemer` — future variants
////      (e.g. `Upgrade`) can gate different logic without breaking old UTxOs.
////
//// Defense-in-depth: this validator only guards spend authorization. It does
//// NOT enforce that value returns to the owner — a signed owner is trusted to
//// direct their own funds. The value-preservation invariant lives in the
//// Phase-2 shared asset vault, where the signer is not the value owner.

use aiken/collection/list
use cardano/transaction.{OutputReference, Transaction}

pub type VaultDatum {
  owner: ByteArray,
}

/// Typed redeemer. `Withdraw` is the only current action; adding variants
/// later gives us a clean upgrade path without changing the type signature.
pub type VaultRedeemer {
  Withdraw
}

validator vault {
  spend(
    datum: Option<VaultDatum>,
    redeemer: VaultRedeemer,
    _own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Withdraw -> list.has(tx.extra_signatories, d.owner)
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Unit tests — run with `aiken check`.
// ------------------------------------------------------------------

use cardano/address.{Address, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, placeholder,
}

const owner_pkh: ByteArray = #"11111111111111111111111111111111111111111111111111111111"
const other_pkh: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

fn dummy_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }
}

fn tx_signed_by(signers: List<ByteArray>) -> Transaction {
  Transaction { ..placeholder, extra_signatories: signers }
}

test withdraw_ok_when_owner_signs() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_signed_by([owner_pkh])
  vault.spend(Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_wrong_signer() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_signed_by([other_pkh])
  !vault.spend(Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_no_signers() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_signed_by([])
  !vault.spend(Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_ok_when_owner_among_many_signers() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_signed_by([other_pkh, owner_pkh, #"3333"])
  vault.spend(Some(d), Withdraw, dummy_ref(), tx)
}
