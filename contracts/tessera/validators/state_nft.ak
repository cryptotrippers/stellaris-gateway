//// One-shot NFT that marks the genuine Tessera Reserve State UTxO.
////
//// Why it exists: the reserve validator is also the TSRA minting policy, and
//// the reserve's backing is attested off-chain, so nothing on-chain would
//// stop an attacker from planting their OWN State-shaped UTxO at the script
//// address (a committee of their own, an enormous `attested_reserve`) and
//// spending it to mint real TSRA. The reserve validator therefore only
//// recognises a State that carries this NFT. It can be minted exactly once,
//// because it requires spending a specific seed UTxO.

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction,
}
use tessera/rules

validator state_nft(seed: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let spends_seed =
      list.any(tx.inputs, fn(i) { i.output_reference == seed })
    let minted = assets.tokens(tx.mint, policy_id) |> dict.to_pairs
    spends_seed && minted == [Pair(rules.state_nft_name, 1)]
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 3,
  }
}

fn t_input(ref: OutputReference) -> Input {
  Input {
    output_reference: ref,
    output: Output {
      address: Address {
        payment_credential: VerificationKey(
          #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        ),
        stake_credential: None,
      },
      value: assets.from_lovelace(5_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn t_other_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"0202020202020202020202020202020202020202020202020202020202020202",
    output_index: 0,
  }
}

test mints_once_when_seed_is_spent() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [t_input(t_seed())],
      mint: assets.from_asset(#"aa", rules.state_nft_name, 1),
    }
  state_nft.mint(t_seed(), Void, #"aa", tx)
}

test cannot_mint_without_spending_the_seed() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [t_input(t_other_ref())],
      mint: assets.from_asset(#"aa", rules.state_nft_name, 1),
    }
  !state_nft.mint(t_seed(), Void, #"aa", tx)
}

test cannot_mint_two() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [t_input(t_seed())],
      mint: assets.from_asset(#"aa", rules.state_nft_name, 2),
    }
  !state_nft.mint(t_seed(), Void, #"aa", tx)
}

test cannot_mint_under_another_name() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [t_input(t_seed())],
      mint: assets.from_asset(#"aa", "OTHER", 1),
    }
  !state_nft.mint(t_seed(), Void, #"aa", tx)
}
