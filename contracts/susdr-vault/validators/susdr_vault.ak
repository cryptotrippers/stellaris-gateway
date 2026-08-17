//// sUSDr vault — a stablecoin-denominated yield vault for Cardano (PlutusV3).
////
//// The Cardano-native equivalent of an ERC-4626 tokenized vault:
////   * deposit USDr -> mint sUSDr receipt tokens at the current exchange rate
////   * operators report real yield by depositing USDr (`ReportYield`) — the
////     exchange rate rises; sUSDr balances never rebase
////   * redeem sUSDr -> burn receipts, withdraw USDr including accrued yield
////   * protocol fee is charged ON YIELD ONLY (capped 20%), settled by
////     minting treasury shares (dilution), never by removing assets
////
//// Architecture notes (vs the EVM version):
////   * "totalAssets" is not a storage variable to trust — it is checked
////     against the actual USDr quantity locked at the script every single
////     transition (`state_value_matches`), so accounting can never drift
////     from reality. An EVM vault must trust its own bookkeeping; this one
////     re-derives it.
////   * sUSDr itself is minted by this same script used as a minting policy
////     (`mint` handler below), bound 1:1 to share-supply changes, so token
////     supply and internal share accounting cannot diverge.
////   * All privileged actions (yield reports, fee changes, pause) need
////     M-of-N operator signatures held in the datum. Reentrancy does not
////     exist in eUTxO; double-satisfaction is closed by the sole-State
////     rules on BOTH inputs and outputs (the V-01 lesson).

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use susdr/exchange

// ---------------------------------------------------------------- datum

pub type StableState {
  /// USDr asset identity this vault accounts (policy id + asset name).
  usdr_policy: ByteArray,
  usdr_name: ByteArray,
  /// Total sUSDr shares in circulation (includes treasury shares).
  total_shares: Int,
  /// Total USDr units accounted; must equal the USDr locked at the script.
  total_assets: Int,
  /// Monotonic replay counter; forces one State transition per tx.
  epoch: Int,
  /// M-of-N operator committee.
  operators: List<ByteArray>,
  threshold: Int,
  paused: Bool,
  /// Fee on reported yield, in bps, capped by exchange.max_yield_fee_bps.
  yield_fee_bps: Int,
  treasury: ByteArray,
  treasury_shares: Int,
}

pub type StableRedeemer {
  /// Lock `amount` USDr, mint matching sUSDr to the depositor.
  Deposit { amount: Int }
  /// Burn `shares` sUSDr, withdraw the redeemable USDr.
  Redeem { shares: Int }
  /// Operators report `gross_yield` USDr of real yield (deposited in this
  /// same tx). Fee is settled as treasury shares.
  ReportYield { gross_yield: Int }
  SetPaused { paused: Bool }
  SetFee { yield_fee_bps: Int }
  /// Treasury converts `shares` of its fee shares into USDr.
  ClaimFee { shares: Int }
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

/// Exactly one State-shaped UTxO in the list — on BOTH sides of every
/// transition (the V-01 rule from the ADA vault's audit, applied from day
/// one here).
fn sole_state(outs: List<Output>) -> Option<(Output, StableState)> {
  let states =
    outs
      |> list.filter_map(
          fn(o) {
            when o.datum is {
              InlineDatum(d) ->
                if d is s: StableState {
                  Some((o, s))
                } else {
                  None
                }
              _ -> None
            }
          },
        )
  when states is {
    [only] -> Some(only)
    _ -> None
  }
}

fn threshold_met(state: StableState, signatories: List<ByteArray>) -> Bool {
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

/// The accounted assets must equal the USDr actually held by the State
/// output — and the State output may hold ONLY that USDr plus min-ADA
/// (no foreign tokens riding along to inflate min-ADA and strand funds).
fn state_value_matches(out: Output, s: StableState) -> Bool {
  let usdr_held = quantity_of(out.value, s.usdr_policy, s.usdr_name)
  let policies = assets.policies(out.value)
  let only_expected =
    list.all(
      policies,
      fn(p) { p == assets.ada_policy_id || p == s.usdr_policy },
    )
  usdr_held == s.total_assets && only_expected
}

fn committee_unchanged(a: StableState, b: StableState) -> Bool {
  a.operators == b.operators && a.threshold == b.threshold && a.treasury == b.treasury && a.usdr_policy == b.usdr_policy && a.usdr_name == b.usdr_name
}

fn lower_bound_time(tx: Transaction) -> Option<Int> {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(t) -> Some(t)
    _ -> None
  }
}

/// sUSDr minted/burned by this policy in this tx (single token name "sUSDr").
fn susdr_delta(tx: Transaction, own_policy: PolicyId) -> Int {
  let names = assets.tokens(tx.mint, own_policy) |> dict.to_pairs
  when names is {
    [] -> 0
    [Pair(name, qty)] ->
      if name == "sUSDr" {
        qty
      } else {
        fail @"foreign token name under sUSDr policy"
      }
    _ -> fail @"multiple token names under sUSDr policy"
  }
}

// ---------------------------------------------------------------- validator

validator susdr_vault(_version: Int) {
  spend(
    datum: Option<StableState>,
    redeemer: StableRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(s0) = datum
    // Resolve our own script hash from the spent input.
    expect Some(own_input) =
      tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
    expect Script(own_hash) = own_input.output.address.payment_credential

    let ins = own_script_inputs(tx.inputs, own_hash)
    let outs = own_script_outputs(tx.outputs, own_hash)

    // V-01 from day one: exactly one State on both sides.
    expect Some(_) = sole_state(ins)
    expect Some((next_out, s1)) = sole_state(outs)

    // Universal invariants for every transition.
    let structural =
      committee_unchanged(s0, s1) && operators_valid(s1.operators, s1.threshold) && s1.epoch == s0.epoch + 1 && state_value_matches(
        next_out,
        s1,
      ) && exchange.fee_bps_ok(s1.yield_fee_bps)

    let minted = susdr_delta(tx, own_hash)

    when redeemer is {
      Deposit { amount } -> {
        let shares =
          exchange.mint_shares(amount, s0.total_shares, s0.total_assets)
        structural && !s0.paused && exchange.deposit_ok(
          amount,
          s0.total_shares,
          s0.total_assets,
        ) && s1.total_assets == s0.total_assets + amount && s1.total_shares == s0.total_shares + shares && s1.treasury_shares == s0.treasury_shares && s1.paused == s0.paused && s1.yield_fee_bps == s0.yield_fee_bps && minted == shares
      }

      Redeem { shares } -> {
        let payout =
          exchange.redeem_value(shares, s0.total_shares, s0.total_assets)
        // Redemption is bearer-authorized: burning the sUSDr IS the
        // authorization (unlike the ADA vault's owner-signature model).
        // Depositor shares only: the treasury's fee shares exit via
        // ClaimFee, never through the public Redeem path.
        structural && shares > 0 && shares <= s0.total_shares - s0.treasury_shares && s1.total_assets == s0.total_assets - payout && s1.total_shares == s0.total_shares - shares && s1.treasury_shares == s0.treasury_shares && s1.paused == s0.paused && s1.yield_fee_bps == s0.yield_fee_bps && minted == -shares
      }

      ReportYield { gross_yield } -> {
        // Anti-manipulation: needs M-of-N operators AND a bounded validity
        // range (so reports are anchored in time for off-chain APY calc),
        // AND the USDr must actually arrive — total_assets rises by exactly
        // gross_yield and the value check enforces it landed at the script.
        let fee = exchange.yield_fee(gross_yield, s0.yield_fee_bps)
        let fee_shares =
          exchange.fee_shares_for(s0.total_shares, s0.total_assets + gross_yield, fee)
        expect Some(_now) = lower_bound_time(tx)
        structural && threshold_met(s0, tx.extra_signatories) && gross_yield > 0 && s0.total_shares > 0 && s1.total_assets == s0.total_assets + gross_yield && s1.total_shares == s0.total_shares + fee_shares && s1.treasury_shares == s0.treasury_shares + fee_shares && s1.paused == s0.paused && s1.yield_fee_bps == s0.yield_fee_bps && minted == 0
      }

      SetPaused { paused } ->
        structural && threshold_met(s0, tx.extra_signatories) && s1.paused == paused && s1.total_assets == s0.total_assets && s1.total_shares == s0.total_shares && s1.treasury_shares == s0.treasury_shares && s1.yield_fee_bps == s0.yield_fee_bps && minted == 0

      SetFee { yield_fee_bps } ->
        structural && threshold_met(s0, tx.extra_signatories) && exchange.fee_bps_ok(
          yield_fee_bps,
        ) && s1.yield_fee_bps == yield_fee_bps && s1.total_assets == s0.total_assets && s1.total_shares == s0.total_shares && s1.treasury_shares == s0.treasury_shares && s1.paused == s0.paused && minted == 0

      ClaimFee { shares } -> {
        let payout =
          exchange.redeem_value(shares, s0.total_shares, s0.total_assets)
        let paid_to_treasury =
          tx.outputs
            |> list.any(
                fn(o) {
                  when o.address.payment_credential is {
                    address.VerificationKey(k) ->
                      k == s0.treasury && quantity_of(
                        o.value,
                        s0.usdr_policy,
                        s0.usdr_name,
                      ) >= payout
                    _ -> False
                  }
                },
              )
        structural && threshold_met(s0, tx.extra_signatories) && shares > 0 && shares <= s0.treasury_shares && paid_to_treasury && s1.total_assets == s0.total_assets - payout && s1.total_shares == s0.total_shares - shares && s1.treasury_shares == s0.treasury_shares - shares && s1.paused == s0.paused && s1.yield_fee_bps == s0.yield_fee_bps && minted == 0
      }
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    // sUSDr may only move when the vault State transitions in the same tx:
    // the spend handler above then enforces the exact quantity. Here we only
    // require that a State input under our own hash is being spent.
    let vault_ins = own_script_inputs(tx.inputs, policy_id)
    when sole_state(vault_ins) is {
      Some(_) -> True
      None -> False
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_usdr_policy: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

const t_own_hash: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_treasury: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

fn t_state(shares: Int, total: Int, epoch: Int, tshares: Int) -> StableState {
  StableState {
    usdr_policy: t_usdr_policy,
    usdr_name: "USDr",
    total_shares: shares,
    total_assets: total,
    epoch,
    operators: [t_op1, t_op2],
    threshold: 2,
    paused: False,
    yield_fee_bps: 1000,
    treasury: t_treasury,
    treasury_shares: tshares,
  }
}

fn vault_addr() -> Address {
  Address { payment_credential: Script(t_own_hash), stake_credential: None }
}

fn state_out(s: StableState) -> Output {
  Output {
    address: vault_addr(),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(t_usdr_policy, "USDr", s.total_assets),
    datum: InlineDatum(s),
    reference_script: None,
  }
}

fn state_in(s: StableState) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
      output_index: 0,
    },
    output: state_out(s),
  }
}

fn mint_susdr(qty: Int) -> assets.Value {
  assets.from_asset(t_own_hash, "sUSDr", qty)
}

fn base_tx(s0: StableState, s1: StableState, minted: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [state_in(s0)],
    outputs: [state_out(s1)],
    mint: mint_susdr(minted),
  }
}

fn ref0() -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }
}

test deposit_bootstraps_one_to_one() {
  let s0 = t_state(0, 0, 0, 0)
  let s1 = t_state(10_000_000, 10_000_000, 1, 0)
  let tx = base_tx(s0, s1, 10_000_000)
  susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test deposit_below_minimum_is_rejected() {
  let s0 = t_state(0, 0, 0, 0)
  let s1 = t_state(9_999_999, 9_999_999, 1, 0)
  let tx = base_tx(s0, s1, 9_999_999)
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 9_999_999 }, ref0(), tx)
}

test deposit_cannot_mint_extra_susdr() {
  // attacker deposits 10 but tries to write 11 shares / mint 11 sUSDr
  let s0 = t_state(0, 0, 0, 0)
  let s1 = t_state(11_000_000, 10_000_000, 1, 0)
  let tx = base_tx(s0, s1, 11_000_000)
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test deposit_assets_must_actually_arrive() {
  // datum claims +10 USDr but the state output only holds the old amount
  let s0 = t_state(100_000_000, 100_000_000, 0, 0)
  let s1 = t_state(110_000_000, 110_000_000, 1, 0)
  let cheat_out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_usdr_policy, "USDr", 100_000_000),
      datum: InlineDatum(s1),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0)],
      outputs: [cheat_out],
      mint: mint_susdr(10_000_000),
    }
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test deposit_fails_while_paused() {
  let s0 = StableState { ..t_state(0, 0, 0, 0), paused: True }
  let s1 = StableState { ..t_state(10_000_000, 10_000_000, 1, 0), paused: True }
  let tx = base_tx(s0, s1, 10_000_000)
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test redeem_pays_out_with_yield() {
  // rate is 1.08; redeeming half the shares takes half the assets
  let s0 = t_state(100_000_000, 108_000_000, 5, 0)
  let s1 = t_state(50_000_000, 54_000_000, 6, 0)
  let tx = base_tx(s0, s1, -50_000_000)
  susdr_vault.spend(1, Some(s0), Redeem { shares: 50_000_000 }, ref0(), tx)
}

test redeem_without_burning_is_rejected() {
  let s0 = t_state(100_000_000, 108_000_000, 5, 0)
  let s1 = t_state(50_000_000, 54_000_000, 6, 0)
  let tx = base_tx(s0, s1, 0)
  !susdr_vault.spend(1, Some(s0), Redeem { shares: 50_000_000 }, ref0(), tx)
}

test redeem_cannot_take_more_than_rate_allows() {
  // burn 50 shares but datum tries to release 60 assets
  let s0 = t_state(100_000_000, 108_000_000, 5, 0)
  let s1 = t_state(50_000_000, 48_000_000, 6, 0)
  let tx = base_tx(s0, s1, -50_000_000)
  !susdr_vault.spend(1, Some(s0), Redeem { shares: 50_000_000 }, ref0(), tx)
}

test redeem_cannot_touch_treasury_shares() {
  // 100 total shares of which 10 are treasury: redeeming 95 exceeds the
  // depositor-owned 90
  let s0 = t_state(100_000_000, 108_000_000, 5, 10_000_000)
  let payout = exchange.redeem_value(95_000_000, 100_000_000, 108_000_000)
  let s1 =
    t_state(5_000_000, 108_000_000 - payout, 6, 10_000_000)
  let tx = base_tx(s0, s1, -95_000_000)
  !susdr_vault.spend(1, Some(s0), Redeem { shares: 95_000_000 }, ref0(), tx)
}

test yield_report_raises_rate_and_settles_fee() {
  // 100 shares / 100 assets, report 10 USDr gross at 10% fee:
  // fee = 1 USDr; fee_shares = 1_000_000*100_000_000/109_000_000 = 917_431
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let fee_shares =
    exchange.fee_shares_for(100_000_000, 110_000_000, 1_000_000)
  let s1 =
    t_state(100_000_000 + fee_shares, 110_000_000, 4, fee_shares)
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      extra_signatories: [t_op1, t_op2],
      validity_range: interval.after(1_000_000),
    }
  susdr_vault.spend(1, Some(s0), ReportYield { gross_yield: 10_000_000 }, ref0(), tx)
}

test yield_report_cannot_skip_the_fee() {
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  // operators try to report yield without minting treasury shares
  let s1 = t_state(100_000_000, 110_000_000, 4, 0)
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      extra_signatories: [t_op1, t_op2],
      validity_range: interval.after(1_000_000),
    }
  !susdr_vault.spend(1, Some(s0), ReportYield { gross_yield: 10_000_000 }, ref0(), tx)
}

test yield_report_needs_the_committee() {
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let fee_shares =
    exchange.fee_shares_for(100_000_000, 110_000_000, 1_000_000)
  let s1 = t_state(100_000_000 + fee_shares, 110_000_000, 4, fee_shares)
  let tx =
    Transaction {
      ..base_tx(s0, s1, 0),
      extra_signatories: [t_op1],
      validity_range: interval.after(1_000_000),
    }
  !susdr_vault.spend(1, Some(s0), ReportYield { gross_yield: 10_000_000 }, ref0(), tx)
}

test yield_report_needs_bounded_validity() fail {
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let fee_shares =
    exchange.fee_shares_for(100_000_000, 110_000_000, 1_000_000)
  let s1 = t_state(100_000_000 + fee_shares, 110_000_000, 4, fee_shares)
  let tx =
    Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1, t_op2] }
  susdr_vault.spend(1, Some(s0), ReportYield { gross_yield: 10_000_000 }, ref0(), tx)
}

test yield_must_actually_arrive() {
  // datum says +10 but state output holds the old balance
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let fee_shares =
    exchange.fee_shares_for(100_000_000, 110_000_000, 1_000_000)
  let s1 = t_state(100_000_000 + fee_shares, 110_000_000, 4, fee_shares)
  let cheat_out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_usdr_policy, "USDr", 100_000_000),
      datum: InlineDatum(s1),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0)],
      outputs: [cheat_out],
      extra_signatories: [t_op1, t_op2],
      validity_range: interval.after(1_000_000),
    }
  !susdr_vault.spend(1, Some(s0), ReportYield { gross_yield: 10_000_000 }, ref0(), tx)
}

test fee_above_cap_is_rejected() {
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let s1 = StableState { ..t_state(100_000_000, 100_000_000, 4, 0), yield_fee_bps: 2001 }
  let tx =
    Transaction { ..base_tx(s0, s1, 0), extra_signatories: [t_op1, t_op2] }
  !susdr_vault.spend(1, Some(s0), SetFee { yield_fee_bps: 2001 }, ref0(), tx)
}

test committee_cannot_be_swapped_during_deposit() {
  let s0 = t_state(0, 0, 0, 0)
  let s1 =
    StableState {
      ..t_state(10_000_000, 10_000_000, 1, 0),
      operators: [t_op1],
      threshold: 1,
    }
  let tx = base_tx(s0, s1, 10_000_000)
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test two_state_inputs_are_rejected() fail {
  // The V-01 rule, present from day one: collapsing two States must fail.
  let s0 = t_state(100_000_000, 100_000_000, 3, 0)
  let planted = t_state(5, 5, 0, 0)
  let s1 = t_state(110_000_000, 110_000_000, 4, 0)
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0), state_in(planted)],
      outputs: [state_out(s1)],
      mint: mint_susdr(10_000_000),
    }
  susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test foreign_tokens_cannot_ride_in_the_state() {
  // an attacker attaching a junk token to the state output must fail
  let s0 = t_state(0, 0, 0, 0)
  let s1 = t_state(10_000_000, 10_000_000, 1, 0)
  let junk_out =
    Output {
      address: vault_addr(),
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_usdr_policy, "USDr", 10_000_000)
        |> assets.add(#"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "JUNK", 1),
      datum: InlineDatum(s1),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0)],
      outputs: [junk_out],
      mint: mint_susdr(10_000_000),
    }
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test epoch_must_increment() {
  let s0 = t_state(0, 0, 7, 0)
  let s1 = t_state(10_000_000, 10_000_000, 7, 0)
  let tx = base_tx(s0, s1, 10_000_000)
  !susdr_vault.spend(1, Some(s0), Deposit { amount: 10_000_000 }, ref0(), tx)
}

test treasury_can_claim_fee_shares() {
  let s0 = t_state(100_917_431, 110_000_000, 4, 917_431)
  let payout = exchange.redeem_value(917_431, 100_917_431, 110_000_000)
  let s1 = t_state(100_000_000, 110_000_000 - payout, 5, 0)
  let treasury_out =
    Output {
      address: Address {
        payment_credential: address.VerificationKey(t_treasury),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_usdr_policy, "USDr", payout),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0)],
      outputs: [state_out(s1), treasury_out],
      extra_signatories: [t_op1, t_op2],
    }
  susdr_vault.spend(1, Some(s0), ClaimFee { shares: 917_431 }, ref0(), tx)
}

test fee_claim_must_pay_the_treasury() {
  // same as above but the payout goes to op1 instead of the treasury
  let s0 = t_state(100_917_431, 110_000_000, 4, 917_431)
  let payout = exchange.redeem_value(917_431, 100_917_431, 110_000_000)
  let s1 = t_state(100_000_000, 110_000_000 - payout, 5, 0)
  let rogue_out =
    Output {
      address: Address {
        payment_credential: address.VerificationKey(t_op1),
        stake_credential: None,
      },
      value: assets.from_lovelace(2_000_000)
        |> assets.add(t_usdr_policy, "USDr", payout),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [state_in(s0)],
      outputs: [state_out(s1), rogue_out],
      extra_signatories: [t_op1, t_op2],
    }
  !susdr_vault.spend(1, Some(s0), ClaimFee { shares: 917_431 }, ref0(), tx)
}

test susdr_mint_requires_a_state_transition() {
  // minting sUSDr in a tx that doesn't spend the vault State must fail
  let tx = Transaction { ..transaction.placeholder, mint: mint_susdr(5) }
  !susdr_vault.mint(1, Void, t_own_hash, tx)
}
