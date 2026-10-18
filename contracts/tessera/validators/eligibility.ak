//// Eligibility tokens — the launch implementation behind
//// `tessera/eligibility.eligible` (Phase 2.3).
////
//// One validator is both the minting policy of the tokens and the registry
//// address that holds them (policy id = script hash). A token's asset name is
//// the holder's payment key hash.
////
//// * Issue: the committee (M-of-N, read from the genuine Reserve State given
////   as a reference input, so a reserve `Rotate` carries over) mints one
////   token per key hash, and every token must land at the registry address,
////   alone beside ADA. Tokens therefore never sit in a wallet: they cannot be
////   transferred, and the committee can always revoke them.
//// * Revoke: the committee spends the registry UTxO and burns its token.
////   Nothing at the registry can be spent without the committee, and a
////   registry UTxO's tokens can only leave by being burned.
//// * Use: `eligible` needs the holder's signature plus a reference input
////   holding exactly that holder's token.
////
//// Uniqueness is not enforced on-chain (a policy only sees its own
//// transaction): the committee is trusted not to double-issue, and a
//// duplicate is harmless — `eligible` needs one matching token, and a
//// duplicate can be revoked like any other.

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use stellaris/thread.{thread_name}
use tessera/reserve_state.{ReserveState, threshold_met}

/// The committee of the genuine Reserve State (the one reference input that
/// holds the reserve's thread token, at the reserve address) signed the tx.
fn committee_signed(tx: Transaction, reserve: PolicyId) -> Bool {
  let states =
    tx.reference_inputs
      |> list.filter(
          fn(i) { quantity_of(i.output.value, reserve, thread_name) == 1 },
        )
  when states is {
    [s] ->
      if s.output.address.payment_credential == Script(reserve) {
        when s.output.datum is {
          InlineDatum(d) ->
            if d is st: ReserveState {
              threshold_met(st.operators, st.threshold, tx.extra_signatories)
            } else {
              False
            }
          _ -> False
        }
      } else {
        False
      }
    _ -> False
  }
}

/// Every output that carries a token of `policy` is at the registry address
/// and holds exactly one token of `policy` and nothing else besides ADA.
fn tokens_stay_in_registry(tx: Transaction, policy: PolicyId) -> Bool {
  list.all(
    tx.outputs,
    fn(o) {
      when dict.to_pairs(assets.tokens(o.value, policy)) is {
        [] -> True
        [Pair(name, 1)] ->
          o.address.payment_credential == Script(policy) && assets.without_lovelace(
            o.value,
          ) == assets.from_asset(policy, name, 1)
        _ -> False
      }
    },
  )
}

/// Issue (+1 per name) or revoke (any negative amount): the name is a 28-byte
/// key hash. Issuing two of one name in a transaction is refused.
fn amounts_ok(minted: Pairs<ByteArray, Int>) -> Bool {
  list.all(
    minted,
    fn(p) {
      when p is {
        Pair(name, qty) -> bytearray.length(name) == 28 && (qty == 1 || qty < 0)
      }
    },
  )
}

validator eligibility(reserve: PolicyId) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let minted = dict.to_pairs(assets.tokens(tx.mint, policy_id))
    and {
      minted != [],
      committee_signed(tx, reserve),
      amounts_ok(minted),
      tokens_stay_in_registry(tx, policy_id),
    }
  }

  /// Revocation, or sweeping junk someone paid to the registry: always the
  /// committee, and every eligibility token in the spent UTxO is burned.
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(own) =
      tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
    expect Script(policy) = own.output.address.payment_credential
    let held = dict.to_pairs(assets.tokens(own.output.value, policy))
    and {
      committee_signed(tx, reserve),
      list.all(
        held,
        fn(p) {
          when p is {
            Pair(name, q) -> quantity_of(tx.mint, policy, name) <= -q
          }
        },
      ),
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_reserve: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const t_policy: PolicyId =
  #"77777777777777777777777777777777777777777777777777777777"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_op3: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const t_holder: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

fn t_ref(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0808080808080808080808080808080808080808080808080808080808080808",
    output_index: i,
  }
}

fn t_reserve_state(operators: List<ByteArray>, threshold: Int) -> ReserveState {
  ReserveState {
    minted_supply: 0,
    attested_reserve: 0,
    mint_cap: 0,
    attestation_epoch: 0,
    attested_at: 0,
    epoch: 0,
    operators,
    threshold,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: t_policy,
  }
}

/// The genuine Reserve State as a reference input (committee op1+op2, 2-of-2).
fn reserve_ref_with(st: ReserveState, with_token: Bool) -> Input {
  let base = assets.from_lovelace(2_000_000)
  Input {
    output_reference: t_ref(9),
    output: Output {
      address: Address {
        payment_credential: Script(t_reserve),
        stake_credential: None,
      },
      value: if with_token {
        base |> assets.add(t_reserve, thread_name, 1)
      } else {
        base
      },
      datum: InlineDatum(st),
      reference_script: None,
    },
  }
}

fn reserve_ref() -> Input {
  reserve_ref_with(t_reserve_state([t_op1, t_op2], 2), True)
}

fn registry() -> Address {
  Address { payment_credential: Script(t_policy), stake_credential: None }
}

fn registry_out(name: ByteArray) -> Output {
  Output {
    address: registry(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_policy, name, 1),
    datum: NoDatum,
    reference_script: None,
  }
}

fn issue_tx(outputs: List<Output>, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    reference_inputs: [reserve_ref()],
    outputs: outputs,
    mint: assets.from_asset(t_policy, t_holder, 1),
    extra_signatories: signers,
  }
}

fn registry_in(name: ByteArray) -> Input {
  Input { output_reference: t_ref(0), output: registry_out(name) }
}

fn revoke_tx(signers: List<ByteArray>, burn: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [registry_in(t_holder)],
    reference_inputs: [reserve_ref()],
    mint: if burn == 0 {
      assets.zero
    } else {
      assets.from_asset(t_policy, t_holder, burn)
    },
    extra_signatories: signers,
  }
}

// -- Issue

test issuing_by_the_committee_into_the_registry_is_accepted() {
  eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    issue_tx([registry_out(t_holder)], [t_op1, t_op2]),
  )
}

test issuing_needs_the_committee() {
  !eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    issue_tx([registry_out(t_holder)], [t_op1]),
  )
}

test issuing_by_the_holder_alone_is_rejected() {
  !eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    issue_tx([registry_out(t_holder)], [t_holder]),
  )
}

test issuing_follows_a_rotated_committee() {
  // the reserve rotated to {op2, op3}: op1 + op2 no longer suffice
  let rotated = reserve_ref_with(t_reserve_state([t_op2, t_op3], 2), True)
  let tx =
    Transaction {
      ..issue_tx([registry_out(t_holder)], [t_op1, t_op2]),
      reference_inputs: [rotated],
    }
  let ok =
    Transaction {
      ..issue_tx([registry_out(t_holder)], [t_op2, t_op3]),
      reference_inputs: [rotated],
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx) && eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    ok,
  )
}

test issuing_against_a_planted_reserve_state_is_rejected() {
  // a State-shaped UTxO with an attacker committee but no thread token
  let planted =
    reserve_ref_with(t_reserve_state([t_holder, t_op3], 2), False)
  let tx =
    Transaction {
      ..issue_tx([registry_out(t_holder)], [t_holder, t_op3]),
      reference_inputs: [planted],
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test issuing_against_a_reserve_state_off_the_reserve_address_is_rejected() {
  let moved =
    Input {
      ..reserve_ref(),
      output: Output {
        ..reserve_ref().output,
        address: Address {
          payment_credential: Script(t_policy),
          stake_credential: None,
        },
      },
    }
  let tx =
    Transaction {
      ..issue_tx([registry_out(t_holder)], [t_op1, t_op2]),
      reference_inputs: [moved],
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test issuing_without_the_reserve_state_is_rejected() {
  let tx =
    Transaction {
      ..issue_tx([registry_out(t_holder)], [t_op1, t_op2]),
      reference_inputs: [],
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test issuing_into_a_wallet_is_rejected() {
  let to_wallet =
    Output {
      ..registry_out(t_holder),
      address: Address {
        payment_credential: VerificationKey(t_holder),
        stake_credential: None,
      },
    }
  !eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    issue_tx([to_wallet], [t_op1, t_op2]),
  )
}

test issuing_two_of_one_name_is_rejected() {
  let two =
    Output {
      ..registry_out(t_holder),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_policy, t_holder, 2),
    }
  let tx =
    Transaction {
      ..issue_tx([two], [t_op1, t_op2]),
      mint: assets.from_asset(t_policy, t_holder, 2),
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test issuing_a_name_that_is_not_a_key_hash_is_rejected() {
  let tx =
    Transaction {
      ..issue_tx([registry_out("not-a-key-hash")], [t_op1, t_op2]),
      mint: assets.from_asset(t_policy, "not-a-key-hash", 1),
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test a_registry_output_may_not_carry_extra_tokens() {
  let junk =
    Output {
      ..registry_out(t_holder),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_policy, t_holder, 1)
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "x", 1),
    }
  !eligibility.mint(t_reserve, Void, t_policy, issue_tx([junk], [t_op1, t_op2]))
}

test two_holders_tokens_may_not_share_a_registry_output() {
  let other = #"a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"
  let both =
    Output {
      ..registry_out(t_holder),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_policy, t_holder, 1)
        |> assets.add(t_policy, other, 1),
    }
  let tx =
    Transaction {
      ..issue_tx([both], [t_op1, t_op2]),
      mint: assets.from_asset(t_policy, t_holder, 1)
        |> assets.add(t_policy, other, 1),
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

test an_empty_mint_does_not_pass() {
  let tx =
    Transaction { ..issue_tx([], [t_op1, t_op2]), mint: assets.zero }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}

// -- Revoke

test revoking_by_the_committee_is_accepted() {
  let tx = revoke_tx([t_op1, t_op2], -1)
  eligibility.spend(t_reserve, None, Void, t_ref(0), tx) && eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    tx,
  )
}

test revoking_needs_the_committee() {
  let tx = revoke_tx([t_op1], -1)
  !eligibility.spend(t_reserve, None, Void, t_ref(0), tx) && !eligibility.mint(
    t_reserve,
    Void,
    t_policy,
    tx,
  )
}

test the_holder_cannot_spend_their_registry_token() {
  !eligibility.spend(t_reserve, None, Void, t_ref(0), revoke_tx([t_holder], -1))
}

test a_registry_token_cannot_be_moved_without_burning() {
  // the committee spends it but re-creates it instead of burning
  let tx =
    Transaction { ..revoke_tx([t_op1, t_op2], 0), outputs: [registry_out(t_holder)] }
  !eligibility.spend(t_reserve, None, Void, t_ref(0), tx)
}

test junk_at_the_registry_needs_the_committee_to_sweep() {
  let junk =
    Input {
      output_reference: t_ref(0),
      output: Output { ..registry_out(t_holder), value: assets.from_lovelace(5_000_000) },
    }
  let by_anyone =
    Transaction {
      ..transaction.placeholder,
      inputs: [junk],
      reference_inputs: [reserve_ref()],
      extra_signatories: [t_holder],
    }
  let by_committee = Transaction { ..by_anyone, extra_signatories: [t_op1, t_op2] }
  !eligibility.spend(t_reserve, None, Void, t_ref(0), by_anyone) && eligibility.spend(
    t_reserve,
    None,
    Void,
    t_ref(0),
    by_committee,
  )
}

test issuing_two_of_one_name_into_separate_outputs_is_rejected() {
  // each output holds one, but the mint names the same key hash twice
  let tx =
    Transaction {
      ..issue_tx([registry_out(t_holder), registry_out(t_holder)], [t_op1, t_op2]),
      mint: assets.from_asset(t_policy, t_holder, 2),
    }
  !eligibility.mint(t_reserve, Void, t_policy, tx)
}
