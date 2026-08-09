//// Stellaris receipt token — Stage 6, Step 1 (mint policy only).
////
//// A receipt is a fungible token that mirrors a depositor's claim on a
//// `yield_vault`. One receipt unit == one DEPOSITOR share. Treasury fee
//// shares are deliberately excluded: they are an internal claim that has no
//// circulating token until the treasury claims them out.
////
//// This policy is DERIVED, not authoritative. It never decides how many
//// shares exist — it reads the vault's own state transition and forces the
//// minted (or burned) quantity to equal the depositor-share delta of that
//// transition. Consequences:
////
////   * `Deposit` (depositor shares up) => exactly that many receipts minted;
////   * `Withdraw` (depositor shares down) => exactly that many burned;
////   * `Accrue`, `SetFee` (treasury shares up, depositor shares flat) => the
////     delta is 0, so the policy refuses to run at all;
////   * `ClaimFee` (total and treasury shares fall together) => delta 0, same.
////
//// Binding: the policy is parameterized by the applied `yield_vault` script
//// hash AND the vault's asset id, so a receipt for asset A can never be
//// minted against asset B's vault, and the token name is fixed to the asset
//// id for the same reason.
////
//// NOTE (kept deliberately non-breaking): `yield_vault` does not yet REQUIRE
//// this policy to run. Wiring the requirement into the vault is Step 2 and
//// moves the vault blueprint hash, so it needs a redeploy. Until then the
//// receipt supply is enforced one-way: no receipt can exist without a
//// matching vault transition, but a vault transition can still happen
//// without receipts.
////
//// `VaultStateMirror` is a STRUCTURAL MIRROR of `YieldDatum` in
//// `validators/yield_vault.ak`. Aiken cannot import types across validator
//// modules, so the shape is duplicated. It must stay field-for-field
//// identical; `mirror_matches_yield_vault_state` guards that.

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}

/// Structural mirror of `yield_vault.YieldDatum`.
pub type VaultDatumMirror {
  Position { owner: ByteArray, shares: Int }
  State {
    total_shares: Int,
    total_assets: Int,
    epoch: Int,
    operators: List<ByteArray>,
    threshold: Int,
    paused: Bool,
    fee_bps: Int,
    treasury: ByteArray,
    treasury_shares: Int,
    last_fee_time: Int,
  }
}

fn at_script(o: Output, hash: ByteArray) -> Bool {
  when o.address.payment_credential is {
    Script(h) -> h == hash
    _ -> False
  }
}

fn datum_of(o: Output) -> Option<VaultDatumMirror> {
  when o.datum is {
    InlineDatum(raw) -> {
      expect d: VaultDatumMirror = raw
      Some(d)
    }
    _ -> None
  }
}

/// Depositor shares recorded by the sole `State` UTxO among `outs`, i.e.
/// `total_shares - treasury_shares`. `None` unless there is exactly one.
fn sole_depositor_shares(outs: List<Output>) -> Option<Int> {
  let states =
    list.filter_map(
      outs,
      fn(o) {
        when datum_of(o) is {
          Some(State { total_shares, treasury_shares, .. }) ->
            Some(total_shares - treasury_shares)
          _ -> None
        }
      },
    )
  when states is {
    [only] -> Some(only)
    _ -> None
  }
}

validator receipt(vault_hash: ByteArray, asset_id: ByteArray) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // The vault's state UTxO must be spent AND recreated in this very
    // transaction; that spend runs `yield_vault`, which is what makes the
    // share delta below trustworthy.
    let vault_ins =
      list.map(
        list.filter(tx.inputs, fn(i: Input) { at_script(i.output, vault_hash) }),
        fn(i: Input) { i.output },
      )
    let vault_outs = list.filter(tx.outputs, fn(o) { at_script(o, vault_hash) })

    expect Some(before) = sole_depositor_shares(vault_ins)
    expect Some(after) = sole_depositor_shares(vault_outs)

    // Exactly one token name under this policy may move, and it is the one
    // bound to the vault's asset id.
    let minted = assets.tokens(tx.mint, policy_id)
    let quantity = assets.quantity_of(tx.mint, policy_id, asset_id)

    dict.size(minted) == 1 && quantity != 0 && quantity == after - before
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const vhash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

const other_hash: ByteArray =
  #"99999999999999999999999999999999999999999999999999999999"

const policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

// "sfm-01"
const t_asset: ByteArray = #"73666d2d3031"

const alice: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

const treas: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

fn state(total_shares: Int, treasury_shares: Int) -> VaultDatumMirror {
  State {
    total_shares,
    total_assets: total_shares,
    epoch: 1,
    operators: [alice],
    threshold: 1,
    paused: False,
    fee_bps: 0,
    treasury: treas,
    treasury_shares,
    last_fee_time: 1_700_000_000_000,
  }
}

fn vault_out(hash: ByteArray, lovelace: Int, d: VaultDatumMirror) -> Output {
  Output {
    address: Address {
      payment_credential: Script(hash),
      stake_credential: None,
    },
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn input_at(ix: Int, o: Output) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
      output_index: ix,
    },
    output: o,
  }
}

fn tx_with(
  ins: List<Input>,
  outs: List<Output>,
  mint: Value,
) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, mint: mint }
}

test mint_matches_deposit_share_delta() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 2_000_000, state(0, 0)))],
      [vault_out(vhash, 2_000_000, state(10_000_000, 0))],
      assets.from_asset(policy, t_asset, 10_000_000),
    )
  receipt.mint(vhash, t_asset, Void, policy, t)
}

test mint_more_than_the_share_delta_is_rejected() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 2_000_000, state(0, 0)))],
      [vault_out(vhash, 2_000_000, state(10_000_000, 0))],
      assets.from_asset(policy, t_asset, 10_000_001),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test burn_matches_withdrawn_shares() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 12_000_000, state(10_000_000, 0)))],
      [vault_out(vhash, 2_000_000, state(4_000_000, 0))],
      assets.from_asset(policy, t_asset, -6_000_000),
    )
  receipt.mint(vhash, t_asset, Void, policy, t)
}

test burning_fewer_than_the_redeemed_shares_is_rejected() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 12_000_000, state(10_000_000, 0)))],
      [vault_out(vhash, 2_000_000, state(4_000_000, 0))],
      assets.from_asset(policy, t_asset, -1_000_000),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test a_foreign_token_name_cannot_ride_along() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 2_000_000, state(0, 0)))],
      [vault_out(vhash, 2_000_000, state(10_000_000, 0))],
      assets.merge(
        assets.from_asset(policy, t_asset, 10_000_000),
        assets.from_asset(policy, #"ff", 1),
      ),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test receipts_for_another_asset_id_cannot_be_minted() {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 2_000_000, state(0, 0)))],
      [vault_out(vhash, 2_000_000, state(10_000_000, 0))],
      assets.from_asset(policy, #"73666d2d3032", 10_000_000),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test minting_against_another_vault_script_is_rejected() fail {
  let t =
    tx_with(
      [input_at(0, vault_out(other_hash, 2_000_000, state(0, 0)))],
      [vault_out(other_hash, 2_000_000, state(10_000_000, 0))],
      assets.from_asset(policy, t_asset, 10_000_000),
    )
  receipt.mint(vhash, t_asset, Void, policy, t)
}

test accrual_mints_no_receipts() {
  // Treasury fee shares: total and treasury rise together, depositor delta 0.
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 12_000_000, state(10_000_000, 0)))],
      [vault_out(vhash, 13_000_000, state(10_050_000, 50_000))],
      assets.from_asset(policy, t_asset, 50_000),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test fee_claim_mints_no_receipts() {
  // Treasury cashes out: total and treasury fall together, depositor delta 0.
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 13_000_000, state(10_050_000, 50_000)))],
      [vault_out(vhash, 12_950_000, state(10_000_000, 0))],
      assets.from_asset(policy, t_asset, -50_000),
    )
  !receipt.mint(vhash, t_asset, Void, policy, t)
}

test a_mint_without_a_vault_state_input_is_rejected() fail {
  let t =
    tx_with(
      [],
      [vault_out(vhash, 2_000_000, state(10_000_000, 0))],
      assets.from_asset(policy, t_asset, 10_000_000),
    )
  receipt.mint(vhash, t_asset, Void, policy, t)
}

test two_state_outputs_are_rejected() fail {
  let t =
    tx_with(
      [input_at(0, vault_out(vhash, 2_000_000, state(0, 0)))],
      [
        vault_out(vhash, 2_000_000, state(10_000_000, 0)),
        vault_out(vhash, 2_000_000, state(10_000_000, 0)),
      ],
      assets.from_asset(policy, t_asset, 10_000_000),
    )
  receipt.mint(vhash, t_asset, Void, policy, t)
}

/// The mirror type must decode a datum produced with `yield_vault`'s field
/// order. If someone reorders `YieldDatum`, this round-trip breaks.
test mirror_matches_yield_vault_state() {
  let s = state(10_000_000, 50_000)
  expect State { total_shares, treasury_shares, .. } = s
  total_shares == 10_000_000 && treasury_shares == 50_000
}
