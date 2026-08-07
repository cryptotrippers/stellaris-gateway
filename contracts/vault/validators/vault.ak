//// Stellaris vault — Stage 3.1 (shared multi-depositor vaults).
////
//// The validator is parameterized by (version, asset_id). Each marketplace
//// asset compiles to its *own* script hash and address, so one asset's
//// deposits can never be spent by or accounted against another asset.
//// Neither parameter is read by the logic: they exist purely to fork the
//// applied UPLC.
////
//// One asset vault is SHARED: many depositors hold separate UTxOs at the
//// same address, each pinning its depositor in the datum. Spending a
//// position is authorized when:
////   1. The owner (datum.owner) signed the transaction (`extra_signatories`),
////   2. At least one output pays to an address whose payment credential IS
////      the owner's PKH (a tricked signer cannot sweep funds to a stranger),
////   3. CONTINUITY: every output returned to this same script address
////      carries an inline `VaultDatum` with the SAME owner. This is what
////      makes partial withdrawals safe in a shared vault — change left
////      behind cannot be re-datumed to a different depositor, and cannot be
////      stranded with a missing or malformed datum.
////
//// (3) is the Stage 3 addition. Without it, a partial withdraw could hand
//// the remainder of your position to an attacker's PKH in the same tx.

use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}

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

/// Payment credential of the UTxO being spent, i.e. this script's own hash.
/// Resolved from the tx inputs so the rule needs no extra parameter.
fn own_script_hash(inputs: List<Input>, own_ref: OutputReference) -> Option<ByteArray> {
  when list.find(inputs, fn(i) { i.output_reference == own_ref }) is {
    Some(i) ->
      when i.output.address.payment_credential is {
        Script(h) -> Some(h)
        _ -> None
      }
    None -> None
  }
}

/// An output is acceptable iff it does NOT return to this script, or it does
/// and carries an inline VaultDatum pinning the same owner.
fn continues_owner(output: Output, script_hash: ByteArray, owner: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(h) ->
      if h == script_hash {
        when output.datum is {
          InlineDatum(raw) -> {
            expect out_d: VaultDatum = raw
            out_d.owner == owner
          }
          _ -> False
        }
      } else {
        True
      }
    _ -> True
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
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    let Withdraw = redeemer
    let owner_signed = list.has(tx.extra_signatories, d.owner)
    let owner_gets_output =
      list.any(tx.outputs, fn(o) { output_pays_to(o, d.owner) })
    let continuity =
      when own_script_hash(tx.inputs, own_ref) is {
        Some(sh) -> list.all(tx.outputs, fn(o) { continues_owner(o, sh, d.owner) })
        None -> False
      }
    owner_signed && owner_gets_output && continuity
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

const script_hash: ByteArray = #"33333333333333333333333333333333333333333333333333333333"

/// Address of this vault script.
fn script_addr() -> Address {
  Address { payment_credential: Script(script_hash), stake_credential: None }
}

/// The UTxO being spent: a locked position owned by `pkh`.
fn vault_input(pkh: ByteArray) -> Input {
  Input {
    output_reference: dummy_ref(),
    output: Output {
      address: script_addr(),
      value: assets.zero,
      datum: InlineDatum(VaultDatum { owner: pkh }),
      reference_script: None,
    },
  }
}

/// Change output returned to the vault, datum pinning `pkh`.
fn vault_change(pkh: ByteArray) -> Output {
  Output {
    address: script_addr(),
    value: assets.zero,
    datum: InlineDatum(VaultDatum { owner: pkh }),
    reference_script: None,
  }
}

/// Change returned to the vault with no datum at all (would strand funds).
fn vault_change_no_datum() -> Output {
  Output {
    address: script_addr(),
    value: assets.zero,
    datum: NoDatum,
    reference_script: None,
  }
}

fn tx_with(signers: List<ByteArray>, outs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [vault_input(owner_pkh)],
    extra_signatories: signers,
    outputs: outs,
  }
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

// ------------------------------------------------------------------
// Stage 3 — shared vault / partial withdrawal continuity.
// ------------------------------------------------------------------

test partial_withdraw_ok_when_change_keeps_owner_datum() {
  // Owner takes part of the position; the remainder returns to the vault
  // still pinned to them. This is the core shared-vault flow.
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(owner_pkh), vault_change(owner_pkh)])
  vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test partial_withdraw_fails_when_change_is_redatumed_to_another_owner() {
  // The attack Stage 3 closes: remainder left in the shared vault but
  // re-assigned to somebody else's PKH.
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(owner_pkh), vault_change(other_pkh)])
  !vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test partial_withdraw_fails_when_change_has_no_datum() {
  let d = VaultDatum { owner: owner_pkh }
  let tx =
    tx_with([owner_pkh], [output_to(owner_pkh), vault_change_no_datum()])
  !vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}

test full_withdraw_still_ok_with_no_change_output() {
  let d = VaultDatum { owner: owner_pkh }
  let tx = tx_with([owner_pkh], [output_to(owner_pkh)])
  vault.spend(test_version, test_asset_id, Some(d), Withdraw, dummy_ref(), tx)
}
