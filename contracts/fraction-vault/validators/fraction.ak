//// Stellaris fraction token — the mint policy behind fractional ownership.
////
//// This policy is DERIVED, not authoritative. It never decides how many
//// fractions exist; it reads the offering's own state transition and forces
//// the minted (or burned) quantity to equal the change in fractions
//// outstanding. The offering validator makes the same check from its side,
//// so the two are bound in both directions:
////
////   * `Buy`    (outstanding up)   => exactly that many fractions minted;
////   * `Redeem` (outstanding down) => exactly that many burned;
////   * every other action leaves outstanding flat, so the delta is 0 and the
////     policy refuses to run at all.
////
//// Binding: parameterised by the APPLIED offering script hash and the asset
//// id, and the token name is fixed to the asset id — so a fraction of asset
//// A can never be minted against asset B's offering.

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use stellaris/offering.{Offering, OfferingDatum}

fn at_script(o: Output, hash: ByteArray) -> Bool {
  when o.address.payment_credential is {
    Script(h) -> h == hash
    _ -> False
  }
}

/// Fractions outstanding recorded by the sole offering UTxO among `outs`.
fn sole_outstanding(outs: List<Output>) -> Option<Int> {
  let counts =
    list.filter_map(
      outs,
      fn(o) {
        when o.datum is {
          InlineDatum(raw) -> {
            expect d: OfferingDatum = raw
            let Offering { outstanding, .. } = d
            Some(outstanding)
          }
          _ -> None
        }
      },
    )
  when counts is {
    [only] -> Some(only)
    _ -> None
  }
}

validator fraction(offering_hash: ByteArray, asset_id: ByteArray) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // The offering state must be spent AND recreated in this transaction;
    // that spend runs `fraction_vault`, which is what makes the delta below
    // trustworthy.
    let ins =
      list.map(
        list.filter(
          tx.inputs,
          fn(i: Input) { at_script(i.output, offering_hash) },
        ),
        fn(i: Input) { i.output },
      )
    let outs = list.filter(tx.outputs, fn(o) { at_script(o, offering_hash) })

    expect Some(before) = sole_outstanding(ins)
    expect Some(after) = sole_outstanding(outs)

    // Exactly one token name under this policy may move, and it is the one
    // bound to the offering's asset id.
    let moved = assets.tokens(tx.mint, policy_id)
    let quantity = assets.quantity_of(tx.mint, policy_id, asset_id)

    dict.size(moved) == 1 && quantity != 0 && quantity == after - before
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const ohash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

const policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const other_policy: PolicyId =
  #"99999999999999999999999999999999999999999999999999999999"

// "ph-solar-01"
const t_asset: ByteArray = #"70682d736f6c61722d3031"

const op1: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

fn state(minted: Int, outstanding: Int) -> OfferingDatum {
  Offering {
    total_fractions: 1_000,
    minted,
    outstanding,
    price: 25_000_000,
    pool: 0,
    fees: 0,
    issuer: op1,
    treasury: op1,
    operators: [op1],
    threshold: 1,
    status: offering.Open,
    mint_fee_bps: 0,
    redeem_fee_bps: 0,
    fraction_policy: policy,
  }
}

fn utxo(hash: ByteArray, d: OfferingDatum) -> Output {
  Output {
    address: address.Address {
      payment_credential: Script(hash),
      stake_credential: None,
    },
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

fn input_at(ix: Int, o: Output) -> Input {
  Input {
    output_reference: transaction.OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
      output_index: ix,
    },
    output: o,
  }
}

fn tx_with(
  ins: List<Input>,
  outs: List<Output>,
  mint: assets.Value,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: ins,
    outputs: outs,
    mint: mint,
  }
}

test mint_matches_the_outstanding_delta() {
  fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(ohash, state(0, 0)))],
      [utxo(ohash, state(4, 4))],
      assets.from_asset(policy, t_asset, 4),
    ),
  )
}

test burn_matches_the_outstanding_delta() {
  fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(ohash, state(4, 4)))],
      [utxo(ohash, state(4, 3))],
      assets.from_asset(policy, t_asset, -1),
    ),
  )
}

test minting_more_than_the_delta_is_rejected() {
  !fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(ohash, state(0, 0)))],
      [utxo(ohash, state(4, 4))],
      assets.from_asset(policy, t_asset, 5),
    ),
  )
}

test minting_under_the_wrong_token_name_is_rejected() {
  !fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(ohash, state(0, 0)))],
      [utxo(ohash, state(4, 4))],
      assets.from_asset(policy, "OTHER", 4),
    ),
  )
}

test minting_against_another_offering_is_rejected() {
  !fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(other_policy, state(0, 0)))],
      [utxo(other_policy, state(4, 4))],
      assets.from_asset(policy, t_asset, 4),
    ),
  )
}

test a_flat_transition_cannot_mint_anything() {
  !fraction.mint(
    ohash,
    t_asset,
    Void,
    policy,
    tx_with(
      [input_at(0, utxo(ohash, state(4, 4)))],
      [utxo(ohash, state(4, 4))],
      assets.from_asset(policy, t_asset, 1),
    ),
  )
}
