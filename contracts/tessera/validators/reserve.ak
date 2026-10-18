//// Tessera Reserve State — the on-chain gate for minting and burning TSRA.
////
//// One State UTxO, identified by a one-shot state-thread token, records how
//// much TSRA exists, how much reserve the operator committee has attested to,
//// and a committee-set mint cap. This script is the spending validator for
//// that State AND the minting policy for both TSRA and the thread token
//// (policy id = script hash), so TSRA can only move in a transaction that also
//// transitions the State.
////
//// Genesis (Phase 2.2): the script is parameterised by a `seed` UTxO and mints
//// the thread token itself (`stellaris/thread`, the same pattern as the
//// vaults). The mint checks the genesis output on-chain — exactly one output
//// at this address, holding only ADA and the token, with a valid empty
//// `ReserveState` — so a bad bootstrap can no longer create the State.
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
////   * Rotate: the current committee M-of-N AND the new committee M-of-N;
////     only `operators`, `threshold` and `epoch` change.
////   * Every transition: exactly one token-bearing State on both sides (the
////     V-01 lesson), the next datum equals the expected datum EXACTLY (so no
////     field can change unless that redeemer says it may), epoch +1, the
////     committee stays valid, and the State output holds only ADA plus the
////     thread token.
////
//// Not yet supported: a reserve asset on-chain (the reserve is off-chain and
//// attested; decision 4 in DESIGN.md §7 is open pending counsel). The datum is
//// PROVISIONAL until counsel answers.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use stellaris/thread.{one_shot_mint, thread_name, thread_value}
use tessera/rules

// ---------------------------------------------------------------- datum

/// PROVISIONAL until counsel answers (SPEC.md §1): the committee model, the
/// attestation format and any on-chain reserve asset may still change.
pub type ReserveState {
  /// TSRA currently in existence (1e-6 TSRA units).
  minted_supply: Int,
  /// Reserve the committee last attested to, in the same units.
  attested_reserve: Int,
  /// Committee-set ceiling on `minted_supply`, at most `rules.max_mint_cap`.
  mint_cap: Int,
  /// Number of attestations recorded so far (0 at genesis).
  attestation_epoch: Int,
  /// POSIX ms of the last attestation (genesis: the bootstrap tx's lower bound).
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
  Rotate { operators: List<ByteArray>, threshold: Int }
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

/// The ReserveState in an output's inline datum, if it has one.
fn reserve_datum(out: Output) -> Option<ReserveState> {
  when out.datum is {
    InlineDatum(d) ->
      if d is s: ReserveState {
        Some(s)
      } else {
        None
      }
    _ -> None
  }
}

/// The one genuine State among `outs`: the output carrying the thread token.
/// `None` unless exactly one output carries it AND it has a ReserveState
/// inline datum. A planted State-shaped UTxO without the token is ignored.
fn sole_state(
  outs: List<Output>,
  policy: PolicyId,
) -> Option<(Output, ReserveState)> {
  let marked =
    outs |> list.filter(fn(o) { quantity_of(o.value, policy, thread_name) > 0 })
  when marked is {
    [only] ->
      if quantity_of(only.value, policy, thread_name) == 1 {
        when reserve_datum(only) is {
          Some(s) -> Some((only, s))
          None -> None
        }
      } else {
        None
      }
    _ -> None
  }
}

/// At least `threshold` distinct members of `operators` signed the tx.
fn threshold_met(
  operators: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signers =
    operators
      |> list.filter(fn(op) { list.has(signatories, op) })
      |> list.unique
  list.length(signers) >= threshold
}

/// A usable committee: no duplicate keys, and `rules.min_threshold <=
/// threshold <= size` (so it is never empty and never a single key).
fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  threshold >= rules.min_threshold && threshold <= n && list.length(
    list.unique(operators),
  ) == n
}

/// The State output holds exactly ADA plus one thread token — nothing else,
/// not even TSRA (same policy), so nobody can attach junk tokens to inflate
/// min-ADA and strand funds.
fn state_value_ok(out: Output, policy: PolicyId) -> Bool {
  assets.without_lovelace(out.value) == thread_value(policy)
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
/// Any other name under the policy (including the thread token) is refused
/// here: the thread token is only ever minted by genesis, which spends no
/// State.
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

/// A valid genesis State: nothing minted, no attestation or transition yet,
/// non-negative reserve, a cap within the hard limit, a valid committee, and
/// an `attested_at` anchored to this transaction's validity lower bound
/// within a window of at most 1 day — so a genesis State cannot carry a
/// future-dated attestation that would never go stale.
fn genesis_ok(s: ReserveState, lo: Int, hi: Int) -> Bool {
  and {
    s.minted_supply == 0,
    s.attestation_epoch == 0,
    s.epoch == 0,
    s.attested_reserve >= 0,
    s.mint_cap >= 0,
    s.mint_cap <= rules.max_mint_cap,
    s.attested_at == lo,
    rules.window_ok(lo, hi, 0),
    operators_valid(s.operators, s.threshold),
  }
}

/// Genesis: the thread token is minted exactly once (the seed is consumed),
/// no State is spent alongside it, and the only output at this address is
/// the genesis State, holding exactly ADA + the token with a valid datum.
/// `state_value_ok` is an exact match, so it also proves the token went to
/// that output and nowhere else (only one is ever minted).
fn genesis(tx: Transaction, policy: PolicyId, seed: OutputReference) -> Bool {
  when (finite_bounds(tx), own_script_outputs(tx.outputs, policy)) is {
    (Some((lo, hi)), [boot]) ->
      when reserve_datum(boot) is {
        Some(s) ->
          and {
            one_shot_mint(tx, policy, seed),
            own_script_inputs(tx.inputs, policy) == [],
            state_value_ok(boot, policy),
            genesis_ok(s, lo, hi),
          }
        None -> False
      }
    _ -> False
  }
}

// ---------------------------------------------------------------- validator

validator reserve(seed: OutputReference) {
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
    expect Some((_, in_state)) = sole_state(ins, own_hash)
    expect Some((next_out, s1)) = sole_state(outs, own_hash)

    let structural =
      and {
        in_state == s0,
        operators_valid(s1.operators, s1.threshold),
        state_value_ok(next_out, own_hash),
      }

    let delta = tsra_delta(tx, own_hash)
    let signed = threshold_met(s0.operators, s0.threshold, tx.extra_signatories)

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
          mint_cap <= rules.max_mint_cap,
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

      // Committee rotation. The current committee authorises it; the new
      // committee must also meet its own threshold, so a rotation can never
      // hand the State to keys nobody controls. `structural` already
      // requires the new committee to be valid. Allowed while paused, so a
      // compromised key can be rotated out during an incident.
      Rotate { operators, threshold } ->
        and {
          structural,
          signed,
          threshold_met(operators, threshold, tx.extra_signatories),
          delta == 0,
          s1 == ReserveState {
            ..s0,
            operators: operators,
            threshold: threshold,
            epoch: s0.epoch + 1,
          },
        }
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    if dict.has_key(assets.tokens(tx.mint, policy_id), thread_name) {
      // Genesis: the only transaction that may mint the thread token.
      genesis(tx, policy_id, seed)
    } else {
      // TSRA may only move when the genuine State transitions in the same
      // tx; the spend handler then enforces the exact quantity and the rules.
      when sole_state(own_script_inputs(tx.inputs, policy_id), policy_id) is {
        Some(_) -> True
        None -> False
      }
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests


/// The seed UTxO the fixture reserve is parameterised by.
fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 3,
  }
}

const t_own: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_op3: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const t_op4: ByteArray =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

const t_op5: ByteArray =
  #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

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
      base |> assets.add(t_own, thread_name, 1)
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
  reserve.spend(t_seed(), Some(s0), Mint { qty: 100 }, ref0(), base_tx(s0, s1, 100))
}

test mint_above_attested_reserve_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 101 }, ref0(), base_tx(s0, s1, 101))
}

test mint_above_cap_is_rejected() {
  let s0 = t_state(0, 1_000, 100)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 101 }, ref0(), base_tx(s0, s1, 101))
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
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_with_unbounded_validity_is_rejected() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction { ..base_tx(s0, s1, 10), validity_range: interval.after(1_500_000) }
  reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_below_threshold_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op1] }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test mint_while_paused_is_rejected() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

test mint_delta_must_equal_redeemer_qty() {
  // datum and redeemer say 10, but the tx mints 20 TSRA
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 20))
}

test mint_cannot_sneak_in_a_different_field_change() {
  // raises the cap in the same transaction as a mint
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10, mint_cap: 9_999 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

test mint_replayed_epoch_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..s0, minted_supply: 10 }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), base_tx(s0, s1, 10))
}

// -- Authenticity of the State (the planted-State attack)

test planted_state_without_nft_cannot_mint() fail {
  // attacker's own State: huge reserve, own committee, NO state NFT
  let evil = ReserveState { ..t_state(0, 999_999_999, 999_999_999), operators: [t_op1, t_op3], threshold: 2 }
  let evil_next = ReserveState { ..next(evil), minted_supply: 500_000_000 }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [Input { output_reference: ref0(), output: state_out_with(evil, False) }],
      outputs: [state_out_with(evil_next, False)],
      mint: tsra(500_000_000),
      extra_signatories: [t_op1, t_op3],
      validity_range: interval.between(1_500_000, 2_000_000),
    }
  reserve.spend(t_seed(), Some(evil), Mint { qty: 500_000_000 }, ref0(), tx)
}

test planted_state_cannot_unlock_tsra_mint_handler() {
  let evil = t_state(0, 999_999_999, 999_999_999)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [Input { output_reference: ref0(), output: state_out_with(evil, False) }],
      mint: tsra(1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test mint_handler_accepts_when_genuine_state_is_spent() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  reserve.mint(t_seed(), Void, t_own, base_tx(s0, s1, 10))
}

test mint_handler_rejects_when_no_state_is_spent() {
  let tx = Transaction { ..transaction.placeholder, mint: tsra(10) }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test two_genuine_states_cannot_be_spent_together() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let second = Input { output_reference: ref1(), output: state_out(s0) }
  let tx = Transaction { ..base_tx(s0, s1, 10), inputs: [state_in(s0), second] }
  reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test state_output_may_not_carry_foreign_tokens() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let junk =
    Output {
      ..state_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, thread_name, 1)
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "junk", 1),
    }
  let tx = Transaction { ..base_tx(s0, s1, 10), outputs: [junk] }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

// -- Burn

test burn_needs_no_signature() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test burn_is_allowed_while_paused() {
  let s0 = ReserveState { ..t_state(100, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test burn_more_than_supply_is_rejected() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: -1 }
  let tx = Transaction { ..base_tx(s0, s1, -101), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(s0), Burn { qty: 101 }, ref0(), tx)
}

test burn_must_actually_burn() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
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
  reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
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
  reserve.spend(t_seed(), Some(s0), Attest { reserve: 40 }, ref0(), base_tx(s0, s1, 0))
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), tx)
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), tx)
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

// -- SetCap / SetPaused

test set_cap_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_mint_at_the_same_time() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50, minted_supply: 10 }
  !reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  reserve.spend(t_seed(), Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 0))
}

test pause_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !reserve.spend(t_seed(), Some(s0), SetPaused { paused: True }, ref0(), tx)
}

// -- Added by the mutation pass: each test below is the only one that fails
//    when a specific guard is deleted (see SPEC.md §6).

test set_cap_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: 50 }, ref0(), tx)
}

test a_zero_threshold_committee_cannot_act_unsigned() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), threshold: 0 }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
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
  reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
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
  reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
}

test a_state_holding_two_nfts_is_not_genuine() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let doubled =
    Output {
      ..state_out(s0),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, thread_name, 2),
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      inputs: [Input { output_reference: ref0(), output: doubled }],
    }
  reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test a_planted_input_beside_the_genuine_state_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let evil =
    ReserveState {
      ..s0,
      operators: [t_op1, t_op3],
      threshold: 2,
      attested_reserve: 999_999,
    }
  let s1 = ReserveState { ..next(evil), minted_supply: 10 }
  let planted =
    Input { output_reference: ref1(), output: state_out_with(evil, False) }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      inputs: [state_in(s0), planted],
      extra_signatories: [t_op1, t_op3],
    }
  !reserve.spend(t_seed(), Some(evil), Mint { qty: 10 }, ref1(), tx)
}

test burn_cannot_change_the_committee() {
  let s0 = t_state(100, 100, 1_000)
  let s1 =
    ReserveState {
      ..next(s0),
      minted_supply: 60,
      operators: [t_op3, t_op4],
      threshold: 2,
    }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(s0), Burn { qty: 40 }, ref0(), tx)
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_change_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50, operators: [t_op1, t_op3] }
  !reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test set_paused_cannot_change_the_reserve() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True, attested_reserve: 9_999 }
  !reserve.spend(t_seed(), Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 0))
}

test a_foreign_token_name_cannot_be_minted_under_the_tsra_policy() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 0), mint: assets.from_asset(t_own, "FAKE", 10) }
  reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
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
  reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), tx)
}

test burn_with_a_negative_qty_cannot_mint() {
  // Burn needs no signature, so a negative burn would be an unsigned,
  // uncapped mint if `qty > 0` were missing.
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 100 }
  let tx = Transaction { ..base_tx(s0, s1, 100), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(s0), Burn { qty: -100 }, ref0(), tx)
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: -1 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_negative_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: -1 }
  !reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: -1 }, ref0(), base_tx(s0, s1, 0))
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
  !reserve.spend(t_seed(), Some(s0), Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 10))
}

test set_cap_cannot_mint_with_an_exact_datum() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  !reserve.spend(t_seed(), Some(s0), SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  !reserve.spend(t_seed(), Some(s0), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 10))
}

// -- Genesis (Phase 2.2): the thread-token mint checks the genesis output

const t_boot_at: Int = 1_500_000

/// A valid genesis State: empty books, 2-of-2 committee, attested_at anchored
/// to the bootstrap tx's validity lower bound.
fn t_genesis() -> ReserveState {
  ReserveState {
    minted_supply: 0,
    attested_reserve: 0,
    mint_cap: 1_000,
    attestation_epoch: 0,
    attested_at: t_boot_at,
    epoch: 0,
    operators: [t_op1, t_op2],
    threshold: 2,
    paused: False,
  }
}

/// The wallet UTxO consumed as the seed.
fn seed_in() -> Input {
  Input {
    output_reference: t_seed(),
    output: Output {
      address: address.from_verification_key(t_op1),
      value: assets.from_lovelace(10_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// A bootstrap transaction: spends the seed, mints the thread token, and
/// pays the given outputs, inside a 1-hour window starting at `t_boot_at`.
fn boot_tx(outputs: List<Output>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [seed_in()],
    outputs: outputs,
    mint: thread_value(t_own),
    validity_range: interval.between(t_boot_at, t_boot_at + 3_600_000),
  }
}

fn boot(s: ReserveState) -> Bool {
  reserve.mint(t_seed(), Void, t_own, boot_tx([state_out(s)]))
}

test good_genesis_is_accepted() {
  boot(t_genesis())
}

test genesis_with_a_live_committee_and_reserve_is_accepted() {
  boot(
    ReserveState {
      ..t_genesis(),
      operators: [t_op1, t_op2, t_op3, t_op4, t_op5],
      threshold: 3,
      attested_reserve: 500,
      mint_cap: rules.max_mint_cap,
      paused: True,
    },
  )
}

test genesis_with_threshold_zero_is_rejected() {
  !boot(ReserveState { ..t_genesis(), threshold: 0 })
}

test genesis_with_a_single_key_threshold_is_rejected() {
  !boot(ReserveState { ..t_genesis(), threshold: 1 })
}

test genesis_with_threshold_above_committee_size_is_rejected() {
  !boot(ReserveState { ..t_genesis(), threshold: 3 })
}

test genesis_with_duplicate_operators_is_rejected() {
  !boot(ReserveState { ..t_genesis(), operators: [t_op1, t_op1, t_op2] })
}

test genesis_with_non_zero_supply_is_rejected() {
  !boot(ReserveState { ..t_genesis(), minted_supply: 1 })
}

test genesis_with_non_zero_attestation_epoch_is_rejected() {
  !boot(ReserveState { ..t_genesis(), attestation_epoch: 1 })
}

test genesis_with_non_zero_epoch_is_rejected() {
  !boot(ReserveState { ..t_genesis(), epoch: 1 })
}

test genesis_with_negative_reserve_is_rejected() {
  !boot(ReserveState { ..t_genesis(), attested_reserve: -1 })
}

test genesis_with_negative_cap_is_rejected() {
  !boot(ReserveState { ..t_genesis(), mint_cap: -1 })
}

test genesis_with_cap_above_the_hard_limit_is_rejected() {
  !boot(ReserveState { ..t_genesis(), mint_cap: rules.max_mint_cap + 1 })
}

test genesis_with_a_future_dated_attestation_is_rejected() {
  // would keep `rules.fresh` true for years without a real attestation
  !boot(ReserveState { ..t_genesis(), attested_at: t_boot_at + 10_000_000_000 })
}

test genesis_with_an_oversized_window_is_rejected() {
  let tx =
    Transaction {
      ..boot_tx([state_out(t_genesis())]),
      validity_range: interval.between(
        t_boot_at,
        t_boot_at + rules.max_attest_window + 1,
      ),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_without_a_validity_bound_is_rejected() {
  let tx =
    Transaction {
      ..boot_tx([state_out(t_genesis())]),
      validity_range: interval.after(t_boot_at),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_nft_sent_elsewhere_is_rejected() {
  let to_wallet =
    Output {
      address: address.from_verification_key(t_op1),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_own, thread_name, 1),
      datum: NoDatum,
      reference_script: None,
    }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([state_out_with(t_genesis(), False), to_wallet]),
  )
}

test genesis_with_no_reserve_output_is_rejected() {
  let to_wallet =
    Output {
      address: address.from_verification_key(t_op1),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_own, thread_name, 1),
      datum: NoDatum,
      reference_script: None,
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([to_wallet]))
}

test genesis_with_foreign_tokens_in_the_state_is_rejected() {
  let junk =
    Output {
      ..state_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, thread_name, 1)
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "junk", 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([junk]))
}

test genesis_state_cannot_hold_tsra() {
  // same policy as the thread token, so only an exact-value check catches it
  let with_tsra =
    Output {
      ..state_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, thread_name, 1)
        |> assets.add(t_own, rules.tsra_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([with_tsra]))
}

test genesis_with_two_outputs_at_the_reserve_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([state_out(t_genesis()), state_out_with(t_genesis(), False)]),
  )
}

test genesis_without_an_inline_reserve_datum_is_rejected() {
  let no_datum = Output { ..state_out(t_genesis()), datum: NoDatum }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([no_datum]))
}

test genesis_without_the_seed_is_rejected() {
  let other = Input { ..seed_in(), output_reference: ref1() }
  let tx = Transaction { ..boot_tx([state_out(t_genesis())]), inputs: [other] }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_cannot_spend_a_state_alongside() {
  let tx =
    Transaction {
      ..boot_tx([state_out(t_genesis())]),
      inputs: [seed_in(), state_in(t_genesis())],
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_mints_exactly_one_thread_token() {
  let tx =
    Transaction {
      ..boot_tx([state_out(t_genesis())]),
      mint: assets.from_asset(t_own, thread_name, 2),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_cannot_mint_tsra_at_the_same_time() {
  let tx =
    Transaction {
      ..boot_tx([state_out(t_genesis())]),
      mint: thread_value(t_own) |> assets.add(t_own, rules.tsra_name, 100),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test the_thread_token_can_never_be_burned() {
  // burning it would take the genuine State with it
  let s0 = t_state(0, 100, 1_000)
  let s1 = next(s0)
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      mint: assets.from_asset(t_own, thread_name, -1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

// -- Committee rotation (Phase 2.2)

/// s0 has committee {op1, op2} 2-of-2; rotate to {op3, op4, op5} 2-of-3.
fn rotated(s0: ReserveState) -> ReserveState {
  ReserveState {
    ..next(s0),
    operators: [t_op3, t_op4, t_op5],
    threshold: 2,
  }
}

const new_committee: List<ByteArray> = [t_op3, t_op4, t_op5]

fn rotate_tx(
  s0: ReserveState,
  s1: ReserveState,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction { ..base_tx(s0, s1, 0), extra_signatories: signers }
}

fn rotate(
  s0: ReserveState,
  s1: ReserveState,
  ops: List<ByteArray>,
  thr: Int,
  signers: List<ByteArray>,
) -> Bool {
  reserve.spend(
    t_seed(),
    Some(s0),
    Rotate { operators: ops, threshold: thr },
    ref0(),
    rotate_tx(s0, s1, signers),
  )
}

test rotation_by_both_committees_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  rotate(s0, rotated(s0), new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_is_allowed_while_paused() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), paused: True }
  rotate(s0, rotated(s0), new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_below_the_current_threshold_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !rotate(s0, rotated(s0), new_committee, 2, [t_op1, t_op3, t_op4])
}

test rotation_the_new_committee_did_not_sign_is_rejected() {
  // guards against rotating to keys nobody controls
  let s0 = t_state(0, 100, 1_000)
  !rotate(s0, rotated(s0), new_committee, 2, [t_op1, t_op2, t_op3])
}

test rotation_to_a_single_key_committee_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: [t_op3], threshold: 1 }
  !rotate(s0, s1, [t_op3], 1, [t_op1, t_op2, t_op3])
}

test rotation_to_a_threshold_above_size_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: [t_op3, t_op4], threshold: 3 }
  !rotate(s0, s1, [t_op3, t_op4], 3, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_to_duplicate_keys_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: [t_op3, t_op3], threshold: 2 }
  !rotate(s0, s1, [t_op3, t_op3], 2, [t_op1, t_op2, t_op3])
}

test rotation_to_an_empty_committee_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: [], threshold: 0 }
  !rotate(s0, s1, [], 0, [t_op1, t_op2])
}

test rotation_datum_must_match_the_redeemer() {
  // redeemer says {op3, op4, op5}, datum installs {op3, op4}
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: [t_op3, t_op4], threshold: 2 }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_cannot_touch_the_reserve() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..rotated(s0), attested_reserve: 9_999 }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_cannot_touch_the_cap() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..rotated(s0), mint_cap: 9_999 }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_cannot_touch_the_supply() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..rotated(s0), minted_supply: 50 }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_cannot_touch_the_pause_flag() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), paused: True }
  let s1 = ReserveState { ..rotated(s0), paused: False }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_must_bump_the_epoch() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..rotated(s0), epoch: s0.epoch }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4])
}

test rotation_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..base_tx(s0, rotated(s0), 10),
      extra_signatories: [t_op1, t_op2, t_op3, t_op4],
    }
  !reserve.spend(
    t_seed(),
    Some(s0),
    Rotate { operators: new_committee, threshold: 2 },
    ref0(),
    tx,
  )
}

test after_rotation_the_new_committee_can_mint() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op3, t_op5] }
  reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_mint() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op1, t_op2] }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_rotate_back() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), operators: [t_op1, t_op2], threshold: 2 }
  !rotate(s0, s1, [t_op1, t_op2], 2, [t_op1, t_op2])
}

test after_rotation_the_new_committee_can_pause() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op4, t_op5] }
  reserve.spend(t_seed(), Some(s0), SetPaused { paused: True }, ref0(), tx)
}

test set_cap_above_the_hard_limit_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: rules.max_mint_cap + 1 }
  !reserve.spend(
    t_seed(),
    Some(s0),
    SetCap { mint_cap: rules.max_mint_cap + 1 },
    ref0(),
    base_tx(s0, s1, 0),
  )
}

test set_cap_at_the_hard_limit_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: rules.max_mint_cap }
  reserve.spend(
    t_seed(),
    Some(s0),
    SetCap { mint_cap: rules.max_mint_cap },
    ref0(),
    base_tx(s0, s1, 0),
  )
}

test the_state_cannot_hold_tsra() {
  // same policy as the thread token: only the exact-value check catches it
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let parked =
    Output {
      ..state_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, thread_name, 1)
        |> assets.add(t_own, rules.tsra_name, 10),
    }
  let tx = Transaction { ..base_tx(s0, s1, 10), outputs: [parked] }
  !reserve.spend(t_seed(), Some(s0), Mint { qty: 10 }, ref0(), tx)
}

test genesis_without_a_validity_bound_is_rejected_even_at_time_zero() {
  // an unbounded genesis must fail outright, not just when attested_at != 0
  let tx =
    Transaction {
      ..boot_tx([state_out(ReserveState { ..t_genesis(), attested_at: 0 })]),
      validity_range: interval.everything,
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test rotation_datum_threshold_must_match_the_redeemer() {
  // the new committee signs for 2-of-3 but the datum would install 3-of-3
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..rotated(s0), threshold: 3 }
  !rotate(s0, s1, new_committee, 2, [t_op1, t_op2, t_op3, t_op4, t_op5])
}
