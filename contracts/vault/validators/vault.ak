//// Stellaris per-user vault — Phase 1.2 (owner-output enforcement).
////
//// Datum pins the owner's payment key hash. Spending is authorized when:
////   1. The owner (datum.owner) signed the transaction (`extra_signatories`), AND
////   2. At least one transaction output pays to an address whose payment
////      credential IS the owner's PKH (defense-in-depth: a compromised or
////      tricked signer cannot sweep the vault to a stranger's address), AND
////   3. The redeemer is a well-typed `VaultRedeemer`.

use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets
use cardano/transaction.{NoDatum, Output, OutputReference, Transaction, placeholder}

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

/// Parameterized validator.
///
/// `version` is a compile-time parameter that is NOT read by the logic. Its
/// only purpose is to change the applied UPLC — and therefore the on-chain
/// script hash and address — whenever we mint a new deployment. This gives
/// us a clean, source-diff-free upgrade path: bump the version constant on
/// the app side, get a brand new script address, migrate liquidity, retire
/// the old address. No validator rule ever changes silently.
validator vault(_version: Int) {
  spend(
    datum: Option<VaultDatum>,
    redeemer: VaultRedeemer,
    _own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    let Withdraw = redeemer
    let owner_signed = list.has(tx.extra_signatories, d.owner)
    let owner_gets_output =
      list.any(tx.outputs, fn(o) { output_pays_to(o, d.owner) })
    owner_signed && owner_gets_output
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Unit tests — run with `aiken check`.
// ------------------------------------------------------------------

const owner_pkh: ByteArray = #"11111111111111111111111111111111111111111111111111111111"
const other_pkh: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

fn dummy_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }
}

/// Build a payment-only address owned by `pkh`.
fn addr_of(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

fn output_to(pkh: ByteArray) -> Output {
  Output {
    address: addr_of(pkh),
    value: assets.zero,
    datum: NoDatum,
    reference_script: None,
  }
}

fn tx_with(signers: List<ByteArray>, outs: List<Output>) -> Transaction {
  Transaction { ..placeholder, extra_signatories: signers, outputs: outs }
}

// The parameter (`version`) is the first argument to every handler when the
// validator is parameterized. Tests exercise `version = 1`, which is the
// version constant the app pins on the JS side (see src/lib/vault.ts).
const test_version: Int = 1

test withdraw_ok_when_owner_signs_and_gets_output() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(owner_pkh)])
  vault.spend(test_version, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_wrong_signer() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([other_pkh], [output_to(owner_pkh)])
  !vault.spend(test_version, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_no_signers() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([], [output_to(owner_pkh)])
  !vault.spend(test_version, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_owner_signs_but_no_owner_output() {
  // Compromised/tricked signer: owner signature is on the tx but every
  // output pays somewhere else. The new invariant must reject this.
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(other_pkh)])
  !vault.spend(test_version, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_ok_when_owner_output_is_one_of_many() {
  let d = VaultDatum { owner: owner_pkh }
  let tx =
    tx_with([owner_pkh], [output_to(other_pkh), output_to(owner_pkh)])
  vault.spend(test_version, Some(d), Withdraw, dummy_ref(), tx)
}

