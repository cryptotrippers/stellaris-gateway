//// Stellaris yield vault — Stage 4 (share-accrual accounting).
////
//// This is a NEW validator, deliberately separate from `vault.ak`. The
//// deployed Stage 3 vault keeps working and its funds stay recoverable; this
//// one is the yield-bearing successor described in contracts/vault/YIELD.md.
////
//// Two kinds of UTxO live at the same applied `(version, asset_id)` address:
////
////   * exactly ONE `State` UTxO — the aggregate ledger (shares, assets,
////     epoch, operator set, pause flag). It must be an input and an output of
////     every action, so the accounting rules below run on every transaction.
////   * many `Position` UTxOs — one per depositor stake, pinning the owner
////     PKH and their share count.
////
//// Authorization split:
////   * spending a Position requires the OWNER's signature and an output back
////     to the owner (Stage 3 rule, retained);
////   * spending the State requires the transition to balance, and for
////     `Accrue` / `SetPaused` additionally M-of-N operator signatures.
////
//// All share arithmetic lives in `stellaris/shares` and is tested there.

use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use stellaris/shares.{
  VaultAccounting, deposit_ok, min_position_value, mint_shares, redeem_value,
}

pub type YieldDatum {
  /// A single depositor's stake.
  Position { owner: ByteArray, shares: Int }
  /// The vault's aggregate ledger. Exactly one per vault.
  State {
    total_shares: Int,
    total_assets: Int,
    epoch: Int,
    operators: List<ByteArray>,
    threshold: Int,
    paused: Bool,
  }
}

pub type YieldRedeemer {
  /// Add lovelace, mint shares at the current price.
  Deposit
  /// Burn `shares` from a position, take at most `redeem_value(shares)`.
  Withdraw { shares: Int }
  /// Operators add `amount` lovelace of yield; share count untouched.
  Accrue { amount: Int }
  /// Operators halt deposits and accruals. Withdrawals stay open.
  SetPaused { paused: Bool }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/// Payment credential of the UTxO being spent — this script's own hash.
fn own_hash(inputs: List<Input>, own_ref: OutputReference) -> Option<ByteArray> {
  when list.find(inputs, fn(i) { i.output_reference == own_ref }) is {
    Some(i) ->
      when i.output.address.payment_credential is {
        Script(h) -> Some(h)
        _ -> None
      }
    None -> None
  }
}

fn at_script(output: Output, hash: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(h) -> h == hash
    _ -> False
  }
}

fn datum_of(output: Output) -> Option<YieldDatum> {
  when output.datum is {
    InlineDatum(raw) -> {
      expect d: YieldDatum = raw
      Some(d)
    }
    _ -> None
  }
}

fn script_outputs(tx: Transaction, hash: ByteArray) -> List<Output> {
  list.filter(tx.outputs, fn(o) { at_script(o, hash) })
}

fn script_inputs(tx: Transaction, hash: ByteArray) -> List<Output> {
  list.map(
    list.filter(tx.inputs, fn(i) { at_script(i.output, hash) }),
    fn(i) { i.output },
  )
}

fn lovelace_sum(outs: List<Output>) -> Int {
  list.foldr(outs, 0, fn(o, acc) { acc + assets.lovelace_of(o.value) })
}

/// Total shares held by all Position UTxOs in `outs`.
fn position_shares(outs: List<Output>) -> Int {
  list.foldr(
    outs,
    0,
    fn(o, acc) {
      when datum_of(o) is {
        Some(Position { shares, .. }) -> acc + shares
        _ -> acc
      }
    },
  )
}

/// Every Position returned to the vault must carry a strictly positive share
/// count AND enough lovelace to satisfy min-ADA, so neither a zero-share
/// "ghost" position nor an unspendable dust remainder can be parked here.
/// Every output at this address must also carry a readable datum.
fn positions_well_formed(outs: List<Output>) -> Bool {
  list.all(
    outs,
    fn(o) {
      when datum_of(o) is {
        Some(Position { shares, .. }) ->
          shares > 0 && assets.lovelace_of(o.value) >= min_position_value
        Some(State { .. }) -> True
        None -> False
      }
    },
  )
}

/// The single State datum among `outs`, or None if there isn't exactly one.
fn sole_state(outs: List<Output>) -> Option<YieldDatum> {
  let states =
    list.filter(
      outs,
      fn(o) {
        when datum_of(o) is {
          Some(State { .. }) -> True
          _ -> False
        }
      },
    )
  when states is {
    [only] -> datum_of(only)
    _ -> None
  }
}

/// M-of-N: at least `threshold` DISTINCT operators signed.
fn threshold_met(
  operators: List<ByteArray>,
  threshold: Int,
  signatories: List<ByteArray>,
) -> Bool {
  let signed =
    list.filter(list.unique(operators), fn(op) { list.has(signatories, op) })
  threshold >= 1 && list.length(signed) >= threshold
}

/// Operator set sanity — enforced on every returned State output so it can
/// never be re-datumed to a weaker committee.
fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  threshold >= 1 && threshold <= n && list.length(list.unique(operators)) == n
}

/// The committee may not change through ordinary spending.
fn committee_unchanged(before: YieldDatum, after: YieldDatum) -> Bool {
  when (before, after) is {
    (
      State { operators: o0, threshold: t0, .. },
      State { operators: o1, threshold: t1, .. },
    ) -> o0 == o1 && t0 == t1
    _ -> False
  }
}

// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator yield_vault(_version: Int, _asset_id: ByteArray) {
  spend(
    datum: Option<YieldDatum>,
    redeemer: YieldRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(hash) = own_hash(tx.inputs, own_ref)

    let ins = script_inputs(tx, hash)
    let outs = script_outputs(tx, hash)

    when d is {
      // ----------------------------------------------------------
      // Spending a depositor position.
      // ----------------------------------------------------------
      Position { owner, .. } -> {
        let owner_signed = list.has(tx.extra_signatories, owner)
        let owner_paid =
          list.any(
            tx.outputs,
            fn(o) {
              when o.address.payment_credential is {
                VerificationKey(k) -> k == owner
                _ -> False
              }
            },
          )
        // The State UTxO must be spent in the same tx, which is what forces
        // the accounting branch below to run and balance the books.
        let state_present =
          when sole_state(ins) is {
            Some(_) -> True
            None -> False
          }
        owner_signed && owner_paid && state_present
      }

      // ----------------------------------------------------------
      // Spending the aggregate state: enforce the accounting transition.
      // ----------------------------------------------------------
      State { total_shares, total_assets, epoch, operators, threshold, paused } -> {
        expect Some(next) = sole_state(outs)
        expect State {
          total_shares: n_shares,
          total_assets: n_assets,
          epoch: n_epoch,
          paused: n_paused,
          ..
        } = next

        let acc = VaultAccounting { total_shares, total_assets }
        let locked_in = lovelace_sum(ins)
        let locked_out = lovelace_sum(outs)
        let value_delta = locked_out - locked_in
        let shares_in = position_shares(ins)
        let shares_out = position_shares(outs)
        let shares_delta = shares_out - shares_in

        // Structural rules that hold for EVERY action.
        //
        // NOTE on solvency: a transaction only ever contains a subset of the
        // vault's position UTxOs, so total locked lovelace is NOT observable
        // here. Global solvency is therefore maintained inductively: every
        // transition below ties `n_assets` to the exact on-chain value delta
        // at the script address, so accounted assets can never outrun the
        // value actually locked. What we can check locally is non-negativity.
        let structural =
          committee_unchanged(d, next) && operators_valid(operators, threshold) && positions_well_formed(
            outs,
          ) && n_shares >= 0 && n_assets >= 0 && locked_out >= 0 && n_epoch >= epoch

        let transition =
          when redeemer is {
            Deposit -> {
              let deposit = value_delta
              let minted = mint_shares(acc, deposit)
              !paused && n_paused == paused && n_epoch == epoch && deposit_ok(
                acc,
                deposit,
              ) && shares_delta == minted && n_shares == total_shares + minted && n_assets == total_assets + deposit
            }

            Withdraw { shares } -> {
              let paid = -value_delta
              // Withdrawals stay available while paused, at the last price.
              n_paused == paused && n_epoch == epoch && shares > 0 && shares <= total_shares && shares_delta == -shares && paid > 0 && paid <= redeem_value(acc, shares) && n_shares == total_shares - shares && n_assets == total_assets - paid
            }

            Accrue { amount } ->
              !paused && n_paused == paused && amount > 0 && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && value_delta == amount && shares_delta == 0 && n_shares == total_shares && n_assets == total_assets + amount && n_epoch == epoch + 1

            SetPaused { paused: want } ->
              threshold_met(operators, threshold, tx.extra_signatories) && n_paused == want && want != paused && n_epoch == epoch && n_shares == total_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0
          }

        structural && transition
      }
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests — `aiken check`.
// ------------------------------------------------------------------

const vhash: ByteArray = #"44444444444444444444444444444444444444444444444444444444"

const alice: ByteArray = #"11111111111111111111111111111111111111111111111111111111"

const mallory: ByteArray = #"22222222222222222222222222222222222222222222222222222222"

const op1: ByteArray = #"aa111111111111111111111111111111111111111111111111111111"

const op2: ByteArray = #"bb222222222222222222222222222222222222222222222222222222"

const t_version: Int = 1

// "sfm-01"
const t_asset: ByteArray = #"73666d2d3031"

fn vault_addr() -> Address {
  Address { payment_credential: Script(vhash), stake_credential: None }
}

fn user_addr(pkh: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(pkh), stake_credential: None }
}

fn out(addr: Address, lovelace: Int, datum: YieldDatum) -> Output {
  Output {
    address: addr,
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn plain_out(pkh: ByteArray, lovelace: Int) -> Output {
  Output {
    address: user_addr(pkh),
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

fn state(
  total_shares: Int,
  total_assets: Int,
  epoch: Int,
  paused: Bool,
) -> YieldDatum {
  State {
    total_shares,
    total_assets,
    epoch,
    operators: [op1, op2],
    threshold: 2,
    paused,
  }
}

fn ref_at(ix: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: ix,
  }
}

fn input_at(ix: Int, o: Output) -> Input {
  Input { output_reference: ref_at(ix), output: o }
}

/// The state UTxO always sits at input index 0 in these fixtures.
const state_ref: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

fn tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, extra_signatories: signers }
}

// --- Deposit -------------------------------------------------------

test deposit_bootstraps_shares_one_to_one() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test deposit_fails_when_minting_more_shares_than_paid_for() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(11_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 11_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test deposit_below_bootstrap_minimum_is_rejected() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(5_000_000, 5_000_000, 7, False)),
        out(vault_addr(), 5_000_000, Position { owner: alice, shares: 5_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test deposit_fails_while_paused() {
  let s0 = state(0, 0, 7, True)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, True)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

// --- Accrue --------------------------------------------------------

fn funded_tx_for_accrue(signers: List<ByteArray>, new_epoch: Int) -> Transaction {
  tx(
    [
      input_at(0, out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False))),
      input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
    ],
    [
      out(vault_addr(), 4_000_000, state(10_000_000, 12_000_000, new_epoch, False)),
      out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
    ],
    signers,
  )
}

test accrue_ok_with_full_operator_threshold() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1, op2], 8),
  )
}

test accrue_fails_below_operator_threshold() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1], 8),
  )
}

test accrue_fails_when_a_non_operator_signs() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1, mallory], 8),
  )
}

test accrue_must_bump_the_epoch() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1, op2], 7),
  )
}

test accrue_fails_without_a_matching_value_increase() {
  // Datum claims +2 ADA of yield but no lovelace actually arrived.
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 12_000_000, 8, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

// --- Withdraw ------------------------------------------------------

test full_withdraw_burns_shares_and_drains_assets() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [out(vault_addr(), 2_000_000, state(0, 0, 7, False)), plain_out(alice, 10_000_000)],
      [alice],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 10_000_000 }, state_ref, t)
}

test withdraw_cannot_take_more_than_the_share_price_allows() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [out(vault_addr(), 1_000_000, state(0, -1_000_000, 7, False)), plain_out(alice, 11_000_000)],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 10_000_000 }, state_ref, t)
}

test partial_withdraw_leaves_a_viable_position() {
  // 4 ADA taken from a 10 ADA position at price 1; 6 ADA stays behind.
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(6_000_000, 6_000_000, 7, False)),
        out(vault_addr(), 6_000_000, Position { owner: alice, shares: 6_000_000 }),
        plain_out(alice, 4_000_000),
      ],
      [alice],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 4_000_000 }, state_ref, t)
}

test partial_withdraw_stranding_a_dust_position_is_rejected() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(500_000, 500_000, 7, False)),
        out(vault_addr(), 500_000, Position { owner: alice, shares: 500_000 }),
        plain_out(alice, 9_500_000),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 9_500_000 }, state_ref, t)
}

test withdraw_is_still_allowed_while_paused() {
  let s0 = state(10_000_000, 10_000_000, 7, True)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [out(vault_addr(), 2_000_000, state(0, 0, 7, True)), plain_out(alice, 10_000_000)],
      [alice],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 10_000_000 }, state_ref, t)
}

// --- Position spends -----------------------------------------------

fn position_spend_tx(signers: List<ByteArray>, payee: ByteArray) -> Transaction {
  tx(
    [
      input_at(0, out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False))),
      input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
    ],
    [out(vault_addr(), 2_000_000, state(0, 0, 7, False)), plain_out(payee, 10_000_000)],
    signers,
  )
}

test position_spend_ok_when_owner_signs_and_is_paid() {
  let p = Position { owner: alice, shares: 10_000_000 }
  yield_vault.spend(
    t_version,
    t_asset,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([alice], alice),
  )
}

test position_spend_fails_when_owner_did_not_sign() {
  let p = Position { owner: alice, shares: 10_000_000 }
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([mallory], alice),
  )
}

test position_spend_fails_when_funds_go_to_a_stranger() {
  let p = Position { owner: alice, shares: 10_000_000 }
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([alice], mallory),
  )
}

test position_spend_fails_without_the_state_utxo() {
  // No aggregate ledger in the inputs means nothing enforces the accounting.
  let p = Position { owner: alice, shares: 10_000_000 }
  let t =
    tx(
      [input_at(1, out(vault_addr(), 10_000_000, p))],
      [plain_out(alice, 10_000_000)],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(p), Withdraw { shares: 10_000_000 }, ref_at(1), t)
}

// --- Pause / committee ---------------------------------------------

test operators_can_pause() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, True))],
      [op1, op2],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), SetPaused { paused: True }, state_ref, t)
}

test a_single_operator_cannot_pause() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, True))],
      [op1],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), SetPaused { paused: True }, state_ref, t)
}

test committee_cannot_be_swapped_during_a_deposit() {
  let s0 = state(0, 0, 7, False)
  let hijacked =
    State {
      total_shares: 10_000_000,
      total_assets: 10_000_000,
      epoch: 7,
      operators: [mallory],
      threshold: 1,
      paused: False,
    }
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, hijacked),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

// Two state outputs leave no single ledger to continue from, so the
// validator traps rather than returning False.
test state_must_be_recreated_exactly_once() fail {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}
