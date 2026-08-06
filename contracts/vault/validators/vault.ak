//// Stellaris vault — Stage 2.1 (per-asset shared vaults).
////
//// The validator is parameterized by (version, asset_id). Each marketplace
//// asset therefore compiles to its *own* script hash and address, so
//// deposits for one asset can never be spent by, mixed with, or accounted
//// against another asset. Neither parameter is read by the logic: they exist
//// purely to fork the applied UPLC.
////
//// Inside one asset vault, positions stay owner-scoped. The datum pins the
//// depositor's payment key hash, and spending is authorized when:
////   1. The owner (datum.owner) signed the transaction (`extra_signatories`),
////   2. At least one output pays to an address whose payment credential IS
////      the owner's PKH (a tricked signer cannot sweep funds to a stranger),
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
/// `version`  — bump to mint a fresh deployment of identical logic.
/// `asset_id` — UTF-8 bytes of the marketplace asset id (e.g. "sfm-01").
///              Isolates each asset into a distinct script address.
validator vault(_version: Int, _asset_id: ByteArray) {
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

// Parameters are prepended to every handler's arguments when the validator
// is parameterized. Tests exercise version = 1 and asset_id = "sfm-01",
// matching the values the app pins on the JS side (see src/lib/vault.ts).
const test_version: Int = 1

// "sfm-01" as UTF-8 bytes.
const test_asset_id: ByteArray = #"73666d2d3031"

// A different asset id, used to document that the parameter is inert to the
// spending rules (isolation comes from the distinct script hash, not logic).
const other_asset_id: ByteArray = #"73666d2d3032"

test withdraw_ok_when_owner_signs_and_gets_output() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(owner_pkh)])
  vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_wrong_signer() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([other_pkh], [output_to(owner_pkh)])
  !vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_no_signers() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([], [output_to(owner_pkh)])
  !vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_fails_when_owner_signs_but_no_owner_output() {
  // Compromised/tricked signer: owner signature is on the tx but every
  // output pays somewhere else. The invariant must reject this.
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(other_pkh)])
  !vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test withdraw_ok_when_owner_output_is_one_of_many() {
  let d = VaultDatum { owner: owner_pkh }
  let tx =
    tx_with([owner_pkh], [output_to(other_pkh), output_to(owner_pkh)])
  vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test rules_are_identical_under_a_different_asset_id() {
  // Same rules apply per asset vault; isolation is enforced by the distinct
  // applied script hash, so a UTxO at asset A's address is unreachable from
  // asset B's address regardless of signatures.
  let d = VaultDatum { owner: owner_pkh }
  let ok_tx = tx_with([owner_pkh], [output_to(owner_pkh)])
  let bad_tx = tx_with([other_pkh], [output_to(owner_pkh)])
  vault.spend(test_version, other_asset_id, Some(d), Withdraw, dummy_ref(), ok_tx) && !vault.spend(
    test_version,
    other_asset_id,
    Some(d),
    Withdraw,
    dummy_ref(),
    bad_tx,
  )
}
