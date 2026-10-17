//// Tessera Reserve State — the on-chain gate for minting and burning TSRA.
////
//// One State UTxO, identified by a one-shot NFT (`state_nft.ak`), records how
//// much TSRA exists, how much reserve the operator committee has attested to,
//// and a committee-set mint cap. This script is BOTH the spending validator
//// for that State and the minting policy for TSRA (policy id = script hash),
//// so TSRA can only move in a transaction that also transitions the State.
////
//// Rules (see ../SPEC.md):
////   * Mint: committee M-of-N, not paused, supply stays <= min(attested
////     reserve, mint cap), and the attestation is fresh (<= 7 days old for the
////     whole validity range of the transaction).
////   * Burn: no signature and no pause check. Anyone holding TSRA can always
////     burn it; the State just has to record it. (Throughput note: every burn
////     spends the single State UTxO, so burns serialise. The redemption queue
////     batches many burns into one transaction for that reason.)
////   * Attest / SetCap / SetPaused: committee M-of-N.
////   * Every transition: exactly one NFT-bearing State on both sides (the V-01
////     lesson), the next datum equals the expected datum EXACTLY (so no field
////     can change unless that redeemer says it may), epoch +1, and the State
////     output holds only ADA plus the NFT.
////
//// Not yet supported: committee rotation, and a reserve asset on-chain (the
//// reserve is off-chain and attested). Both are deliberate gaps for later.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use tessera/rules

// ---------------------------------------------------------------- datum

pub type ReserveState {
  /// TSRA currently in existence (1e-6 TSRA units).
  minted_supply: Int,
  /// Reserve the committee last attested to, in the same units.
  attested_reserve: Int,
  /// Committee-set ceiling on `minted_supply`.
  mint_cap: Int,
  /// Number of attestations recorded so far.
  attestation_epoch: Int,
  /// POSIX ms of the last attestation.
  attested_at: Int,
  /// Monotonic replay counter: exactly one State transition per tx.
  epoch: Int,
  operators: List<ByteArray>,
  threshold: Int,
  paused: Bool,
}

pub type ReserveRedeemer {
  Mint { qty: Int }
  Burn { qty: Int }
  Attest { reserve: Int }
  SetCap { mint_cap: Int }
  SetPaused { paused: Bool }
}

// ---------------------------------------------------------------- helpers

fn own_script_inputs(inputs: List<Input>, script: ByteArray) -> List<Output> {
  inputs
    |> list.filter_map(
        fn(i) {
          when i.output.address.payment_credential is {
            Script(h) ->
              if h == script {
                Some(i.output)
              } else {
                None
              }
            _ -> None
          }
        },
      )
}

fn own_script_outputs(outputs: List<Output>, script: ByteArray) -> List<Output> {
  outputs
    |> list.filter(
        fn(o) {
          when o.address.payment_credential is {
            Script(h) -> h == script
            _ -> False
          }
        },
      )
}

/// The one genuine State among `outs`: the output carrying the State NFT.
/// `None` unless exactly one output carries it AND it has a ReserveState
/// inline datum. A planted State-shaped UTxO without the NFT is ignored.
fn sole_state(
  outs: List<Output>,
  nft_policy: PolicyId,
) -> Option<(Output, ReserveState)> {
  let marked =
    outs
      |> list.filter(
          fn(o) { quantity_of(o.value, nft_policy, rules.state_nft_name) > 0 },
        )
  when marked is {
    [only] ->
      if quantity_of(only.value, nft_policy, rules.state_nft_name) == 1 {
        when only.datum is {
          InlineDatum(d) ->
            if d is s: ReserveState {
              Some((only, s))
            } else {
              None
            }
          _ -> None
        }
      } else {
        None
      }
    _ -> None
  }
}

fn threshold_met(state: ReserveState, signatories: List<ByteArray>) -> Bool {
  let signers =
    state.operators
      |> list.filter(fn(op) { list.has(signatories, op) })
      |> list.unique
  list.length(signers) >= state.threshold
}

fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  n > 0 && threshold >= 1 && threshold <= n && list.length(
    list.unique(operators),
  ) == n
}

/// The State output may hold only ADA and the State NFT, so nobody can attach
/// junk tokens to inflate min-ADA and strand funds.
fn state_value_ok(out: Output, nft_policy: PolicyId) -> Bool {
  list.all(
    assets.policies(out.value),
    fn(p) { p == assets.ada_policy_id || p == nft_policy },
  )
}

/// (lower, upper) finite validity bounds, if both exist.
fn finite_bounds(tx: Transaction) -> Option<(Int, Int)> {
  when
    (
      tx.validity_range.lower_bound.bound_type,
      tx.validity_range.upper_bound.bound_type,
    )
  is {
    (Finite(lo), Finite(hi)) -> Some((lo, hi))
    _ -> None
  }
}

/// TSRA minted (positive) or burned (negative) under this policy in this tx.
fn tsra_delta(tx: Transaction, own_policy: PolicyId) -> Int {
  let names = assets.tokens(tx.mint, own_policy) |> dict.to_pairs
  when names is {
    [] -> 0
    [Pair(name, qty)] ->
      if name == rules.tsra_name {
        qty
      } else {
        fail @"foreign token name under TSRA policy"
      }
    _ -> fail @"multiple token names under TSRA policy"
  }
}

// ---------------------------------------------------------------- validator

validator reserve(nft_policy: PolicyId) {
  spend(
    datum: Option<ReserveState>,
    redeemer: ReserveRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(s0) = datum
    expect Some(own_input) =
      tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
    expect Script(own_hash) = own_input.output.address.payment_credential

    let ins = own_script_inputs(tx.inputs, own_hash)
    let outs = own_script_outputs(tx.outputs, own_hash)

    // V-01 from day one: exactly one genuine State on BOTH sides, and the
    // input being spent is that State (not a planted lookalike).
    expect Some((_, in_state)) = sole_state(ins, nft_policy)
    expect Some((next_out, s1)) = sole_state(outs, nft_policy)

    let structural =
      and {
        in_state == s0,
        operators_valid(s1.operators, s1.threshold),
        state_value_ok(next_out, nft_policy),
      }

    let delta = tsra_delta(tx, own_hash)
    let signed = threshold_met(s0, tx.extra_signatories)

    when redeemer is {
      Mint { qty } -> {
        expect Some((_lo, hi)) = finite_bounds(tx)
        and {
          structural,
          !s0.paused,
          signed,
          rules.mint_allowed(
            s0.minted_supply,
            qty,
            s0.attested_reserve,
            s0.mint_cap,
          ),
          rules.fresh(hi, s0.attested_at),
          delta == qty,
          s1 == ReserveState {
            ..s0,
            minted_supply: s0.minted_supply + qty,
            epoch: s0.epoch + 1,
          },
        }
      }

      // Bearer: no signature, and allowed while paused.
      Burn { qty } ->
        and {
          structural,
          qty > 0,
          qty <= s0.minted_supply,
          delta == -qty,
          s1 == ReserveState {
            ..s0,
            minted_supply: s0.minted_supply - qty,
            epoch: s0.epoch + 1,
          },
        }

      // Attesting LOWER than the minted supply is allowed on purpose: the
      // committee must be able to report an undercollateralised reserve
      // honestly. It simply blocks further minting until the reserve recovers.
      Attest { reserve } -> {
        expect Some((lo, hi)) = finite_bounds(tx)
        and {
          structural,
          signed,
          reserve >= 0,
          rules.window_ok(lo, hi, s0.attested_at),
          delta == 0,
          s1 == ReserveState {
            ..s0,
            attested_reserve: reserve,
            attestation_epoch: s0.attestation_epoch + 1,
            attested_at: lo,
            epoch: s0.epoch + 1,
          },
        }
      }

      SetCap { mint_cap } ->
        and {
          structural,
          signed,
          mint_cap >= 0,
          delta == 0,
          s1 == ReserveState { ..s0, mint_cap: mint_cap, epoch: s0.epoch + 1 },
        }

      SetPaused { paused } ->
        and {
          structural,
          signed,
          delta == 0,
          s1 == ReserveState { ..s0, paused: paused, epoch: s0.epoch + 1 },
        }
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // TSRA may only move when the genuine State transitions in the same tx;
    // the spend handler then enforces the exact quantity and the rules.
    let state_ins = own_script_inputs(tx.inputs, policy_id)
    when sole_state(state_ins, nft_policy) is {
      Some(_) -> True
      None -> False
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests


const t_nft: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

const t_own: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_attested_at: Int = 1_000_000

fn t_state(minted: Int, reserve: Int, cap: Int) -> ReserveState {
  ReserveState {
    minted_supply: minted,
    attested_reserve: reserve,
    mint_cap: cap,
    attestation_epoch: 1,
    attested_at: t_attested_at,
    epoch: 0,
    operators: [t_op1, t_op2],
    threshold: 2,
    paused: False,
  }
}

fn t_addr() -> Address {
  Address { payment_credential: Script(t_own), stake_credential: None }
}

fn state_out_with(s: ReserveState, with_nft: Bool) -> Output {
  let base = assets.from_lovelace(2_000_000)
  Output {
    address: t_addr(),
    value: if with_nft {
      base |> assets.add(t_nft, rules.state_nft_name, 1)
    } else {
      base
    },
    datum: InlineDatum(s),
    reference_script: None,
  }
}

fn state_out(s: ReserveState) -> Output {
  state_out_with(s, True)
}

fn ref0() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }
}

fn ref1() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 1,
  }
}

fn state_in(s: ReserveState) -> Input {
  Input { output_reference: ref0(), output: state_out(s) }
}

fn tsra(qty: Int) -> assets.Value {
  assets.from_asset(t_own, rules.tsra_name, qty)
}

/// A well-formed committee transaction: both operators sign, finite validity
/// range well inside the attestation's freshness window.
fn base_tx(s0: ReserveState, s1: ReserveState, delta: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [state_in(s0)],
    outputs: [state_out(s1)],
    mint: tsra(delta),
    extra_signatories: [t_op1, t_op2],
    validity_range: interval.between(1_500_000, 2_000_000),
  }
}

fn next(s: ReserveState) -> ReserveState {
  ReserveState { ..s, epoch: s.epoch + 1 }
}

// -- Mint

test mint_within_reserve_and_cap_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 100 }
  reserve.spend(t_nft, Some(s0), Mint { qty: 100 }, ref0(), base_tx(s0, s1, 100))
}

test mint_above_attested_reserve_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 101 }, ref0(), base_tx(s0, s1, 101))
}

test mint_above_cap_is_rejected() {
  let s0 = t_state(0, 1_000, 100)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 101 }, ref0(), base_tx(s0, s1, 101))
}

test mint_with_stale_attestation_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let late = t_attested_at + rules.max_attestation_age + 1
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      validity_range: interval.between(late - 1_000, late),
    }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_with_unbounded_validity_is_rejected() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction { ..base_tx(s0, s1, 10), validity_range: interval.after(1_500_000) }
  reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_below_threshold_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op1] }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_while_paused_is_rejected() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

test mint_delta_must_equal_redeemer_qty() {
  // datum and redeemer say 10, but the tx mints 20 TSRA
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 20))
}

test mint_cannot_sneak_in_a_different_field_change() {
  // raises the cap in the same transaction as a mint
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10, mint_cap: 9_999 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

test mint_replayed_epoch_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..s0, minted_supply: 10 }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

// -- Authenticity of the State (the planted-State attack)

test planted_state_without_nft_cannot_mint() fail {
  // attacker's own State: huge reserve, own committee, NO state NFT
  let evil = ReserveState { ..t_state(0, 999_999_999, 999_999_999), operators: [t_op1], threshold: 1 }
  let evil_next = ReserveState { ..next(evil), minted_supply: 500_000_000 }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [Input { output_reference: ref0(), output: state_out_with(evil, False) }],
      outputs: [state_out_with(evil_next, False)],
      mint: tsra(500_000_000),
      extra_signatories: [t_op1],
      validity_range: interval.between(1_500_000, 2_000_000),
    }
  reserve.spend(t_nft, Some(evil), Mint { qty: 500_000_000 }, ref0(), tx)
}

test planted_state_cannot_unlock_tsra_mint_handler() {
  let evil = t_state(0, 999_999_999, 999_999_999)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [Input { output_reference: ref0(), output: state_out_with(evil, False) }],
      mint: tsra(1),
    }
  !reserve.mint(t_nft, Void, t_own, tx)
}

test mint_handler_accepts_when_genuine_state_is_spent() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  reserve.mint(t_nft, Void, t_own, base_tx(s0, s1, 10))
}

test mint_handler_rejects_when_no_state_is_spent() {
  let tx = Transaction { ..transaction.placeholder, mint: tsra(10) }
  !reserve.mint(t_nft, Void, t_own, tx)
}

test two_genuine_states_cannot_be_spent_together() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let second = Input { output_reference: ref1(), output: state_out(s0) }
  let tx = Transaction { ..base_tx(s0, s1, 10), inputs: [state_in(s0), second] }
  reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test state_output_may_not_carry_foreign_tokens() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let junk =
    Output {
      ..state_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_nft, rules.state_nft_name, 1)
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "junk", 1),
    }
  let tx = Transaction { ..base_tx(s0, s1, 10), outputs: [junk] }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

// -- Burn

test burn_needs_no_signature() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test burn_is_allowed_while_paused() {
  let s0 = ReserveState { ..t_state(100, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test burn_more_than_supply_is_rejected() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: -1 }
  let tx = Transaction { ..base_tx(s0, s1, -101), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Burn { qty: 101 }, ref0(), tx)
}

test burn_must_actually_burn() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

// -- Attest

test attest_records_reserve_and_anchor() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test attest_below_minted_supply_is_allowed() {
  let s0 = t_state(100, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 40,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  reserve.spend(t_nft, Some(s0), Attest { reserve: 40 }, ref0(), base_tx(s0, s1, 0))
}

test attest_with_oversized_window_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      validity_range: interval.between(1_500_000, 1_500_000 + rules.max_attest_window + 1),
    }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

test attest_cannot_go_backwards_in_time() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 500_000,
    }
  let tx = Transaction { ..base_tx(s0, s1, 0), validity_range: interval.between(500_000, 900_000) }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

test attest_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

// -- SetCap / SetPaused

test set_cap_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  reserve.spend(t_nft, Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_mint_at_the_same_time() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50, minted_supply: 10 }
  !reserve.spend(t_nft, Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  reserve.spend(t_nft, Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 0))
}

test pause_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !reserve.spend(t_nft, Some(s0), SetPaused { paused: True }, ref0(), tx)
}

// -- Added by the mutation pass: each test below is the only one that fails
//    when a specific guard is deleted (see SPEC.md §6).

test set_cap_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !reserve.spend(t_nft, Some(s0), SetCap { mint_cap: 50 }, ref0(), tx)
}

test a_zero_threshold_committee_cannot_act_unsigned() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), threshold: 0 }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test the_state_nft_cannot_leave_the_state() fail {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx =
    Transaction {
      ..base_tx(s0, s1, -40),
      outputs: [state_out_with(s1, False)],
      extra_signatories: [],
    }
  reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test a_stray_output_at_the_script_does_not_block_the_state() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let stray =
    Output {
      address: t_addr(),
      value: assets.from_lovelace(1_500_000),
      datum: NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, -40),
      outputs: [stray, state_out(s1)],
      extra_signatories: [],
    }
  reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test a_state_holding_two_nfts_is_not_genuine() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let doubled =
    Output {
      ..state_out(s0),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_nft, rules.state_nft_name, 2),
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      inputs: [Input { output_reference: ref0(), output: doubled }],
    }
  reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test a_planted_input_beside_the_genuine_state_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let evil =
    ReserveState {
      ..s0,
      operators: [t_op1],
      threshold: 1,
      attested_reserve: 999_999,
    }
  let s1 = ReserveState { ..next(evil), minted_supply: 10 }
  let planted =
    Input { output_reference: ref1(), output: state_out_with(evil, False) }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      inputs: [state_in(s0), planted],
      extra_signatories: [t_op1],
    }
  !reserve.spend(t_nft, Some(evil), Mint { qty: 10 }, ref1(), tx)
}

test burn_cannot_change_the_committee() {
  let s0 = t_state(100, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      minted_supply: 60,
      operators: [t_op1],
      threshold: 1,
    }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test attest_cannot_change_the_cap() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
      mint_cap: 9_999,
    }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test attest_must_anchor_at_the_validity_lower_bound() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_900_000,
    }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_change_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50, threshold: 1 }
  !reserve.spend(t_nft, Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test set_paused_cannot_change_the_reserve() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True, attested_reserve: 9_999 }
  !reserve.spend(t_nft, Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 0))
}

test a_foreign_token_name_cannot_be_minted_under_the_tsra_policy() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 0), mint: assets.from_asset(t_own, "FAKE", 10) }
  reserve.spend(t_nft, Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test a_second_token_name_cannot_ride_along_with_an_attestation() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      mint: tsra(10) |> assets.add(t_own, "FAKE", 10),
    }
  reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

test burn_with_a_negative_qty_cannot_mint() {
  // Burn needs no signature, so a negative burn would be an unsigned,
  // uncapped mint if `qty > 0` were missing.
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 100 }
  let tx = Transaction { ..base_tx(s0, s1, 100), extra_signatories: [] }
  !reserve.spend(t_nft, Some(s0), Burn { qty: -100 }, ref0(), tx)
}

test attest_negative_reserve_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: -1,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: -1 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_negative_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: -1 }
  !reserve.spend(t_nft, Some(s0), SetCap { mint_cap: -1 }, ref0(), base_tx(s0, s1, 0))
}

test attest_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      attested_reserve: 250,
      attestation_epoch: 2,
      attested_at: 1_500_000,
    }
  !reserve.spend(t_nft, Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 10))
}

test set_cap_cannot_mint_with_an_exact_datum() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  !reserve.spend(t_nft, Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  !reserve.spend(t_nft, Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 10))
}
