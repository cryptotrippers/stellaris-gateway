//// Tessera first-loss reserve (Phase 2.5b, SPEC.md §3a.1).
////
//// One script UTxO holding TSRA that exists only to be burned against a loss.
//// Parameterised by `(seed, reserve)`; the script is the spending validator
//// and the minting policy of its own one-shot `state` thread token, which
//// marks the genuine UTxO (the same pattern as the vault and the reserve).
////
//// * `Deposit{qty}`: anyone; `qty > 0` TSRA arrive, `balance += qty`. The vault
////   uses it for the funded half of the protocol cut (capped at 3% of the
////   minted supply) and for the sweeps (dead class, last exit).
//// * `Draw{qty, deposit}`: the reserve committee; `0 < qty <= balance`, the
////   same `qty` TSRA must be burned in this transaction (a negative TSRA mint
////   under the reserve's policy, which only the reserve's `LossBurn` can do),
////   and `deposit >= 0` TSRA may arrive in the same step (a sweep).
//// * There is no other exit: first-loss TSRA is never paid to an address.
////
//// The committee is read live from the reserve Config: the Config that is
//// being SPENT in this transaction if there is one (`ReportLoss` spends it),
//// otherwise the one referenced.

use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use stellaris/outputs.{continuing_ok, genesis_out_ok, keeps_lovelace}
use stellaris/thread.{one_shot_mint, thread_name, thread_value}
use tessera/first_loss_state.{FirstLossState, first_loss_among}
use tessera/loss_fixture
use tessera/reserve_ref.{config_among, genuine_config}
use tessera/reserve_state.{ConfigDatum, ConfigState, threshold_met}
use tessera/reserve_threads.{config_value}
use tessera/rules

pub type FirstLossRedeemer {
  Deposit { qty: Int }
  Draw { qty: Int, deposit: Int }
}

/// The exact value of the UTxO holding `balance`: ADA, the thread token and
/// `balance` TSRA.
fn value_ok(out: Output, policy: PolicyId, reserve: PolicyId, balance: Int) -> Bool {
  assets.without_lovelace(out.value) == assets.merge(
    thread_value(policy),
    assets.from_asset(reserve, rules.tsra_name, balance),
  )
}

/// The committee's Config: the one being spent, else the one referenced.
fn committee_config(tx: Transaction, reserve: PolicyId) -> Option<ConfigState> {
  when config_among(list.map(tx.inputs, fn(i) { i.output }), reserve) is {
    Some(c) -> Some(c)
    None -> genuine_config(tx, reserve)
  }
}

/// TSRA minted (positive) or burned (negative) under the reserve policy.
fn tsra_delta(tx: Transaction, reserve: PolicyId) -> Int {
  quantity_of(tx.mint, reserve, rules.tsra_name)
}

fn genesis(tx: Transaction, policy: PolicyId, seed: OutputReference, reserve: PolicyId) -> Bool {
  let outs =
    tx.outputs
      |> list.filter(fn(o) { o.address.payment_credential == Script(policy) })
  when outs is {
    [boot] ->
      when first_loss_among(outs, policy) is {
        Some(s) ->
          and {
            one_shot_mint(tx, policy, seed),
            list.all(
              tx.inputs,
              fn(i) { i.output.address.payment_credential != Script(policy) },
            ),
            genesis_out_ok(boot, policy),
            value_ok(boot, policy, reserve, 0),
            s == FirstLossState { balance: 0, epoch: 0 },
          }
        None -> False
      }
    _ -> False
  }
}

validator first_loss(seed: OutputReference, reserve: PolicyId) {
  spend(
    datum: Option<FirstLossState>,
    redeemer: FirstLossRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(s0) = datum
    expect Some(own_in) =
      tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
    expect Script(policy) = own_in.output.address.payment_credential
    let ins =
      tx.inputs
        |> list.filter_map(
            fn(i) {
              if i.output.address.payment_credential == Script(policy) {
                Some(i.output)
              } else {
                None
              }
            },
          )
    let outs =
      tx.outputs
        |> list.filter(fn(o) { o.address.payment_credential == Script(policy) })
    // F-1: exactly one genuine first-loss State on both sides, and the input
    // being spent is that State.
    expect Some(s_in) = first_loss_among(ins, policy)
    expect Some(s1) = first_loss_among(outs, policy)
    expect [next_out] = outs
    let structural =
      and {
        list.length(ins) == 1,
        s_in == s0,
        quantity_of(own_in.output.value, policy, thread_name) == 1,
        value_ok(next_out, policy, reserve, s1.balance),
        continuing_ok(next_out, own_in.output),
        keeps_lovelace(next_out, own_in.output),
        s1.epoch == s0.epoch + 1,
        s1.balance >= 0,
      }
    when redeemer is {
      Deposit { qty } ->
        and {
          structural,
          qty > 0,
          s1.balance == s0.balance + qty,
        }
      Draw { qty, deposit } -> {
        expect Some(cfg) = committee_config(tx, reserve)
        and {
          structural,
          qty > 0,
          qty <= s0.balance,
          deposit >= 0,
          threshold_met(cfg.operators, cfg.threshold, tx.extra_signatories),
          // the drawn TSRA is burned in this very transaction
          -tsra_delta(tx, reserve) >= qty,
          s1.balance == s0.balance - qty + deposit,
        }
      }
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    genesis(tx, policy_id, seed, reserve)
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_own: PolicyId =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

const t_res: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_op3: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 3,
  }
}

fn ref(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0505050505050505050505050505050505050505050505050505050505050505",
    output_index: i,
  }
}

fn fl_addr() -> Address {
  Address { payment_credential: Script(t_own), stake_credential: None }
}

fn wallet(k: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(k), stake_credential: None }
}

fn ada() -> assets.Value {
  assets.from_lovelace(2_000_000)
}

fn tsra(q: Int) -> assets.Value {
  assets.from_asset(t_res, rules.tsra_name, q)
}

fn fl_out_with(balance: Int, epoch: Int, with_token: Bool) -> Output {
  let base = ada() |> assets.merge(tsra(balance))
  Output {
    address: fl_addr(),
    value: if with_token {
      base |> assets.merge(thread_value(t_own))
    } else {
      base
    },
    datum: InlineDatum(FirstLossState { balance, epoch }),
    reference_script: None,
  }
}

fn fl_out(balance: Int, epoch: Int) -> Output {
  fl_out_with(balance, epoch, True)
}

fn fl_in(balance: Int) -> Input {
  Input { output_reference: ref(0), output: fl_out(balance, 4) }
}

fn t_cfg() -> ConfigState {
  ConfigState {
    operators: [t_op1, t_op2, t_op3],
    threshold: 2,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: #"77777777777777777777777777777777777777777777777777777777",
    vault_policy: #"",
    loss_pending_until: 0,
    epoch: 0,
  }
}

fn cfg_utxo(c: ConfigState, with_token: Bool) -> Output {
  Output {
    address: Address { payment_credential: Script(t_res), stake_credential: None },
    value: if with_token {
      ada() |> assets.merge(config_value(t_res))
    } else {
      ada()
    },
    datum: InlineDatum(ConfigDatum(c)),
    reference_script: None,
  }
}

fn cfg_ref() -> Input {
  Input { output_reference: ref(9), output: cfg_utxo(t_cfg(), True) }
}

fn s0(balance: Int) -> FirstLossState {
  FirstLossState { balance, epoch: 4 }
}

fn run(balance: Int, rd: FirstLossRedeemer, tx: Transaction) -> Bool {
  first_loss.spend(t_seed(), t_res, Some(s0(balance)), rd, ref(0), tx)
}

/// The first-loss State goes from `b0` to `b1` TSRA (epoch + 1).
fn move_tx(b0: Int, b1: Int, mint_delta: Int, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [fl_in(b0)],
    reference_inputs: [cfg_ref()],
    outputs: [fl_out(b1, 5)],
    mint: tsra(mint_delta),
    extra_signatories: signers,
  }
}

// -- Genesis

fn genesis_tx(outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [
      Input {
        output_reference: t_seed(),
        output: Output {
          address: wallet(t_op1),
          value: assets.from_lovelace(5_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      },
    ],
    outputs: outputs,
    mint: thread_value(t_own),
  }
}

fn boot(tx: Transaction) -> Bool {
  first_loss.mint(t_seed(), t_res, Void, t_own, tx)
}

test good_genesis_is_accepted() {
  boot(genesis_tx([fl_out(0, 0)]))
}

test genesis_with_a_balance_is_rejected() {
  !boot(genesis_tx([fl_out(1, 0)]))
}

test genesis_with_a_non_zero_epoch_is_rejected() {
  !boot(genesis_tx([fl_out(0, 1)]))
}

test genesis_without_the_seed_is_rejected() {
  let tx = genesis_tx([fl_out(0, 0)])
  !boot(
    Transaction {
      ..tx,
      inputs: [Input { output_reference: ref(7), output: fl_out(0, 0) }],
    },
  )
}

test genesis_mints_exactly_one_thread_token() {
  let two = assets.from_asset(t_own, thread_name, 2)
  let extra = thread_value(t_own) |> assets.add(t_own, "x", 1)
  !boot(Transaction { ..genesis_tx([fl_out(0, 0)]), mint: two }) && !boot(
    Transaction { ..genesis_tx([fl_out(0, 0)]), mint: extra },
  )
}

test the_thread_token_can_never_be_burned() {
  !boot(
    Transaction {
      ..genesis_tx([fl_out(0, 0)]),
      mint: assets.from_asset(t_own, thread_name, -1),
    },
  )
}

test genesis_token_sent_elsewhere_is_rejected() {
  let to_wallet =
    Output {
      address: wallet(t_op1),
      value: ada() |> assets.merge(thread_value(t_own)),
      datum: NoDatum,
      reference_script: None,
    }
  !boot(genesis_tx([fl_out_with(0, 0, False), to_wallet]))
}

test genesis_with_two_outputs_is_rejected() {
  !boot(genesis_tx([fl_out(0, 0), fl_out(0, 0)]))
}

test genesis_state_holding_tsra_is_rejected() {
  let fat = Output { ..fl_out(0, 0), value: fl_out(0, 0).value |> assets.merge(tsra(5)) }
  !boot(genesis_tx([fat]))
}

test genesis_state_holding_a_foreign_token_is_rejected() {
  let junk = Output { ..fl_out(0, 0), value: fl_out(0, 0).value |> assets.add(t_op1, "x", 1) }
  !boot(genesis_tx([junk]))
}

test genesis_cannot_spend_a_first_loss_input() {
  let tx = genesis_tx([fl_out(0, 0)])
  !boot(Transaction { ..tx, inputs: list.concat(tx.inputs, [fl_in(0)]) })
}

test genesis_output_keeps_the_enterprise_address_and_no_script() {
  let staked =
    Address {
      payment_credential: Script(t_own),
      stake_credential: Some(address.Inline(VerificationKey(t_op2))),
    }
  !boot(genesis_tx([Output { ..fl_out(0, 0), address: staked }])) && !boot(
    genesis_tx([Output { ..fl_out(0, 0), reference_script: Some(t_op1) }]),
  )
}

test genesis_without_a_datum_is_rejected() fail {
  boot(genesis_tx([Output { ..fl_out(0, 0), datum: NoDatum }]))
}

// -- Deposit

test a_deposit_raises_the_balance_by_exactly_the_tsra_arriving() {
  run(100, Deposit { qty: 50 }, move_tx(100, 150, 0, []))
}

test a_deposit_needs_no_signature() {
  let tx = move_tx(100, 150, 0, [])
  tx.extra_signatories == [] && run(100, Deposit { qty: 50 }, tx)
}

test a_deposit_of_nothing_is_rejected() {
  !run(100, Deposit { qty: 0 }, move_tx(100, 100, 0, []))
}

test a_negative_deposit_is_rejected() {
  !run(100, Deposit { qty: -10 }, move_tx(100, 90, 0, []))
}

test a_deposit_must_match_the_datum() {
  !run(100, Deposit { qty: 40 }, move_tx(100, 150, 0, []))
}

test a_deposit_whose_tsra_never_arrived_is_rejected() {
  let tx = move_tx(100, 150, 0, [])
  let thin =
    Output {
      ..fl_out(150, 5),
      value: ada() |> assets.merge(thread_value(t_own)) |> assets.merge(tsra(100)),
    }
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [thin] })
}

test a_deposit_cannot_take_tsra_out() {
  let tx = move_tx(100, 150, 0, [])
  let skim =
    Output {
      ..fl_out(150, 5),
      value: ada() |> assets.merge(thread_value(t_own)) |> assets.merge(tsra(90)),
    }
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [skim] })
}

test a_deposit_must_bump_the_epoch() {
  let tx = move_tx(100, 150, 0, [])
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [fl_out(150, 4)] }) && !run(
    100,
    Deposit { qty: 50 },
    Transaction { ..tx, outputs: [fl_out(150, 6)] },
  )
}

test a_deposit_into_an_empty_reserve_is_accepted() {
  run(0, Deposit { qty: 7 }, move_tx(0, 7, 0, []))
}

// -- Draw

fn draw(
  b0: Int,
  b1: Int,
  qty: Int,
  deposit: Int,
  mint_delta: Int,
  signers: List<ByteArray>,
) -> Bool {
  run(b0, Draw { qty, deposit }, move_tx(b0, b1, mint_delta, signers))
}

test the_committee_can_draw_and_burn() {
  draw(100, 60, 40, 0, -40, [t_op1, t_op2])
}

test a_draw_needs_the_committee() {
  and {
    !draw(100, 60, 40, 0, -40, [t_op1]),
    !draw(100, 60, 40, 0, -40, []),
    !draw(100, 60, 40, 0, -40, [t_op1, t_op1]),
  }
}

test a_draw_signed_by_strangers_is_rejected() {
  !draw(
    100,
    60,
    40,
    0,
    -40,
    [#"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd", t_op1],
  )
}

test a_draw_follows_the_reserve_committee() {
  let rotated = ConfigState { ..t_cfg(), operators: [t_op2, t_op3] }
  let tx =
    Transaction {
      ..move_tx(100, 60, -40, [t_op1, t_op2]),
      reference_inputs: [Input { output_reference: ref(9), output: cfg_utxo(rotated, True) }],
    }
  !run(100, Draw { qty: 40, deposit: 0 }, tx) && run(
    100,
    Draw { qty: 40, deposit: 0 },
    Transaction { ..tx, extra_signatories: [t_op2, t_op3] },
  )
}

test a_draw_takes_the_committee_from_the_spent_config() {
  // ReportLoss spends the Config: the spent datum's committee is the one
  let spent = Input { output_reference: ref(8), output: cfg_utxo(t_cfg(), True) }
  let tx = move_tx(100, 60, -40, [t_op1, t_op2])
  run(
    100,
    Draw { qty: 40, deposit: 0 },
    Transaction { ..tx, inputs: [fl_in(100), spent], reference_inputs: [] },
  )
}

test a_draw_prefers_the_spent_config_over_a_referenced_one() {
  // the referenced Config would let op3 sign; the spent one does not
  let rotated = ConfigState { ..t_cfg(), operators: [t_op2, t_op3] }
  let spent = Input { output_reference: ref(8), output: cfg_utxo(t_cfg(), True) }
  let tx = move_tx(100, 60, -40, [t_op3, t_op3])
  !run(
    100,
    Draw { qty: 40, deposit: 0 },
    Transaction {
      ..tx,
      inputs: [fl_in(100), spent],
      reference_inputs: [Input { output_reference: ref(9), output: cfg_utxo(rotated, True) }],
    },
  )
}

test a_draw_with_a_planted_config_is_rejected() fail {
  let evil = ConfigState { ..t_cfg(), operators: [t_op3, t_op3] }
  let planted = Input { output_reference: ref(9), output: cfg_utxo(evil, False) }
  run(
    100,
    Draw { qty: 40, deposit: 0 },
    Transaction { ..move_tx(100, 60, -40, [t_op3]), reference_inputs: [planted] },
  )
}

test a_draw_without_any_config_is_rejected() fail {
  run(
    100,
    Draw { qty: 40, deposit: 0 },
    Transaction { ..move_tx(100, 60, -40, [t_op1, t_op2]), reference_inputs: [] },
  )
}

test a_draw_must_be_burned_in_the_same_transaction() {
  and {
    !draw(100, 60, 40, 0, 0, [t_op1, t_op2]),
    !draw(100, 60, 40, 0, -39, [t_op1, t_op2]),
    !draw(100, 60, 40, 0, 40, [t_op1, t_op2]),
  }
}

test a_draw_may_burn_more_than_it_takes() {
  // the rest of the burn comes from elsewhere in the same ReportLoss
  draw(100, 60, 40, 0, -400, [t_op1, t_op2])
}

test a_draw_cannot_exceed_the_balance() {
  !draw(100, -1, 101, 0, -101, [t_op1, t_op2]) && draw(100, 0, 100, 0, -100, [t_op1, t_op2])
}

test a_draw_of_nothing_or_less_is_rejected() {
  !draw(100, 100, 0, 0, 0, [t_op1, t_op2]) && !draw(100, 110, -10, 0, 10, [t_op1, t_op2])
}

test a_draw_may_take_a_sweep_in_the_same_step() {
  // 40 burned out, 15 swept in: 100 - 40 + 15
  draw(100, 75, 40, 15, -40, [t_op1, t_op2])
}

test a_draw_must_account_for_the_deposit_exactly() {
  and {
    !draw(100, 76, 40, 15, -40, [t_op1, t_op2]),
    !draw(100, 74, 40, 15, -40, [t_op1, t_op2]),
    !draw(100, 60, 40, 15, -40, [t_op1, t_op2]),
  }
}

test a_draw_cannot_deposit_a_negative_amount() {
  !draw(100, 55, 40, -5, -40, [t_op1, t_op2])
}

test a_draw_cannot_pay_the_tsra_to_an_address() {
  // the balance falls by 40 but the TSRA walks to a wallet instead of burning
  let tx = move_tx(100, 60, 0, [t_op1, t_op2])
  let out =
    Output {
      address: wallet(t_op1),
      value: ada() |> assets.merge(tsra(40)),
      datum: NoDatum,
      reference_script: None,
    }
  !run(100, Draw { qty: 40, deposit: 0 }, Transaction { ..tx, outputs: [fl_out(60, 5), out] })
}

test a_draw_must_bump_the_epoch() {
  let tx = move_tx(100, 60, -40, [t_op1, t_op2])
  !run(100, Draw { qty: 40, deposit: 0 }, Transaction { ..tx, outputs: [fl_out(60, 4)] })
}

// -- Identity and value

test a_planted_state_cannot_be_spent() fail {
  let planted = Input { output_reference: ref(0), output: fl_out_with(100, 4, False) }
  run(100, Deposit { qty: 50 }, Transaction { ..move_tx(100, 150, 0, []), inputs: [planted] })
}

test a_planted_input_beside_the_state_is_rejected() {
  let planted = Input { output_reference: ref(5), output: fl_out_with(100, 4, False) }
  let tx = move_tx(100, 150, 0, [])
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, inputs: [fl_in(100), planted] })
}

test the_state_may_not_carry_a_foreign_token() {
  let tx = move_tx(100, 150, 0, [])
  let junk = Output { ..fl_out(150, 5), value: fl_out(150, 5).value |> assets.add(t_op1, "junk", 1) }
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [junk] })
}

test the_state_keeps_its_exact_address() {
  let tx = move_tx(100, 150, 0, [])
  let staked =
    Address {
      payment_credential: Script(t_own),
      stake_credential: Some(address.Inline(VerificationKey(t_op2))),
    }
  !run(
    100,
    Deposit { qty: 50 },
    Transaction { ..tx, outputs: [Output { ..fl_out(150, 5), address: staked }] },
  )
}

test the_state_may_not_carry_a_reference_script() {
  let tx = move_tx(100, 150, 0, [])
  !run(
    100,
    Deposit { qty: 50 },
    Transaction { ..tx, outputs: [Output { ..fl_out(150, 5), reference_script: Some(t_op1) }] },
  )
}

test the_state_never_loses_lovelace() {
  let tx = move_tx(100, 150, 0, [])
  let poor =
    Output {
      ..fl_out(150, 5),
      value: assets.without_lovelace(fl_out(150, 5).value) |> assets.add("", "", 1_000_000),
    }
  !run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [poor] })
}

test the_state_may_gain_lovelace() {
  let tx = move_tx(100, 150, 0, [])
  let rich = Output { ..fl_out(150, 5), value: fl_out(150, 5).value |> assets.add("", "", 1_000_000) }
  run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [rich] })
}

test the_state_must_be_returned() fail {
  let tx = move_tx(100, 150, 0, [])
  run(100, Deposit { qty: 50 }, Transaction { ..tx, outputs: [] })
}

test a_second_first_loss_output_is_rejected() fail {
  let tx = move_tx(100, 150, 0, [])
  run(
    100,
    Deposit { qty: 50 },
    Transaction { ..tx, outputs: [fl_out(150, 5), fl_out_with(0, 0, False)] },
  )
}

test the_spent_datum_must_be_the_genuine_one() {
  // a redeemer run against a datum other than the UTxO's own is rejected
  !first_loss.spend(
    t_seed(),
    t_res,
    Some(FirstLossState { balance: 9_999, epoch: 4 }),
    Deposit { qty: 50 },
    ref(0),
    move_tx(100, 150, 0, []),
  )
}

test the_thread_token_cannot_be_minted_again_beside_a_move() {
  !boot(Transaction { ..move_tx(100, 150, 0, []), mint: thread_value(t_own) })
}

test the_worst_case_fixture_is_accepted_by_the_first_loss_state() {
  let f = loss_fixture.fixture()
  first_loss.spend(
    loss_fixture.ref(99),
    loss_fixture.reserve_policy,
    Some(f.fl0),
    Draw { qty: f.split.d, deposit: f.sweep },
    loss_fixture.ref(3),
    f.tx,
  )
}

test genesis_with_a_balance_in_the_datum_but_no_tsra_is_rejected() {
  let liar = Output { ..fl_out(0, 0), datum: InlineDatum(FirstLossState { balance: 5, epoch: 0 }) }
  !boot(genesis_tx([liar]))
}

test a_draw_cannot_take_more_than_the_balance_even_with_a_deposit() {
  // balance 10, draw 15, deposit 20: the burn would eat the incoming sweep
  !draw(10, 15, 15, 20, -15, [t_op1, t_op2]) && draw(10, 20, 10, 20, -10, [t_op1, t_op2])
}
