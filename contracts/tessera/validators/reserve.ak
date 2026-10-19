//// Tessera Reserve State — the on-chain gate for minting and burning TSRA.
////
//// Two UTxOs at this script's address, each identified by a one-shot thread
//// token under this script's policy (Phase 2.5a split of the single State):
////
////   * Config (`config` token): committee, threshold, `paused`, the three KYC
////     switches and the eligibility policy. Changes only by committee action.
////     Exits, stakes and the eligibility registry read it by reference.
////   * Supply (`supply` token): `minted_supply`, `attested_reserve`,
////     `mint_cap` and the attestation anchor. Spent by every mint, burn,
////     attestation and cap change; reads the Config by reference.
////
//// This script is the spending validator for both AND the minting policy for
//// TSRA and for both thread tokens (policy id = script hash), so TSRA can only
//// move in a transaction that also transitions the Supply.
////
//// Genesis (Phase 2.2, two tokens since 2.5a): the script is parameterised by
//// a `seed` UTxO and mints both thread tokens itself, once, in one
//// transaction that consumes the seed. The mint checks the genesis outputs
//// on-chain — exactly two outputs at this address, a Config and a Supply,
//// each holding only ADA and its own token, with valid empty datums. Outside
//// genesis the mint handler refuses ANY mint or burn of either thread token.
////
//// Rules (see ../SPEC.md):
////   * Mint: committee M-of-N (from the Config), not paused, supply stays <=
////     min(attested reserve, mint cap), and the attestation is fresh (<= 7
////     days old for the whole validity range of the transaction).
////   * Burn: no signature and no pause check. Anyone holding TSRA can always
////     burn it; the Supply just has to record it. (Throughput note: every
////     burn spends the single Supply UTxO, so burns serialise. The redemption
////     queue batches many burns into one transaction for that reason.)
////   * Attest / SetCap: committee M-of-N (from the Config).
////   * SetPaused / SetKyc: committee M-of-N, spend the Config.
////   * Rotate: the current committee M-of-N AND the new committee M-of-N;
////     only `operators`, `threshold` and `epoch` change. Spends the Config.
////   * Eligibility (Phase 2.3): when `kyc_mint` / `kyc_redeem` is on, Mint /
////     Burn also need `tessera/eligibility.eligible` for the redeemer's
////     `holder`.
////   * Every transition spends exactly one token-bearing UTxO of its kind and
////     returns exactly one, never touching the other kind (the V-01 lesson).
////     The next datum equals the expected datum EXACTLY (so no field can
////     change unless that redeemer says it may), the kind's epoch + 1, and
////     the output holds only ADA plus its thread token. A Supply transition
////     also needs the genuine Config as a reference input; a Config or Supply
////     datum can never be read as the other (distinct constructors).
////
//// Not yet supported: a reserve asset on-chain (the reserve is off-chain and
//// attested; decision 4 in DESIGN.md §7 is open pending counsel). The datums
//// are PROVISIONAL until counsel answers.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use stellaris/outputs.{continuing_ok, genesis_out_ok, keeps_lovelace}
use tessera/eligibility.{eligible}
use tessera/reserve_ref.{genuine_config}
use tessera/reserve_state.{
  ConfigDatum, ConfigState, ReserveDatum, SupplyDatum, SupplyState,
  operators_valid, threshold_met,
}
use tessera/reserve_threads.{
  config_name, config_value, supply_name, supply_value,
}
use tessera/rules

// ---------------------------------------------------------------- datum

// `ConfigState` / `SupplyState` (PROVISIONAL) and the committee rules live in
// `lib/tessera/reserve_state.ak`, shared with `validators/eligibility.ak`.

/// `holder` on Mint / Burn is the party whose eligibility is checked when the
/// matching KYC switch is on; it is ignored while the switch is off.
/// Mint, Burn, Attest and SetCap spend the Supply; SetPaused, SetKyc and
/// Rotate spend the Config. A redeemer used on the other kind's datum fails.
pub type ReserveRedeemer {
  Mint { qty: Int, holder: ByteArray }
  Burn { qty: Int, holder: ByteArray }
  Attest { reserve: Int }
  SetCap { mint_cap: Int }
  SetPaused { paused: Bool }
  Rotate { operators: List<ByteArray>, threshold: Int }
  SetKyc {
    kyc_mint: Bool,
    kyc_redeem: Bool,
    kyc_stake: Bool,
    eligibility_policy: PolicyId,
  }
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

/// The ReserveDatum in an output's inline datum, if it has one.
fn reserve_datum(out: Output) -> Option<ReserveDatum> {
  when out.datum is {
    InlineDatum(d) ->
      if d is r: ReserveDatum {
        Some(r)
      } else {
        None
      }
    _ -> None
  }
}

/// The one output among `outs` carrying thread token `name`: `None` unless
/// exactly one output carries any of it and it carries exactly one.
fn sole_marked(outs: List<Output>, policy: PolicyId, name: ByteArray) -> Option<Output> {
  let marked = outs |> list.filter(fn(o) { quantity_of(o.value, policy, name) > 0 })
  when marked is {
    [only] ->
      if quantity_of(only.value, policy, name) == 1 {
        Some(only)
      } else {
        None
      }
    _ -> None
  }
}

/// The one genuine Config among `outs`: the output carrying the `config`
/// token AND a `ConfigDatum`. A planted Config-shaped UTxO without the token
/// is ignored; a Supply datum under the `config` token is not a Config.
fn sole_config(outs: List<Output>, policy: PolicyId) -> Option<(Output, ConfigState)> {
  when sole_marked(outs, policy, config_name) is {
    Some(o) ->
      when reserve_datum(o) is {
        Some(ConfigDatum(c)) -> Some((o, c))
        _ -> None
      }
    None -> None
  }
}

/// The one genuine Supply among `outs`: `supply` token AND a `SupplyDatum`.
fn sole_supply(outs: List<Output>, policy: PolicyId) -> Option<(Output, SupplyState)> {
  when sole_marked(outs, policy, supply_name) is {
    Some(o) ->
      when reserve_datum(o) is {
        Some(SupplyDatum(s)) -> Some((o, s))
        _ -> None
      }
    None -> None
  }
}

/// No output in `os` carries any of thread token `name`.
fn untouched(os: List<Output>, policy: PolicyId, name: ByteArray) -> Bool {
  os |> list.all(fn(o) { quantity_of(o.value, policy, name) == 0 })
}

/// A Config output holds exactly ADA plus one `config` token — nothing else,
/// not even TSRA (same policy), so nobody can attach junk tokens to inflate
/// min-ADA and strand funds.
fn config_value_ok(out: Output, policy: PolicyId) -> Bool {
  assets.without_lovelace(out.value) == config_value(policy)
}

/// A Supply output holds exactly ADA plus one `supply` token.
fn supply_value_ok(out: Output, policy: PolicyId) -> Bool {
  assets.without_lovelace(out.value) == supply_value(policy)
}

/// An action's eligibility gate: open while its switch is off, otherwise the
/// one eligibility check (`tessera/eligibility.eligible`) for `holder`.
fn kyc_ok(
  switch_on: Bool,
  tx: Transaction,
  policy: PolicyId,
  holder: ByteArray,
) -> Bool {
  !switch_on || eligible(tx, policy, holder)
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
/// Any other name under the policy (including the thread tokens) is refused
/// here: the thread tokens are only ever minted by genesis, which spends no
/// Config or Supply.
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

/// A valid genesis Supply: nothing minted, no attestation or transition yet,
/// non-negative reserve, a cap within the hard limit, and an `attested_at`
/// anchored to this transaction's validity lower bound within a window of at
/// most 1 day — so a genesis Supply cannot carry a future-dated attestation
/// that would never go stale.
fn genesis_supply_ok(s: SupplyState, lo: Int, hi: Int) -> Bool {
  and {
    s.minted_supply == 0,
    s.attestation_epoch == 0,
    s.epoch == 0,
    s.attested_reserve >= 0,
    s.mint_cap >= 0,
    s.mint_cap <= rules.max_mint_cap,
    s.attested_at == lo,
    rules.window_ok(lo, hi, 0),
  }
}

/// A valid genesis Config: a valid committee, a policy-id-sized eligibility
/// policy and no transition yet.
fn genesis_config_ok(c: ConfigState) -> Bool {
  and {
    c.epoch == 0,
    operators_valid(c.operators, c.threshold),
    bytearray.length(c.eligibility_policy) == 28,
  }
}

/// This transaction mints exactly one `config` and one `supply` token under
/// `policy` and nothing else, and consumes `seed` — so the pair can be minted
/// at most once, ever. Burning (a negative quantity) never satisfies it.
fn genesis_mint_ok(
  tx: Transaction,
  policy: PolicyId,
  seed: OutputReference,
) -> Bool {
  and {
    list.length(dict.to_pairs(assets.tokens(tx.mint, policy))) == 2,
    quantity_of(tx.mint, policy, config_name) == 1,
    quantity_of(tx.mint, policy, supply_name) == 1,
    list.any(tx.inputs, fn(i) { i.output_reference == seed }),
  }
}

/// Genesis: both thread tokens are minted exactly once (the seed is consumed),
/// no Config or Supply is spent alongside it, and the only outputs at this
/// address are the genesis Config and Supply, each holding exactly ADA + its
/// token with a valid datum, at the script's enterprise address with no
/// reference script (F-6). The exact-value checks also prove each token went
/// to its own output and nowhere else (only one of each is ever minted).
fn genesis(tx: Transaction, policy: PolicyId, seed: OutputReference) -> Bool {
  when (finite_bounds(tx), own_script_outputs(tx.outputs, policy)) is {
    (Some((lo, hi)), outs) ->
      when (sole_config(outs, policy), sole_supply(outs, policy)) is {
        (Some((cfg_out, c)), Some((sup_out, s))) ->
          and {
            list.length(outs) == 2,
            genesis_mint_ok(tx, policy, seed),
            own_script_inputs(tx.inputs, policy) == [],
            genesis_out_ok(cfg_out, policy),
            genesis_out_ok(sup_out, policy),
            config_value_ok(cfg_out, policy),
            supply_value_ok(sup_out, policy),
            genesis_config_ok(c),
            genesis_supply_ok(s, lo, hi),
          }
        _ -> False
      }
    _ -> False
  }
}

// ---------------------------------------------------------------- transitions

/// A Supply transition (Mint, Burn, Attest, SetCap): one genuine Supply in and
/// out, the genuine Config as a reference input (committee, `paused`, KYC),
/// and the Config not touched.
fn supply_step(
  s0: SupplyState,
  redeemer: ReserveRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  expect Some(own_input) =
    tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
  expect Script(own_hash) = own_input.output.address.payment_credential

  let ins = own_script_inputs(tx.inputs, own_hash)
  let outs = own_script_outputs(tx.outputs, own_hash)

  // V-01 from day one: exactly one genuine Supply on BOTH sides, and the
  // input being spent is that Supply (not a planted lookalike).
  expect Some((supply_in, in_supply)) = sole_supply(ins, own_hash)
  expect Some((next_out, s1)) = sole_supply(outs, own_hash)
  // The committee and the switches come from the genuine Config, by reference.
  expect Some(cfg) = genuine_config(tx, own_hash)

  // F-6: the Supply keeps its exact address, carries no reference script and
  // never loses lovelace (no redeemer pays ADA out of the Supply).
  let structural =
    and {
      in_supply == s0,
      operators_valid(cfg.operators, cfg.threshold),
      untouched(ins, own_hash, config_name),
      untouched(outs, own_hash, config_name),
      supply_value_ok(next_out, own_hash),
      continuing_ok(next_out, supply_in),
      keeps_lovelace(next_out, supply_in),
    }

  let delta = tsra_delta(tx, own_hash)
  let signed = threshold_met(cfg.operators, cfg.threshold, tx.extra_signatories)

  when redeemer is {
    Mint { qty, holder } -> {
      expect Some((_lo, hi)) = finite_bounds(tx)
      and {
        structural,
        !cfg.paused,
        signed,
        kyc_ok(cfg.kyc_mint, tx, cfg.eligibility_policy, holder),
        rules.mint_allowed(
          s0.minted_supply,
          qty,
          s0.attested_reserve,
          s0.mint_cap,
        ),
        rules.fresh(hi, s0.attested_at),
        delta == qty,
        s1 == SupplyState {
          ..s0,
          minted_supply: s0.minted_supply + qty,
          epoch: s0.epoch + 1,
        },
      }
    }

    // Bearer: no committee signature, and allowed while paused. With
    // `kyc_redeem` on, the burner must pass the eligibility check.
    Burn { qty, holder } ->
      and {
        structural,
        kyc_ok(cfg.kyc_redeem, tx, cfg.eligibility_policy, holder),
        qty > 0,
        qty <= s0.minted_supply,
        delta == -qty,
        s1 == SupplyState {
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
        s1 == SupplyState {
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
        s1 == SupplyState { ..s0, mint_cap: mint_cap, epoch: s0.epoch + 1 },
      }

    // A Config redeemer on a Supply datum.
    _ -> False
  }
}

/// A Config transition (SetPaused, SetKyc, Rotate): one genuine Config in and
/// out, and the Supply not touched.
fn config_step(
  c0: ConfigState,
  redeemer: ReserveRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  expect Some(own_input) =
    tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
  expect Script(own_hash) = own_input.output.address.payment_credential

  let ins = own_script_inputs(tx.inputs, own_hash)
  let outs = own_script_outputs(tx.outputs, own_hash)

  expect Some((config_in, in_config)) = sole_config(ins, own_hash)
  expect Some((next_out, c1)) = sole_config(outs, own_hash)

  let structural =
    and {
      in_config == c0,
      operators_valid(c1.operators, c1.threshold),
      untouched(ins, own_hash, supply_name),
      untouched(outs, own_hash, supply_name),
      config_value_ok(next_out, own_hash),
      continuing_ok(next_out, config_in),
      keeps_lovelace(next_out, config_in),
    }

  let delta = tsra_delta(tx, own_hash)
  let signed = threshold_met(c0.operators, c0.threshold, tx.extra_signatories)

  when redeemer is {
    SetPaused { paused } ->
      and {
        structural,
        signed,
        delta == 0,
        c1 == ConfigState { ..c0, paused: paused, epoch: c0.epoch + 1 },
      }

    // KYC switches and the eligibility policy: committee only, the policy
    // must be a policy id, nothing else changes. Repointing the policy is
    // how a Midnight-issued credential plugs in without a new reserve.
    SetKyc { kyc_mint, kyc_redeem, kyc_stake, eligibility_policy } ->
      and {
        structural,
        signed,
        bytearray.length(eligibility_policy) == 28,
        delta == 0,
        c1 == ConfigState {
          ..c0,
          kyc_mint: kyc_mint,
          kyc_redeem: kyc_redeem,
          kyc_stake: kyc_stake,
          eligibility_policy: eligibility_policy,
          epoch: c0.epoch + 1,
        },
      }

    // Committee rotation. The current committee authorises it; the new
    // committee must also meet its own threshold, so a rotation can never
    // hand the Config to keys nobody controls. `structural` already requires
    // the new committee to be valid. Allowed while paused, so a compromised
    // key can be rotated out during an incident.
    Rotate { operators, threshold } ->
      and {
        structural,
        signed,
        threshold_met(operators, threshold, tx.extra_signatories),
        delta == 0,
        c1 == ConfigState {
          ..c0,
          operators: operators,
          threshold: threshold,
          epoch: c0.epoch + 1,
        },
      }

    // A Supply redeemer on a Config datum.
    _ -> False
  }
}

// ---------------------------------------------------------------- validator

validator reserve(seed: OutputReference) {
  spend(
    datum: Option<ReserveDatum>,
    redeemer: ReserveRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    when d is {
      SupplyDatum(s0) -> supply_step(s0, redeemer, own_ref, tx)
      ConfigDatum(c0) -> config_step(c0, redeemer, own_ref, tx)
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let minted = assets.tokens(tx.mint, policy_id)
    if dict.has_key(minted, config_name) || dict.has_key(minted, supply_name) {
      // Genesis: the only transaction that may mint either thread token, and
      // it must mint exactly one of each. Any other mint or burn of
      // `config` / `supply` lands here and fails the exact check.
      genesis(tx, policy_id, seed)
    } else {
      // TSRA may only move when the genuine Supply transitions in the same
      // tx; the spend handler then enforces the exact quantity and the rules.
      when sole_supply(own_script_inputs(tx.inputs, policy_id), policy_id) is {
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

/// Eligibility policy the fixture State points at, and a holder key hash.
const t_elig: ByteArray =
  #"77777777777777777777777777777777777777777777777777777777"

const t_holder: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

/// Test-only combined view of the pre-split State. The 2.2/2.3 tests keep
/// their meaning by reading and writing this one record; `cfg_of` / `sup_of`
/// project it onto the two UTxOs the validator actually sees.
type ReserveState {
  minted_supply: Int,
  attested_reserve: Int,
  mint_cap: Int,
  attestation_epoch: Int,
  attested_at: Int,
  epoch: Int,
  operators: List<ByteArray>,
  threshold: Int,
  paused: Bool,
  kyc_mint: Bool,
  kyc_redeem: Bool,
  kyc_stake: Bool,
  eligibility_policy: ByteArray,
}

fn cfg_of(s: ReserveState) -> ConfigState {
  ConfigState {
    operators: s.operators,
    threshold: s.threshold,
    paused: s.paused,
    kyc_mint: s.kyc_mint,
    kyc_redeem: s.kyc_redeem,
    kyc_stake: s.kyc_stake,
    eligibility_policy: s.eligibility_policy,
    epoch: s.epoch,
  }
}

fn sup_of(s: ReserveState) -> SupplyState {
  SupplyState {
    minted_supply: s.minted_supply,
    attested_reserve: s.attested_reserve,
    mint_cap: s.mint_cap,
    attestation_epoch: s.attestation_epoch,
    attested_at: s.attested_at,
    epoch: s.epoch,
  }
}

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
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: t_elig,
  }
}

fn t_addr() -> Address {
  Address { payment_credential: Script(t_own), stake_credential: None }
}

/// The Supply UTxO (`supply` token unless `with_token` is off).
fn state_out_with(s: ReserveState, with_token: Bool) -> Output {
  let base = assets.from_lovelace(2_000_000)
  Output {
    address: t_addr(),
    value: if with_token {
      base |> assets.add(t_own, supply_name, 1)
    } else {
      base
    },
    datum: InlineDatum(SupplyDatum(sup_of(s))),
    reference_script: None,
  }
}

fn state_out(s: ReserveState) -> Output {
  state_out_with(s, True)
}

/// The Config UTxO (`config` token unless `with_token` is off).
fn config_out_with(s: ReserveState, with_token: Bool) -> Output {
  let base = assets.from_lovelace(2_000_000)
  Output {
    address: t_addr(),
    value: if with_token {
      base |> assets.add(t_own, config_name, 1)
    } else {
      base
    },
    datum: InlineDatum(ConfigDatum(cfg_of(s))),
    reference_script: None,
  }
}

fn config_out(s: ReserveState) -> Output {
  config_out_with(s, True)
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

/// Where the Config reference input sits.
fn ref9() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 9,
  }
}

fn state_in(s: ReserveState) -> Input {
  Input { output_reference: ref0(), output: state_out(s) }
}

fn config_in(s: ReserveState) -> Input {
  Input { output_reference: ref0(), output: config_out(s) }
}

/// The genuine Config as a reference input (the committee, `paused` and the
/// KYC switches of `s`).
fn config_ref(s: ReserveState) -> Input {
  Input { output_reference: ref9(), output: config_out(s) }
}

fn tsra(qty: Int) -> assets.Value {
  assets.from_asset(t_own, rules.tsra_name, qty)
}

/// A well-formed Supply transaction: spends the Supply, references the Config
/// of `s0`, both operators sign, finite validity range well inside the
/// attestation's freshness window.
fn base_tx(s0: ReserveState, s1: ReserveState, delta: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [state_in(s0)],
    reference_inputs: [config_ref(s0)],
    outputs: [state_out(s1)],
    mint: tsra(delta),
    extra_signatories: [t_op1, t_op2],
    validity_range: interval.between(1_500_000, 2_000_000),
  }
}

/// A well-formed Config transaction: spends the Config, no reference inputs.
fn cfg_tx(s0: ReserveState, s1: ReserveState, delta: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [config_in(s0)],
    outputs: [config_out(s1)],
    mint: tsra(delta),
    extra_signatories: [t_op1, t_op2],
    validity_range: interval.between(1_500_000, 2_000_000),
  }
}

fn next(s: ReserveState) -> ReserveState {
  ReserveState { ..s, epoch: s.epoch + 1 }
}

/// Run the spend handler against the datum kind the redeemer belongs to.
fn run(
  s0: ReserveState,
  rd: ReserveRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  let datum =
    when rd is {
      SetPaused { .. } -> ConfigDatum(cfg_of(s0))
      SetKyc { .. } -> ConfigDatum(cfg_of(s0))
      Rotate { .. } -> ConfigDatum(cfg_of(s0))
      _ -> SupplyDatum(sup_of(s0))
    }
  reserve.spend(t_seed(), Some(datum), rd, own_ref, tx)
}

/// `tx` plus the Supply of `s0` spent (at `ref1`) and `s1` returned: a
/// Config transition dragging the Supply along.
fn alongside_supply(tx: Transaction, s0: ReserveState, s1: ReserveState) -> Transaction {
  Transaction {
    ..tx,
    inputs: list.concat(tx.inputs, [Input { output_reference: ref1(), output: state_out(s0) }]),
    outputs: list.concat(tx.outputs, [state_out(s1)]),
  }
}

/// `tx` plus the Config of `s0` spent (at `ref1`) and `s1` returned: a
/// Supply transition dragging the Config along.
fn alongside_config(tx: Transaction, s0: ReserveState, s1: ReserveState) -> Transaction {
  Transaction {
    ..tx,
    inputs: list.concat(tx.inputs, [Input { output_reference: ref1(), output: config_out(s0) }]),
    outputs: list.concat(tx.outputs, [config_out(s1)]),
  }
}

// -- Mint

test mint_within_reserve_and_cap_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 100 }
  run(s0, Mint { qty: 100, holder: t_holder }, ref0(), base_tx(s0, s1, 100))
}

test mint_above_attested_reserve_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !run(s0, Mint { qty: 101, holder: t_holder }, ref0(), base_tx(s0, s1, 101))
}

test mint_above_cap_is_rejected() {
  let s0 = t_state(0, 1_000, 100)
  let s1 = ReserveState { ..next(s0), minted_supply: 101 }
  !run(s0, Mint { qty: 101, holder: t_holder }, ref0(), base_tx(s0, s1, 101))
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
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test mint_with_unbounded_validity_is_rejected() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction { ..base_tx(s0, s1, 10), validity_range: interval.after(1_500_000) }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test mint_below_threshold_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op1] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test mint_while_paused_is_rejected() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), base_tx(s0, s1, 10))
}

test mint_delta_must_equal_redeemer_qty() {
  // datum and redeemer say 10, but the tx mints 20 TSRA
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), base_tx(s0, s1, 20))
}

test mint_cannot_sneak_in_a_different_field_change() {
  // raises the cap in the same transaction as a mint
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10, mint_cap: 9_999 }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), base_tx(s0, s1, 10))
}

test mint_replayed_epoch_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..s0, minted_supply: 10 }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), base_tx(s0, s1, 10))
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
  run(evil, Mint { qty: 500_000_000, holder: t_holder }, ref0(), tx)
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
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test state_output_may_not_carry_foreign_tokens() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let junk =
    Output {
      ..state_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, supply_name, 1)
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "junk", 1),
    }
  let tx = Transaction { ..base_tx(s0, s1, 10), outputs: [junk] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

// -- Burn

test burn_needs_no_signature() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test burn_is_allowed_while_paused() {
  let s0 = ReserveState { ..t_state(100, 100, 1_000), paused: True }
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test burn_more_than_supply_is_rejected() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: -1 }
  let tx = Transaction { ..base_tx(s0, s1, -101), extra_signatories: [] }
  !run(s0, Burn { qty: 101, holder: t_holder }, ref0(), tx)
}

test burn_must_actually_burn() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [] }
  !run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
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
  run(s0, Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
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
  run(s0, Attest { reserve: 40 }, ref0(), base_tx(s0, s1, 0))
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
  !run(s0, Attest { reserve: 250 }, ref0(), tx)
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
  !run(s0, Attest { reserve: 250 }, ref0(), tx)
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
  !run(s0, Attest { reserve: 250 }, ref0(), tx)
}

// -- SetCap / SetPaused

test set_cap_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  run(s0, SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_mint_at_the_same_time() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50, minted_supply: 10 }
  !run(s0, SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_by_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  run(s0, SetPaused { paused: True }, ref0(), cfg_tx(s0, s1, 0))
}

test pause_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = Transaction { ..cfg_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !run(s0, SetPaused { paused: True }, ref0(), tx)
}

// -- Added by the mutation pass: each test below is the only one that fails
//    when a specific guard is deleted (see SPEC.md §6).

test set_cap_needs_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1] }
  !run(s0, SetCap { mint_cap: 50 }, ref0(), tx)
}

test a_zero_threshold_committee_cannot_act_unsigned() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), threshold: 0 }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
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
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
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
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test a_state_holding_two_nfts_is_not_genuine() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let doubled =
    Output {
      ..state_out(s0),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, supply_name, 2),
    }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      inputs: [Input { output_reference: ref0(), output: doubled }],
    }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
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
  !run(evil, Mint { qty: 10, holder: t_holder }, ref1(), tx)
}

test burn_cannot_also_spend_the_config() {
  // pre-split: a burn that rewrote the committee. Now the committee lives in
  // the Config, so the attack is a burn that spends and replaces it.
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let evil = ReserveState { ..next(s0), operators: [t_op3, t_op4], threshold: 2 }
  let tx =
    Transaction {
      ..alongside_config(base_tx(s0, s1, -40), s0, evil),
      extra_signatories: [],
    }
  !run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
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
  !run(s0, Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
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
  !run(s0, Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_cannot_also_spend_the_config() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  let evil = ReserveState { ..next(s0), operators: [t_op1, t_op3] }
  !run(s0, SetCap { mint_cap: 50 }, ref0(), alongside_config(base_tx(s0, s1, 0), s0, evil))
}

test set_paused_cannot_also_spend_the_supply() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let moved = ReserveState { ..next(s0), attested_reserve: 9_999 }
  !run(s0, SetPaused { paused: True }, ref0(), alongside_supply(cfg_tx(s0, s1, 0), s0, moved))
}

test a_foreign_token_name_cannot_be_minted_under_the_tsra_policy() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 0), mint: assets.from_asset(t_own, "FAKE", 10) }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
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
  run(s0, Attest { reserve: 250 }, ref0(), tx)
}

test burn_with_a_negative_qty_cannot_mint() {
  // Burn needs no signature, so a negative burn would be an unsigned,
  // uncapped mint if `qty > 0` were missing.
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 100 }
  let tx = Transaction { ..base_tx(s0, s1, 100), extra_signatories: [] }
  !run(s0, Burn { qty: -100, holder: t_holder }, ref0(), tx)
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
  !run(s0, Attest { reserve: -1 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_negative_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: -1 }
  !run(s0, SetCap { mint_cap: -1 }, ref0(), base_tx(s0, s1, 0))
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
  !run(s0, Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 10))
}

test set_cap_cannot_mint_with_an_exact_datum() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  !run(s0, SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 10))
}

test pause_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  !run(s0, SetPaused { paused: True }, ref0(), cfg_tx(s0, s1, 10))
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
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: t_elig,
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

/// The two genesis outputs for `s`: the Config, then the Supply.
fn genesis_outs(s: ReserveState) -> List<Output> {
  [config_out(s), state_out(s)]
}

/// The mint of both thread tokens.
fn thread_pair() -> assets.Value {
  config_value(t_own) |> assets.merge(supply_value(t_own))
}

/// A bootstrap transaction: spends the seed, mints both thread tokens, and
/// pays the given outputs, inside a 1-hour window starting at `t_boot_at`.
fn boot_tx(outputs: List<Output>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [seed_in()],
    outputs: outputs,
    mint: thread_pair(),
    validity_range: interval.between(t_boot_at, t_boot_at + 3_600_000),
  }
}

fn boot(s: ReserveState) -> Bool {
  reserve.mint(t_seed(), Void, t_own, boot_tx(genesis_outs(s)))
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
      ..boot_tx(genesis_outs(t_genesis())),
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
      ..boot_tx(genesis_outs(t_genesis())),
      validity_range: interval.after(t_boot_at),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

/// An output at a wallet holding the given thread token (no datum).
fn token_at_wallet(name: ByteArray) -> Output {
  Output {
    address: address.from_verification_key(t_op1),
    value: assets.from_lovelace(2_000_000) |> assets.add(t_own, name, 1),
    datum: NoDatum,
    reference_script: None,
  }
}

const t_junk_policy: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

test genesis_supply_token_sent_elsewhere_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx(
      [
        config_out(t_genesis()),
        state_out_with(t_genesis(), False),
        token_at_wallet(supply_name),
      ],
    ),
  )
}

test genesis_config_token_sent_elsewhere_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx(
      [
        config_out_with(t_genesis(), False),
        state_out(t_genesis()),
        token_at_wallet(config_name),
      ],
    ),
  )
}

test genesis_with_no_reserve_output_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([token_at_wallet(supply_name), token_at_wallet(config_name)]),
  )
}

test genesis_with_only_a_config_output_is_rejected() {
  !reserve.mint(t_seed(), Void, t_own, boot_tx([config_out(t_genesis())]))
}

test genesis_with_only_a_supply_output_is_rejected() {
  !reserve.mint(t_seed(), Void, t_own, boot_tx([state_out(t_genesis())]))
}

test genesis_with_foreign_tokens_in_the_supply_is_rejected() {
  let junk =
    Output {
      ..state_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, supply_name, 1)
        |> assets.add(t_junk_policy, "junk", 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([config_out(t_genesis()), junk]))
}

test genesis_with_foreign_tokens_in_the_config_is_rejected() {
  let junk =
    Output {
      ..config_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, config_name, 1)
        |> assets.add(t_junk_policy, "junk", 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([junk, state_out(t_genesis())]))
}

test genesis_supply_cannot_hold_tsra() {
  // same policy as the thread tokens, so only an exact-value check catches it
  let with_tsra =
    Output {
      ..state_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, supply_name, 1)
        |> assets.add(t_own, rules.tsra_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([config_out(t_genesis()), with_tsra]))
}

test genesis_config_cannot_hold_tsra() {
  let with_tsra =
    Output {
      ..config_out(t_genesis()),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, config_name, 1)
        |> assets.add(t_own, rules.tsra_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([with_tsra, state_out(t_genesis())]))
}

test genesis_with_a_third_output_at_the_reserve_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx(
      [
        config_out(t_genesis()),
        state_out(t_genesis()),
        state_out_with(t_genesis(), False),
      ],
    ),
  )
}

test genesis_with_a_second_config_output_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(t_genesis()), config_out(t_genesis())]),
  )
}

test genesis_with_both_tokens_in_one_output_is_rejected() {
  // one output carries both thread tokens; the second reserve output is empty
  let both =
    Output {
      ..state_out(t_genesis()),
      value: assets.from_lovelace(2_000_000) |> assets.merge(thread_pair()),
    }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([both, state_out_with(t_genesis(), False)]),
  )
}

test genesis_config_token_on_a_supply_datum_is_rejected() {
  // the datum kind must match the token: swap the two datums
  let swapped_config =
    Output { ..config_out(t_genesis()), datum: InlineDatum(SupplyDatum(sup_of(t_genesis()))) }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([swapped_config, state_out(t_genesis())]),
  )
}

test genesis_supply_token_on_a_config_datum_is_rejected() {
  let swapped_supply =
    Output { ..state_out(t_genesis()), datum: InlineDatum(ConfigDatum(cfg_of(t_genesis()))) }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(t_genesis()), swapped_supply]),
  )
}

test genesis_config_without_an_inline_datum_is_rejected() {
  let no_datum = Output { ..config_out(t_genesis()), datum: NoDatum }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([no_datum, state_out(t_genesis())]))
}

test genesis_supply_without_an_inline_datum_is_rejected() {
  let no_datum = Output { ..state_out(t_genesis()), datum: NoDatum }
  !reserve.mint(t_seed(), Void, t_own, boot_tx([config_out(t_genesis()), no_datum]))
}

test genesis_with_a_non_zero_config_epoch_is_rejected() {
  // the combined fixture shares one epoch, so split it: only the Config is off
  let bad = ReserveState { ..t_genesis(), epoch: 1 }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(bad), state_out(t_genesis())]),
  )
}

test genesis_with_a_non_zero_supply_epoch_is_rejected() {
  let bad = ReserveState { ..t_genesis(), epoch: 1 }
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(t_genesis()), state_out(bad)]),
  )
}

test genesis_without_the_seed_is_rejected() {
  let other = Input { ..seed_in(), output_reference: ref1() }
  let tx = Transaction { ..boot_tx(genesis_outs(t_genesis())), inputs: [other] }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_cannot_spend_a_supply_alongside() {
  let tx =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      inputs: [seed_in(), state_in(t_genesis())],
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_cannot_spend_a_config_alongside() {
  let tx =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      inputs: [seed_in(), config_in(t_genesis())],
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_mints_exactly_one_of_each_thread_token() {
  let two_config =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      mint: assets.from_asset(t_own, config_name, 2)
        |> assets.add(t_own, supply_name, 1),
    }
  let two_supply =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      mint: assets.from_asset(t_own, config_name, 1)
        |> assets.add(t_own, supply_name, 2),
    }
  !reserve.mint(t_seed(), Void, t_own, two_config) && !reserve.mint(
    t_seed(),
    Void,
    t_own,
    two_supply,
  )
}

test genesis_must_mint_both_thread_tokens() {
  let only_config =
    Transaction { ..boot_tx(genesis_outs(t_genesis())), mint: config_value(t_own) }
  let only_supply =
    Transaction { ..boot_tx(genesis_outs(t_genesis())), mint: supply_value(t_own) }
  !reserve.mint(t_seed(), Void, t_own, only_config) && !reserve.mint(
    t_seed(),
    Void,
    t_own,
    only_supply,
  )
}

test genesis_cannot_mint_tsra_at_the_same_time() {
  let tx =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      mint: thread_pair() |> assets.add(t_own, rules.tsra_name, 100),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test genesis_cannot_mint_a_third_name() {
  let tx =
    Transaction {
      ..boot_tx(genesis_outs(t_genesis())),
      mint: thread_pair() |> assets.add(t_own, "extra", 1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

// -- The thread tokens move only at genesis (Phase 2.5a)

test the_supply_token_can_never_be_burned() {
  // burning it would take the genuine Supply with it
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..base_tx(s0, next(s0), 0),
      mint: assets.from_asset(t_own, supply_name, -1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test the_config_token_can_never_be_burned() {
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..cfg_tx(s0, next(s0), 0),
      mint: assets.from_asset(t_own, config_name, -1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_second_config_cannot_be_minted_later() {
  // genuine Supply spent, the seed long gone: only a config token is minted
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..base_tx(s0, next(s0), 0),
      mint: assets.from_asset(t_own, config_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_second_supply_cannot_be_minted_later() {
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..base_tx(s0, next(s0), 0),
      mint: assets.from_asset(t_own, supply_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_tsra_mint_that_also_mints_a_config_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      mint: tsra(10) |> assets.add(t_own, config_name, 1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_tsra_mint_that_also_mints_a_supply_token_is_rejected() {
  // the extra supply token goes to a wallet, so the reserve's own outputs
  // look normal; only the mint handler stops it
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      mint: tsra(10) |> assets.add(t_own, supply_name, 1),
      outputs: [state_out(s1), token_at_wallet(supply_name)],
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_tsra_burn_that_also_burns_the_supply_token_is_rejected() {
  let s0 = t_state(100, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  let tx =
    Transaction {
      ..base_tx(s0, s1, -40),
      mint: tsra(-40) |> assets.add(t_own, supply_name, -1),
    }
  !reserve.mint(t_seed(), Void, t_own, tx)
}

test a_tsra_mint_that_also_mints_a_config_fails_the_spend_handler_too() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx =
    Transaction {
      ..base_tx(s0, s1, 10),
      mint: tsra(10) |> assets.add(t_own, config_name, 1),
    }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test a_plain_tsra_mint_passes_the_mint_handler() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  reserve.mint(t_seed(), Void, t_own, base_tx(s0, s1, 10))
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
  Transaction { ..cfg_tx(s0, s1, 0), extra_signatories: signers }
}

fn rotate(
  s0: ReserveState,
  s1: ReserveState,
  ops: List<ByteArray>,
  thr: Int,
  signers: List<ByteArray>,
) -> Bool {
  run(s0, Rotate { operators: ops, threshold: thr }, ref0(), rotate_tx(s0, s1, signers))
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

/// A rotation that also spends the Supply and returns it as `moved`.
fn rotate_dragging_supply(s0: ReserveState, moved: ReserveState) -> Bool {
  let tx =
    alongside_supply(
      rotate_tx(s0, rotated(s0), [t_op1, t_op2, t_op3, t_op4]),
      s0,
      moved,
    )
  run(s0, Rotate { operators: new_committee, threshold: 2 }, ref0(), tx)
}

test rotation_cannot_also_spend_the_supply_to_change_the_reserve() {
  let s0 = t_state(0, 100, 1_000)
  !rotate_dragging_supply(s0, ReserveState { ..next(s0), attested_reserve: 9_999 })
}

test rotation_cannot_also_spend_the_supply_to_change_the_cap() {
  let s0 = t_state(0, 100, 1_000)
  !rotate_dragging_supply(s0, ReserveState { ..next(s0), mint_cap: 9_999 })
}

test rotation_cannot_also_spend_the_supply_to_change_the_supply() {
  let s0 = t_state(0, 100, 1_000)
  !rotate_dragging_supply(s0, ReserveState { ..next(s0), minted_supply: 50 })
}

test rotation_dragging_the_supply_along_unchanged_is_still_rejected() {
  // even an identical Supply may not ride along: one UTxO kind per transition
  let s0 = t_state(0, 100, 1_000)
  !rotate_dragging_supply(s0, s0)
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
      ..cfg_tx(s0, rotated(s0), 10),
      extra_signatories: [t_op1, t_op2, t_op3, t_op4],
    }
  !run(s0, Rotate { operators: new_committee, threshold: 2 }, ref0(), tx)
}

test after_rotation_the_new_committee_can_mint() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op3, t_op5] }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_mint() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let tx = Transaction { ..base_tx(s0, s1, 10), extra_signatories: [t_op1, t_op2] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_rotate_back() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), operators: [t_op1, t_op2], threshold: 2 }
  !rotate(s0, s1, [t_op1, t_op2], 2, [t_op1, t_op2])
}

test after_rotation_the_new_committee_can_pause() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = Transaction { ..cfg_tx(s0, s1, 0), extra_signatories: [t_op4, t_op5] }
  run(s0, SetPaused { paused: True }, ref0(), tx)
}

test set_cap_above_the_hard_limit_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: rules.max_mint_cap + 1 }
  !run(s0, SetCap { mint_cap: rules.max_mint_cap + 1 }, ref0(), base_tx(s0, s1, 0))
}

test set_cap_at_the_hard_limit_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), mint_cap: rules.max_mint_cap }
  run(s0, SetCap { mint_cap: rules.max_mint_cap }, ref0(), base_tx(s0, s1, 0))
}

test the_state_cannot_hold_tsra() {
  // same policy as the thread token: only the exact-value check catches it
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let parked =
    Output {
      ..state_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, supply_name, 1)
        |> assets.add(t_own, rules.tsra_name, 10),
    }
  let tx = Transaction { ..base_tx(s0, s1, 10), outputs: [parked] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test genesis_without_a_validity_bound_is_rejected_even_at_time_zero() {
  // an unbounded genesis must fail outright, not just when attested_at != 0
  let tx =
    Transaction {
      ..boot_tx(genesis_outs(ReserveState { ..t_genesis(), attested_at: 0 })),
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

test genesis_with_the_proposed_five_million_cap_is_accepted() {
  boot(ReserveState { ..t_genesis(), mint_cap: 5_000_000_000_000 })
}

test set_cap_above_five_million_tsra_is_accepted() {
  // 5,000,000 TSRA is the proposed genesis cap, not a validator limit
  let s0 = t_state(0, 100, 5_000_000_000_000)
  let s1 = ReserveState { ..next(s0), mint_cap: 10_000_000_000_000 }
  run(s0, SetCap { mint_cap: 10_000_000_000_000 }, ref0(), base_tx(s0, s1, 0))
}

// -- Eligibility switches (Phase 2.3)

const t_other_holder: ByteArray =
  #"a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"

/// A reference input at the eligibility registry holding `name`'s token.
fn elig_ref(name: ByteArray) -> Input {
  Input {
    output_reference: ref1(),
    output: Output {
      address: address.from_script(t_elig),
      value: assets.from_lovelace(2_000_000) |> assets.add(t_elig, name, 1),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn kyc(s: ReserveState, mint_on: Bool, redeem_on: Bool) -> ReserveState {
  ReserveState { ..s, kyc_mint: mint_on, kyc_redeem: redeem_on }
}

/// Add the holder's token reference and signature to a transaction.
fn with_eligibility(
  tx: Transaction,
  token_of: ByteArray,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..tx,
    reference_inputs: list.concat(tx.reference_inputs, [elig_ref(token_of)]),
    extra_signatories: signers,
  }
}

fn kyc_mint_tx(s0: ReserveState) -> (ReserveState, Transaction) {
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  (s1, base_tx(s0, s1, 10))
}

fn kyc_burn_tx(s0: ReserveState) -> (ReserveState, Transaction) {
  let s1 = ReserveState { ..next(s0), minted_supply: 60 }
  (s1, Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] })
}

// Mint

test kyc_mint_on_an_eligible_holder_can_mint() {
  let s0 = kyc(t_state(0, 100, 1_000), True, False)
  let (_, tx) = kyc_mint_tx(s0)
  let tx = with_eligibility(tx, t_holder, [t_op1, t_op2, t_holder])
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test kyc_mint_on_an_ineligible_mint_is_rejected() {
  let s0 = kyc(t_state(0, 100, 1_000), True, False)
  let (_, tx) = kyc_mint_tx(s0)
  let tx = Transaction { ..tx, extra_signatories: [t_op1, t_op2, t_holder] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test kyc_mint_off_minting_needs_no_eligibility() {
  let s0 = t_state(0, 100, 1_000)
  let (_, tx) = kyc_mint_tx(s0)
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test kyc_mint_on_a_token_without_the_holders_signature_is_rejected() {
  let s0 = kyc(t_state(0, 100, 1_000), True, False)
  let (_, tx) = kyc_mint_tx(s0)
  let tx = with_eligibility(tx, t_holder, [t_op1, t_op2])
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test kyc_mint_on_another_holders_token_is_rejected() {
  let s0 = kyc(t_state(0, 100, 1_000), True, False)
  let (_, tx) = kyc_mint_tx(s0)
  let tx = with_eligibility(tx, t_holder, [t_op1, t_op2, t_other_holder])
  !run(s0, Mint { qty: 10, holder: t_other_holder }, ref0(), tx)
}

test kyc_mint_on_a_token_of_another_policy_is_rejected() {
  // the State names t_elig; a lookalike token under a different policy
  let s0 = kyc(t_state(0, 100, 1_000), True, False)
  let (_, tx) = kyc_mint_tx(s0)
  let fake =
    Input {
      ..elig_ref(t_holder),
      output: Output {
        ..elig_ref(t_holder).output,
        value: assets.from_lovelace(2_000_000)
          |> assets.add(#"66666666666666666666666666666666666666666666666666666666", t_holder, 1),
      },
    }
  let tx =
    Transaction {
      ..tx,
      reference_inputs: list.concat(tx.reference_inputs, [fake]),
      extra_signatories: [t_op1, t_op2, t_holder],
    }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test kyc_redeem_alone_does_not_gate_minting() {
  let s0 = kyc(t_state(0, 100, 1_000), False, True)
  let (_, tx) = kyc_mint_tx(s0)
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

// Burn

test kyc_redeem_on_an_eligible_holder_can_burn() {
  let s0 = kyc(t_state(100, 100, 1_000), False, True)
  let (_, tx) = kyc_burn_tx(s0)
  let tx = with_eligibility(tx, t_holder, [t_holder])
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test kyc_redeem_on_an_ineligible_burn_is_rejected() {
  let s0 = kyc(t_state(100, 100, 1_000), False, True)
  let (_, tx) = kyc_burn_tx(s0)
  let tx = Transaction { ..tx, extra_signatories: [t_holder] }
  !run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test kyc_redeem_off_burning_needs_no_eligibility() {
  let s0 = t_state(100, 100, 1_000)
  let (_, tx) = kyc_burn_tx(s0)
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test kyc_redeem_on_a_token_without_the_holders_signature_is_rejected() {
  let s0 = kyc(t_state(100, 100, 1_000), False, True)
  let (_, tx) = kyc_burn_tx(s0)
  let tx = with_eligibility(tx, t_holder, [])
  !run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test kyc_redeem_on_another_holders_token_is_rejected() {
  let s0 = kyc(t_state(100, 100, 1_000), False, True)
  let (_, tx) = kyc_burn_tx(s0)
  let tx = with_eligibility(tx, t_holder, [t_other_holder])
  !run(s0, Burn { qty: 40, holder: t_other_holder }, ref0(), tx)
}

test kyc_mint_alone_does_not_gate_burning() {
  let s0 = kyc(t_state(100, 100, 1_000), True, False)
  let (_, tx) = kyc_burn_tx(s0)
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

// SetKyc

fn set_kyc_policy(
  s0: ReserveState,
  s1: ReserveState,
  m: Bool,
  r: Bool,
  st: Bool,
  policy: ByteArray,
  signers: List<ByteArray>,
) -> Bool {
  run(s0, SetKyc { kyc_mint: m, kyc_redeem: r, kyc_stake: st, eligibility_policy: policy }, ref0(), Transaction { ..cfg_tx(s0, s1, 0), extra_signatories: signers })
}

/// SetKyc that keeps the current eligibility policy.
fn set_kyc(
  s0: ReserveState,
  s1: ReserveState,
  m: Bool,
  r: Bool,
  st: Bool,
  signers: List<ByteArray>,
) -> Bool {
  set_kyc_policy(s0, s1, m, r, st, t_elig, signers)
}

fn kyc_all_on(s0: ReserveState) -> ReserveState {
  ReserveState {
    ..next(s0),
    kyc_mint: True,
    kyc_redeem: True,
    kyc_stake: True,
  }
}

test set_kyc_by_the_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  set_kyc(s0, kyc_all_on(s0), True, True, True, [t_op1, t_op2])
}

test set_kyc_can_switch_back_off() {
  let s0 = ReserveState { ..t_state(0, 100, 1_000), kyc_mint: True, kyc_stake: True }
  let s1 = ReserveState { ..next(s0), kyc_mint: False, kyc_stake: False }
  set_kyc(s0, s1, False, False, False, [t_op1, t_op2])
}

test set_kyc_without_the_committee_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !set_kyc(s0, kyc_all_on(s0), True, True, True, [t_op1])
}

test set_kyc_datum_must_match_the_redeemer() {
  // redeemer turns on mint only; datum turns on all three
  let s0 = t_state(0, 100, 1_000)
  !set_kyc(s0, kyc_all_on(s0), True, False, False, [t_op1, t_op2])
}

test set_kyc_datum_stake_switch_must_match_the_redeemer() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), kyc_mint: True, kyc_redeem: True }
  !set_kyc(s0, s1, True, True, True, [t_op1, t_op2])
}

test set_kyc_datum_policy_must_match_the_redeemer() {
  // redeemer keeps t_elig; datum installs another policy
  let s0 = t_state(0, 100, 1_000)
  let s1 =
    ReserveState {
      ..kyc_all_on(s0),
      eligibility_policy: #"66666666666666666666666666666666666666666666666666666666",
    }
  !set_kyc(s0, s1, True, True, True, [t_op1, t_op2])
}

test set_kyc_cannot_also_spend_the_supply() {
  let s0 = t_state(0, 100, 1_000)
  let moved = ReserveState { ..next(s0), attested_reserve: 9_999 }
  let tx = alongside_supply(cfg_tx(s0, kyc_all_on(s0), 0), s0, moved)
  !run(
    s0,
    SetKyc { kyc_mint: True, kyc_redeem: True, kyc_stake: True, eligibility_policy: t_elig },
    ref0(),
    tx,
  )
}

test set_kyc_cannot_touch_the_committee() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..kyc_all_on(s0), operators: [t_op1, t_op3] }
  !set_kyc(s0, s1, True, True, True, [t_op1, t_op2])
}

test set_kyc_cannot_touch_the_pause_flag() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..kyc_all_on(s0), paused: True }
  !set_kyc(s0, s1, True, True, True, [t_op1, t_op2])
}

test set_kyc_must_bump_the_epoch() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..kyc_all_on(s0), epoch: s0.epoch }
  !set_kyc(s0, s1, True, True, True, [t_op1, t_op2])
}

test set_kyc_cannot_mint() {
  let s0 = t_state(0, 100, 1_000)
  let tx =
    Transaction {
      ..cfg_tx(s0, kyc_all_on(s0), 10),
      extra_signatories: [t_op1, t_op2],
    }
  !run(s0, SetKyc {
      kyc_mint: True,
      kyc_redeem: True,
      kyc_stake: True,
      eligibility_policy: t_elig,
    }, ref0(), tx)
}

// Genesis

test genesis_sets_the_switches_explicitly_and_may_start_all_off() {
  let g = t_genesis()
  !g.kyc_mint && !g.kyc_redeem && !g.kyc_stake && boot(g)
}

test genesis_with_an_eligibility_policy_that_is_not_a_policy_id_is_rejected() {
  !boot(ReserveState { ..t_genesis(), eligibility_policy: #"77" })
}

test set_kyc_datum_mint_switch_must_match_the_redeemer() {
  // only the mint switch differs: redeemer off, datum on
  let s0 = t_state(0, 100, 1_000)
  !set_kyc(s0, kyc_all_on(s0), False, True, True, [t_op1, t_op2])
}

test set_kyc_datum_redeem_switch_must_match_the_redeemer() {
  // only the redeem switch differs: redeemer off, datum on
  let s0 = t_state(0, 100, 1_000)
  !set_kyc(s0, kyc_all_on(s0), True, False, True, [t_op1, t_op2])
}

// SetKyc: repointing the eligibility policy (2.3 review)

const t_new_elig: ByteArray =
  #"88888888888888888888888888888888888888888888888888888888"

test set_kyc_changing_the_policy_with_the_committee_is_accepted() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), eligibility_policy: t_new_elig }
  set_kyc_policy(s0, s1, False, False, False, t_new_elig, [t_op1, t_op2])
}

test set_kyc_changing_the_policy_without_the_committee_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), eligibility_policy: t_new_elig }
  !set_kyc_policy(s0, s1, False, False, False, t_new_elig, [t_op1])
}

test set_kyc_with_an_invalid_policy_id_is_rejected() {
  // datum and redeemer agree, so only the 28-byte check stops it
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), eligibility_policy: #"77" }
  !set_kyc_policy(s0, s1, False, False, False, #"77", [t_op1, t_op2])
}

test set_kyc_with_a_29_byte_policy_id_is_rejected() {
  let long = #"8888888888888888888888888888888888888888888888888888888888"
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), eligibility_policy: long }
  !set_kyc_policy(s0, s1, False, False, False, long, [t_op1, t_op2])
}

test set_kyc_changing_the_policy_cannot_also_spend_the_supply() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), eligibility_policy: t_new_elig }
  let moved = ReserveState { ..next(s0), mint_cap: 9_999 }
  let tx = alongside_supply(cfg_tx(s0, s1, 0), s0, moved)
  !run(
    s0,
    SetKyc { kyc_mint: False, kyc_redeem: False, kyc_stake: False, eligibility_policy: t_new_elig },
    ref0(),
    tx,
  )
}

test after_repointing_mint_eligibility_uses_the_new_policy() {
  // kyc_mint on under the new policy: an old-policy token no longer counts
  let s0 =
    ReserveState {
      ..t_state(0, 100, 1_000),
      kyc_mint: True,
      eligibility_policy: t_new_elig,
    }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let old = with_eligibility(base_tx(s0, s1, 10), t_holder, [t_op1, t_op2, t_holder])
  let new_token =
    Input {
      ..elig_ref(t_holder),
      output: Output {
        ..elig_ref(t_holder).output,
        value: assets.from_lovelace(2_000_000)
          |> assets.add(t_new_elig, t_holder, 1),
      },
    }
  let fresh = Transaction { ..old, reference_inputs: [config_ref(s0), new_token] }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), old) && run(s0, Mint { qty: 10, holder: t_holder }, ref0(), fresh)
}

// -- F-6: the State keeps its address, carries no reference script, and
// never loses lovelace

const t_stranger: ByteArray =
  #"f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"

/// A committee SetPaused whose State output is rewritten by `f`.
fn pause_with(f: fn(Output) -> Output) -> Bool {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = cfg_tx(s0, s1, 0)
  expect [out] = tx.outputs
  run(s0, SetPaused { paused: True }, ref0(), Transaction { ..tx, outputs: [f(out)] })
}

test f6_pause_fixture_is_accepted() {
  pause_with(fn(o) { o })
}

test f6_state_under_a_foreign_stake_credential_is_rejected() {
  !pause_with(
    fn(o) {
      Output {
        ..o,
        address: Address {
          payment_credential: Script(t_own),
          stake_credential: Some(address.Inline(address.VerificationKey(t_stranger))),
        },
      }
    },
  )
}

test f6_state_with_a_reference_script_is_rejected() {
  !pause_with(fn(o) { Output { ..o, reference_script: Some(t_stranger) } })
}

test f6_state_losing_lovelace_is_rejected() {
  !pause_with(fn(o) { Output { ..o, value: assets.add(o.value, "", "", -1) } })
}

test f6_state_may_gain_lovelace() {
  pause_with(fn(o) { Output { ..o, value: assets.add(o.value, "", "", 1_000_000) } })
}

fn staked_at_stranger(o: Output) -> Output {
  Output {
    ..o,
    address: Address {
      payment_credential: Script(t_own),
      stake_credential: Some(address.Inline(address.VerificationKey(t_stranger))),
    },
  }
}

test f6_genesis_supply_under_a_stake_credential_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(t_genesis()), staked_at_stranger(state_out(t_genesis()))]),
  )
}

test f6_genesis_config_under_a_stake_credential_is_rejected() {
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([staked_at_stranger(config_out(t_genesis())), state_out(t_genesis())]),
  )
}

test f6_genesis_supply_with_a_reference_script_is_rejected() {
  let o = state_out(t_genesis())
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([config_out(t_genesis()), Output { ..o, reference_script: Some(t_stranger) }]),
  )
}

test f6_genesis_config_with_a_reference_script_is_rejected() {
  let o = config_out(t_genesis())
  !reserve.mint(
    t_seed(),
    Void,
    t_own,
    boot_tx([Output { ..o, reference_script: Some(t_stranger) }, state_out(t_genesis())]),
  )
}

// -- Phase 2.5a: the Config / Supply split

// The four Supply redeemers, each with a well-formed transaction.
fn supply_case(i: Int) -> (ReserveState, ReserveRedeemer, Transaction) {
  if i == 0 {
    let s0 = t_state(0, 100, 1_000)
    let s1 = ReserveState { ..next(s0), minted_supply: 10 }
    (s0, Mint { qty: 10, holder: t_holder }, base_tx(s0, s1, 10))
  } else if i == 1 {
    let s0 = t_state(100, 100, 1_000)
    let s1 = ReserveState { ..next(s0), minted_supply: 60 }
    (
      s0,
      Burn { qty: 40, holder: t_holder },
      Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] },
    )
  } else if i == 2 {
    let s0 = t_state(0, 100, 1_000)
    let s1 =
      ReserveState {
        ..next(s0),
        attested_reserve: 250,
        attestation_epoch: 2,
        attested_at: 1_500_000,
      }
    (s0, Attest { reserve: 250 }, base_tx(s0, s1, 0))
  } else {
    let s0 = t_state(0, 100, 1_000)
    let s1 = ReserveState { ..next(s0), mint_cap: 50 }
    (s0, SetCap { mint_cap: 50 }, base_tx(s0, s1, 0))
  }
}

fn with_refs(tx: Transaction, refs: List<Input>) -> Transaction {
  Transaction { ..tx, reference_inputs: refs }
}

/// The Config reference with its token removed (a planted lookalike).
fn planted_config_ref(s: ReserveState) -> Input {
  Input { ..config_ref(s), output: config_out_with(s, False) }
}

/// The Config reference sitting at a wallet, not at the reserve address.
fn misplaced_config_ref(s: ReserveState) -> Input {
  Input {
    ..config_ref(s),
    output: Output { ..config_out(s), address: address.from_verification_key(t_op1) },
  }
}

/// A Supply datum under the `config` token.
fn wrong_kind_config_ref(s: ReserveState) -> Input {
  Input {
    ..config_ref(s),
    output: Output { ..config_out(s), datum: InlineDatum(SupplyDatum(sup_of(s))) },
  }
}

fn well_formed_supply_cases_pass() -> Bool {
  let (a0, ra, ta) = supply_case(0)
  let (b0, rb, tb) = supply_case(1)
  let (c0, rc, tc) = supply_case(2)
  let (d0, rd, td) = supply_case(3)
  run(a0, ra, ref0(), ta) && run(b0, rb, ref0(), tb) && run(c0, rc, ref0(), tc) && run(
    d0,
    rd,
    ref0(),
    td,
  )
}

test every_supply_redeemer_passes_with_a_genuine_config_reference() {
  well_formed_supply_cases_pass()
}

// A Supply transition without a usable Config reference.

test mint_without_a_config_reference_is_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  run(s0, rd, ref0(), with_refs(tx, []))
}

test burn_without_a_config_reference_is_rejected() fail {
  let (s0, rd, tx) = supply_case(1)
  run(s0, rd, ref0(), with_refs(tx, []))
}

test attest_without_a_config_reference_is_rejected() fail {
  let (s0, rd, tx) = supply_case(2)
  run(s0, rd, ref0(), with_refs(tx, []))
}

test set_cap_without_a_config_reference_is_rejected() fail {
  let (s0, rd, tx) = supply_case(3)
  run(s0, rd, ref0(), with_refs(tx, []))
}

test mint_against_a_planted_config_is_rejected() fail {
  // attacker's Config: own committee, no thread token
  let (s0, rd, tx) = supply_case(0)
  let evil = ReserveState { ..s0, operators: [t_op1, t_op3] }
  run(s0, rd, ref0(), with_refs(Transaction { ..tx, extra_signatories: [t_op1, t_op3] }, [planted_config_ref(evil)]))
}

test burn_against_a_planted_config_is_rejected() fail {
  let (s0, rd, tx) = supply_case(1)
  run(s0, rd, ref0(), with_refs(tx, [planted_config_ref(s0)]))
}

test attest_against_a_planted_config_is_rejected() fail {
  let (s0, rd, tx) = supply_case(2)
  run(s0, rd, ref0(), with_refs(tx, [planted_config_ref(s0)]))
}

test set_cap_against_a_planted_config_is_rejected() fail {
  let (s0, rd, tx) = supply_case(3)
  run(s0, rd, ref0(), with_refs(tx, [planted_config_ref(s0)]))
}

test mint_against_a_config_off_the_reserve_address_is_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  run(s0, rd, ref0(), with_refs(tx, [misplaced_config_ref(s0)]))
}

test burn_against_a_config_off_the_reserve_address_is_rejected() fail {
  let (s0, rd, tx) = supply_case(1)
  run(s0, rd, ref0(), with_refs(tx, [misplaced_config_ref(s0)]))
}

test attest_against_a_config_off_the_reserve_address_is_rejected() fail {
  let (s0, rd, tx) = supply_case(2)
  run(s0, rd, ref0(), with_refs(tx, [misplaced_config_ref(s0)]))
}

test set_cap_against_a_config_off_the_reserve_address_is_rejected() fail {
  let (s0, rd, tx) = supply_case(3)
  run(s0, rd, ref0(), with_refs(tx, [misplaced_config_ref(s0)]))
}

test mint_against_a_supply_datum_under_the_config_token_is_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  run(s0, rd, ref0(), with_refs(tx, [wrong_kind_config_ref(s0)]))
}

test burn_against_a_supply_datum_under_the_config_token_is_rejected() fail {
  let (s0, rd, tx) = supply_case(1)
  run(s0, rd, ref0(), with_refs(tx, [wrong_kind_config_ref(s0)]))
}

test attest_against_a_supply_datum_under_the_config_token_is_rejected() fail {
  let (s0, rd, tx) = supply_case(2)
  run(s0, rd, ref0(), with_refs(tx, [wrong_kind_config_ref(s0)]))
}

test set_cap_against_a_supply_datum_under_the_config_token_is_rejected() fail {
  let (s0, rd, tx) = supply_case(3)
  run(s0, rd, ref0(), with_refs(tx, [wrong_kind_config_ref(s0)]))
}

test a_config_reference_without_an_inline_datum_is_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  let bare =
    Input { ..config_ref(s0), output: Output { ..config_out(s0), datum: NoDatum } }
  run(s0, rd, ref0(), with_refs(tx, [bare]))
}

test two_config_references_are_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  let second = Input { ..config_ref(s0), output_reference: ref1() }
  run(s0, rd, ref0(), with_refs(tx, [config_ref(s0), second]))
}

test a_planted_config_beside_the_genuine_one_is_ignored() {
  // a token-less lookalike with another committee cannot displace the real one
  let (s0, rd, tx) = supply_case(0)
  let evil = ReserveState { ..s0, operators: [t_op3, t_op4] }
  run(s0, rd, ref0(), with_refs(tx, [config_ref(s0), planted_config_ref(evil)]))
}

test a_config_reference_holding_two_config_tokens_is_rejected() fail {
  let (s0, rd, tx) = supply_case(0)
  let doubled =
    Input {
      ..config_ref(s0),
      output: Output {
        ..config_out(s0),
        value: assets.from_lovelace(2_000_000) |> assets.add(t_own, config_name, 2),
      },
    }
  run(s0, rd, ref0(), with_refs(tx, [doubled]))
}

test a_config_spent_instead_of_referenced_is_rejected() fail {
  // the Config must be a reference input, not an input of the supply spend
  let (s0, rd, tx) = supply_case(0)
  let spent = Input { ..config_in(s0), output_reference: ref1() }
  run(s0, rd, ref0(), Transaction { ..with_refs(tx, []), inputs: [state_in(s0), spent] })
}

test a_supply_transition_cannot_return_a_config_output() {
  // an extra Config-token output beside the Supply: the Config is not ours to move
  let (s0, rd, tx) = supply_case(0)
  !run(s0, rd, ref0(), Transaction { ..tx, outputs: list.concat(tx.outputs, [config_out(s0)]) })
}

test a_supply_transition_cannot_mint_the_config_in_its_output() {
  let (s0, rd, tx) = supply_case(0)
  let planted = Output { ..state_out(s0), value: state_out(s0).value |> assets.add(t_own, config_name, 1) }
  !run(s0, rd, ref0(), Transaction { ..tx, outputs: [planted] })
}

// Cross-kind confusion: a redeemer on the other kind's datum.

test set_paused_on_the_supply_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = next(s0)
  !reserve.spend(t_seed(), Some(SupplyDatum(sup_of(s0))), SetPaused { paused: True }, ref0(), base_tx(s0, s1, 0))
}

test set_kyc_on_the_supply_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !reserve.spend(
    t_seed(),
    Some(SupplyDatum(sup_of(s0))),
    SetKyc { kyc_mint: True, kyc_redeem: False, kyc_stake: False, eligibility_policy: t_elig },
    ref0(),
    base_tx(s0, next(s0), 0),
  )
}

test rotate_on_the_supply_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !reserve.spend(
    t_seed(),
    Some(SupplyDatum(sup_of(s0))),
    Rotate { operators: new_committee, threshold: 2 },
    ref0(),
    Transaction { ..base_tx(s0, next(s0), 0), extra_signatories: [t_op1, t_op2, t_op3, t_op4] },
  )
}

test mint_on_the_config_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = next(s0)
  !reserve.spend(t_seed(), Some(ConfigDatum(cfg_of(s0))), Mint { qty: 10, holder: t_holder }, ref0(), cfg_tx(s0, s1, 10))
}

test burn_on_the_config_datum_is_rejected() {
  let s0 = t_state(100, 100, 1_000)
  let tx = Transaction { ..cfg_tx(s0, next(s0), -40), extra_signatories: [] }
  !reserve.spend(t_seed(), Some(ConfigDatum(cfg_of(s0))), Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test attest_on_the_config_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !reserve.spend(t_seed(), Some(ConfigDatum(cfg_of(s0))), Attest { reserve: 250 }, ref0(), cfg_tx(s0, next(s0), 0))
}

test set_cap_on_the_config_datum_is_rejected() {
  let s0 = t_state(0, 100, 1_000)
  !reserve.spend(t_seed(), Some(ConfigDatum(cfg_of(s0))), SetCap { mint_cap: 50 }, ref0(), cfg_tx(s0, next(s0), 0))
}

test a_supply_datum_under_the_config_token_cannot_be_spent_as_the_config() fail {
  let s0 = t_state(0, 100, 1_000)
  let masquerade =
    Input {
      output_reference: ref0(),
      output: Output { ..config_out(s0), datum: InlineDatum(SupplyDatum(sup_of(s0))) },
    }
  run(s0, SetPaused { paused: True }, ref0(), Transaction { ..cfg_tx(s0, ReserveState { ..next(s0), paused: True }, 0), inputs: [masquerade] })
}

test a_config_datum_under_the_supply_token_cannot_be_spent_as_the_supply() fail {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let masquerade =
    Input {
      output_reference: ref0(),
      output: Output { ..state_out(s0), datum: InlineDatum(ConfigDatum(cfg_of(s0))) },
    }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), Transaction { ..base_tx(s0, s1, 10), inputs: [masquerade] })
}

test a_config_transition_needs_no_supply_reference() {
  // SetPaused works with no reference inputs at all
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  run(s0, SetPaused { paused: True }, ref0(), cfg_tx(s0, s1, 0))
}

test the_config_output_may_not_carry_a_supply_token() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let both = Output { ..config_out(s1), value: config_out(s1).value |> assets.add(t_own, supply_name, 1) }
  !run(s0, SetPaused { paused: True }, ref0(), Transaction { ..cfg_tx(s0, s1, 0), outputs: [both] })
}

// The committee is read from the Config

test after_rotation_the_new_committee_can_attest() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 =
    ReserveState { ..next(s0), attested_reserve: 250, attestation_epoch: 2, attested_at: 1_500_000 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op3, t_op5] }
  run(s0, Attest { reserve: 250 }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_attest() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 =
    ReserveState { ..next(s0), attested_reserve: 250, attestation_epoch: 2, attested_at: 1_500_000 }
  !run(s0, Attest { reserve: 250 }, ref0(), base_tx(s0, s1, 0))
}

test after_rotation_the_new_committee_can_set_the_cap() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  let tx = Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op4, t_op5] }
  run(s0, SetCap { mint_cap: 50 }, ref0(), tx)
}

test after_rotation_the_old_committee_cannot_set_the_cap() {
  let s0 = rotated(t_state(0, 100, 1_000))
  let s1 = ReserveState { ..next(s0), mint_cap: 50 }
  !run(s0, SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test the_committee_comes_from_the_config_reference_not_the_supply() {
  // the signers match a stale committee, the reference holds the rotated one
  let (s0, rd, tx) = supply_case(0)
  let rotated_cfg = rotated(s0)
  !run(s0, rd, ref0(), with_refs(tx, [config_ref(rotated_cfg)]))
}

test a_paused_config_reference_blocks_minting_but_not_burning() {
  let (m0, mrd, mtx) = supply_case(0)
  let (b0, brd, btx) = supply_case(1)
  let paused_m = ReserveState { ..m0, paused: True }
  let paused_b = ReserveState { ..b0, paused: True }
  !run(m0, mrd, ref0(), with_refs(mtx, [config_ref(paused_m)])) && run(
    b0,
    brd,
    ref0(),
    with_refs(btx, [config_ref(paused_b)]),
  )
}

test supply_and_config_epochs_are_independent() {
  // a Supply at epoch 7 mints against a Config at epoch 0
  let s0 = ReserveState { ..t_state(0, 100, 1_000), epoch: 7 }
  let s1 = ReserveState { ..next(s0), minted_supply: 10 }
  let cfg0 = ReserveState { ..s0, epoch: 0 }
  let tx = Transaction { ..base_tx(s0, s1, 10), reference_inputs: [config_ref(cfg0)] }
  run(s0, Mint { qty: 10, holder: t_holder }, ref0(), tx)
}

test the_supply_must_bump_its_own_epoch() {
  // bumping only the Config's counter (here: none) does not satisfy the Supply
  let s0 = ReserveState { ..t_state(0, 100, 1_000), epoch: 7 }
  let s1 = ReserveState { ..s0, minted_supply: 10 }
  !run(s0, Mint { qty: 10, holder: t_holder }, ref0(), base_tx(s0, s1, 10))
}

test a_config_reference_with_an_invalid_committee_is_rejected() {
  // belt and braces: a Config-shaped datum with a 1-of-2 committee never exists,
  // but if one did it could not authorise supply changes
  let (s0, rd, tx) = supply_case(0)
  let weak = ReserveState { ..s0, threshold: 1 }
  let signed = Transaction { ..tx, extra_signatories: [t_op1] }
  !run(s0, rd, ref0(), with_refs(signed, [config_ref(weak)]))
}

// -- Phase 2.5a mutation-pass additions (each pins a guard no earlier test did)

/// A committee Attest whose Supply output is rewritten by `f` (F-6 on the Supply).
fn attest_with(f: fn(Output) -> Output) -> Bool {
  let (s0, rd, tx) = supply_case(2)
  expect [out] = tx.outputs
  run(s0, rd, ref0(), Transaction { ..tx, outputs: [f(out)] })
}

test f6_supply_fixture_is_accepted() {
  attest_with(fn(o) { o })
}

test f6_supply_under_a_foreign_stake_credential_is_rejected() {
  !attest_with(
    fn(o) {
      Output {
        ..o,
        address: Address {
          payment_credential: Script(t_own),
          stake_credential: Some(address.Inline(address.VerificationKey(t_stranger))),
        },
      }
    },
  )
}

test f6_supply_with_a_reference_script_is_rejected() {
  !attest_with(fn(o) { Output { ..o, reference_script: Some(t_stranger) } })
}

test f6_supply_losing_lovelace_is_rejected() {
  !attest_with(fn(o) { Output { ..o, value: assets.add(o.value, "", "", -1) } })
}

test f6_supply_may_gain_lovelace() {
  attest_with(fn(o) { Output { ..o, value: assets.add(o.value, "", "", 1_000_000) } })
}

fn burn_to(s1: ReserveState) -> Bool {
  let s0 = t_state(100, 100, 1_000)
  let tx = Transaction { ..base_tx(s0, s1, -40), extra_signatories: [] }
  run(s0, Burn { qty: 40, holder: t_holder }, ref0(), tx)
}

test a_burn_with_the_exact_next_datum_is_accepted() {
  burn_to(ReserveState { ..next(t_state(100, 100, 1_000)), minted_supply: 60 })
}

test burn_datum_must_record_the_burn() {
  !burn_to(ReserveState { ..next(t_state(100, 100, 1_000)), minted_supply: 70 })
}

test burn_cannot_change_the_cap() {
  !burn_to(ReserveState { ..next(t_state(100, 100, 1_000)), minted_supply: 60, mint_cap: 9_999 })
}

test burn_cannot_change_the_attested_reserve() {
  !burn_to(ReserveState { ..next(t_state(100, 100, 1_000)), minted_supply: 60, attested_reserve: 9_999 })
}

test burn_cannot_change_the_attestation_anchor() {
  !burn_to(ReserveState { ..next(t_state(100, 100, 1_000)), minted_supply: 60, attested_at: 5 })
}

test burn_must_bump_the_epoch() {
  !burn_to(ReserveState { ..t_state(100, 100, 1_000), minted_supply: 60 })
}

fn cap_to(s1: ReserveState) -> Bool {
  let s0 = t_state(0, 100, 1_000)
  run(s0, SetCap { mint_cap: 50 }, ref0(), base_tx(s0, s1, 0))
}

test a_set_cap_with_the_exact_next_datum_is_accepted() {
  cap_to(ReserveState { ..next(t_state(0, 100, 1_000)), mint_cap: 50 })
}

test set_cap_datum_must_match_the_redeemer() {
  !cap_to(ReserveState { ..next(t_state(0, 100, 1_000)), mint_cap: 51 })
}

test set_cap_cannot_change_the_attested_reserve() {
  !cap_to(ReserveState { ..next(t_state(0, 100, 1_000)), mint_cap: 50, attested_reserve: 9_999 })
}

test set_cap_datum_cannot_record_a_mint() {
  !cap_to(ReserveState { ..next(t_state(0, 100, 1_000)), mint_cap: 50, minted_supply: 10 })
}

test set_cap_cannot_change_the_attestation_anchor() {
  !cap_to(ReserveState { ..next(t_state(0, 100, 1_000)), mint_cap: 50, attested_at: 5 })
}

test set_cap_must_bump_the_epoch() {
  !cap_to(ReserveState { ..t_state(0, 100, 1_000), mint_cap: 50 })
}

test a_planted_supply_beside_the_genuine_one_is_rejected_even_with_the_real_committee() {
  // The committee now comes from the genuine Config, so a planted Supply-shaped
  // UTxO with a huge fake reserve is not stopped by its own (fake) committee any
  // more; only "the spent input is the genuine Supply" stops it.
  let s0 = t_state(0, 100, 1_000)
  let evil = ReserveState { ..s0, attested_reserve: 999_999, mint_cap: 999_999 }
  let s1 = ReserveState { ..next(evil), minted_supply: 500_000 }
  let planted = Input { output_reference: ref1(), output: state_out_with(evil, False) }
  let tx = Transaction { ..base_tx(s0, s1, 500_000), inputs: [state_in(s0), planted] }
  !run(evil, Mint { qty: 500_000, holder: t_holder }, ref1(), tx)
}

test a_supply_transition_cannot_spend_the_config_and_send_its_token_away() {
  // the Config is also referenced, so the lookup succeeds; spending it is the offence
  let (s0, rd, tx) = supply_case(0)
  let spent = Input { ..config_in(s0), output_reference: ref1() }
  !run(
    s0,
    rd,
    ref0(),
    Transaction {
      ..tx,
      inputs: [state_in(s0), spent],
      outputs: list.concat(tx.outputs, [token_at_wallet(config_name)]),
    },
  )
}

test a_config_transition_cannot_spend_the_supply_and_send_its_token_away() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let spent = Input { ..state_in(s0), output_reference: ref1() }
  let tx = cfg_tx(s0, s1, 0)
  !run(
    s0,
    SetPaused { paused: True },
    ref0(),
    Transaction {
      ..tx,
      inputs: [config_in(s0), spent],
      outputs: list.concat(tx.outputs, [token_at_wallet(supply_name)]),
    },
  )
}

// -- Phase 2.5a mutation-pass additions, Config side

test a_planted_config_beside_the_genuine_one_cannot_be_spent_to_rewrite_the_committee() {
  // Config redeemers authorise from the spent datum's own committee, so the
  // spent input must BE the genuine Config; a token-less lookalike with an
  // attacker committee must not pass.
  let s0 = t_state(0, 100, 1_000)
  let evil = ReserveState { ..s0, operators: [t_op1, t_op3], threshold: 2 }
  let s1 = ReserveState { ..next(evil), paused: True }
  let planted = Input { output_reference: ref1(), output: config_out_with(evil, False) }
  let tx =
    Transaction {
      ..cfg_tx(s0, s1, 0),
      inputs: [config_in(s0), planted],
      extra_signatories: [t_op1, t_op3],
    }
  !run(evil, SetPaused { paused: True }, ref1(), tx)
}

test a_config_transition_cannot_return_a_supply_output() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let tx = cfg_tx(s0, s1, 0)
  !run(
    s0,
    SetPaused { paused: True },
    ref0(),
    Transaction { ..tx, outputs: list.concat(tx.outputs, [state_out(s0)]) },
  )
}

test the_config_cannot_hold_tsra() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let parked =
    Output {
      ..config_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, config_name, 1)
        |> assets.add(t_own, rules.tsra_name, 10),
    }
  !run(s0, SetPaused { paused: True }, ref0(), Transaction { ..cfg_tx(s0, s1, 0), outputs: [parked] })
}

test config_output_may_not_carry_foreign_tokens() {
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), paused: True }
  let junk =
    Output {
      ..config_out(s1),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_own, config_name, 1)
        |> assets.add(t_junk_policy, "junk", 1),
    }
  !run(s0, SetPaused { paused: True }, ref0(), Transaction { ..cfg_tx(s0, s1, 0), outputs: [junk] })
}

fn pause_to(s1: ReserveState) -> Bool {
  let s0 = t_state(0, 100, 1_000)
  run(s0, SetPaused { paused: True }, ref0(), cfg_tx(s0, s1, 0))
}

test a_pause_with_the_exact_next_datum_is_accepted() {
  pause_to(ReserveState { ..next(t_state(0, 100, 1_000)), paused: True })
}

test set_paused_datum_must_match_the_redeemer() {
  !pause_to(ReserveState { ..next(t_state(0, 100, 1_000)), paused: False })
}

test set_paused_cannot_change_the_committee() {
  !pause_to(
    ReserveState { ..next(t_state(0, 100, 1_000)), paused: True, operators: [t_op1, t_op3] },
  )
}

test set_paused_cannot_change_the_threshold() {
  !pause_to(ReserveState { ..next(t_state(0, 100, 1_000)), paused: True, threshold: 2, operators: [t_op1, t_op2, t_op3] })
}

test set_paused_cannot_change_the_kyc_switches() {
  !pause_to(ReserveState { ..next(t_state(0, 100, 1_000)), paused: True, kyc_mint: True })
}

test set_paused_cannot_change_the_eligibility_policy() {
  !pause_to(
    ReserveState { ..next(t_state(0, 100, 1_000)), paused: True, eligibility_policy: t_new_elig },
  )
}

test set_paused_must_bump_the_epoch() {
  !pause_to(ReserveState { ..t_state(0, 100, 1_000), paused: True })
}

test rotation_can_change_the_threshold() {
  // 2-of-2 -> 3-of-3: the datum must carry the redeemer's threshold, not the old one
  let s0 = t_state(0, 100, 1_000)
  let s1 = ReserveState { ..next(s0), operators: new_committee, threshold: 3 }
  rotate(s0, s1, new_committee, 3, [t_op1, t_op2, t_op3, t_op4, t_op5])
}

test genesis_with_a_29_byte_eligibility_policy_is_rejected() {
  !boot(
    ReserveState {
      ..t_genesis(),
      eligibility_policy: #"8888888888888888888888888888888888888888888888888888888888",
    },
  )
}
