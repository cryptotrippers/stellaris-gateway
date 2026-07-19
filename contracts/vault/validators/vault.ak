//// Stellaris per-user vault — Phase 1.2 (owner-output enforcement).
////
//// Datum pins the owner's payment key hash. Spending is authorized when:
////   1. The owner (datum.owner) signed the transaction (`extra_signatories`), AND
////   2. At least one transaction output pays to an address whose payment
////      credential IS the owner's PKH (defense-in-depth: a compromised or
////      tricked signer cannot sweep the vault to a stranger's address), AND
////   3. The redeemer is a well-typed `VaultRedeemer`.

use aiken/collection/list
use cardano/address.{VerificationKey}
use cardano/transaction.{Output, OutputReference, Transaction}

pub type VaultDatum {
  owner: ByteArray,
}

/// Typed redeemer. `Withdraw` is the only current action; adding variants
/// later gives us a clean upgrade path without changing the type signature.
pub type VaultRedeemer {
  Withdraw
}

/// True iff `output` pays to an address whose payment credential is `pkh`.
fn output_pays_to(output: Output, pkh: ByteArray) -> Bool {
  when output.address.payment_credential is {
    VerificationKey(k) -> k == pkh
    _ -> False
  }
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
      Withdraw -> {
        let owner_signed = list.has(tx.extra_signatories, d.owner)
        let owner_gets_output =
          list.any(tx.outputs, fn(o) { output_pays_to(o, d.owner) })
        owner_signed && owner_gets_output
      }
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
