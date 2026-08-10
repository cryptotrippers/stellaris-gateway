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
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use stellaris/shares.{
  VaultAccounting, deposit_ok, fee_assets_for, fee_bps_ok, fee_shares_for,
  max_settle_window, min_position_value, mint_shares,
  redeem_value, withdraw_ok,
}

pub type YieldDatum {
  /// A single depositor's stake.
  Position { owner: ByteArray, shares: Int }
  /// The vault's aggregate ledger. Exactly one per vault.
  ///
  /// Fee fields (Stage 5): the management fee is an annual rate in basis
  /// points charged on accounted assets, prorated by wall-clock time and
  /// settled by MINTING shares to the treasury rather than paying lovelace
  /// out. `treasury_shares` is the treasury's unclaimed slice of
  /// `total_shares`; `last_fee_time` is the POSIX ms up to which fee has
  /// already been charged.
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
    /// Stage 6: the receipt minting policy bound to this vault, written once
    /// at bootstrap and immutable afterwards. Every `Deposit` must mint, and
    /// every `Withdraw` must burn, exactly the depositor-share delta under
    /// this policy with token name = `asset_id`; every other action must move
    /// zero receipts. Must be a 28-byte script hash.
    receipt_policy: ByteArray,
  }
}

pub type YieldRedeemer {
  /// Add lovelace, mint shares at the current price.
  Deposit
  /// Burn `shares` from a position, take at most `redeem_value(shares)`.
  Withdraw { shares: Int }
  /// Operators add `amount` lovelace of yield; depositor share count
  /// untouched, but the accrued management fee is minted to the treasury
  /// first, so the fee is never charged on yield that has not landed yet.
  Accrue { amount: Int }
  /// Operators halt deposits and accruals. Withdrawals stay open.
  SetPaused { paused: Bool }
  /// Operators replace the signing committee. Requires M-of-N of the OUTGOING
  /// committee; the incoming committee must itself be valid. Nothing else
  /// about the vault may move in the same transaction.
  RotateCommittee { operators: List<ByteArray>, threshold: Int }
  /// Governance-executed fee change. Settles the fee accrued under the OLD
  /// rate first, then writes the new rate. Capped by `shares.max_fee_bps`.
  SetFee { fee_bps: Int }
  /// Treasury cashes out part of its accrued fee shares at the current price.
  ClaimFee { shares: Int }
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

/// Every Position datum among `outs`, in order. Used by `Withdraw` to reason
/// about individual positions rather than only their aggregate share total.
fn position_datums(outs: List<Output>) -> List<YieldDatum> {
  list.foldr(
    outs,
    [],
    fn(o, acc) {
      when datum_of(o) is {
        Some(Position { owner, shares }) -> [Position { owner, shares }, ..acc]
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

/// Outputs returned to the vault must be pure lovelace. Without this an
/// attacker can park arbitrary native tokens (or an NFT) in a Position or in
/// the State UTxO, inflating its min-ADA requirement until the accounted
/// lovelace can no longer be paid out — a permanent lock on real funds.
fn values_pure(outs: List<Output>) -> Bool {
  list.all(
    outs,
    fn(o) { assets.without_lovelace(o.value) == assets.zero },
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

/// The earliest time this transaction can be on chain, in POSIX ms. Fee
/// proration is anchored here, so an unbounded validity range (which would
/// let an operator claim arbitrary elapsed time) makes fee actions fail.
fn lower_bound_time(tx: Transaction) -> Option<Int> {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(t) -> Some(t)
    _ -> None
  }
}

/// The latest time this transaction can be on chain, in POSIX ms. V-05: a fee
/// action must carry a FINITE upper bound so the anchor can be pinned inside
/// a real window; without it the committee could post-date the anchor and
/// charge management fee for time that has not elapsed.
fn upper_bound_time(tx: Transaction) -> Option<Int> {
  when tx.validity_range.upper_bound.bound_type is {
    Finite(t) -> Some(t)
    _ -> None
  }
}

/// V-05: the fee anchor must sit inside the transaction's own validity window
/// and may not reach further back than `max_settle_window`.
fn fee_anchor_ok(now: Int, hi: Int, last_fee_time: Int) -> Bool {
  now <= hi && now - last_fee_time <= max_settle_window
}



// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator yield_vault(_version: Int, asset_id: ByteArray) {
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
      State {
        total_shares,
        total_assets,
        epoch,
        operators,
        threshold,
        paused,
        fee_bps,
        treasury,
        treasury_shares,
        last_fee_time,
        receipt_policy,
      } -> {
        // V-01: exactly ONE State UTxO may be spent. Without this, two State
        // UTxOs at this address can be collapsed into the single required
        // State output: `locked_in` then sums both, so the surviving datum
        // only has to balance one of them and the other's lovelace can leave
        // the script unaccounted. The output side was already constrained by
        // `sole_state(outs)`; this mirrors it on the input side.
        expect Some(_only_state_in) = sole_state(ins)
        expect Some(next) = sole_state(outs)
        expect State {
          total_shares: n_shares,
          total_assets: n_assets,
          epoch: n_epoch,
          operators: n_operators,
          threshold: n_threshold,
          paused: n_paused,
          fee_bps: n_fee_bps,
          treasury: n_treasury,
          treasury_shares: n_treasury_shares,
          last_fee_time: n_last_fee_time,
          receipt_policy: n_receipt_policy,
        } = next

        let acc = VaultAccounting { total_shares, total_assets }
        let locked_in = lovelace_sum(ins)
        let locked_out = lovelace_sum(outs)
        let value_delta = locked_out - locked_in
        let shares_in = position_shares(ins)
        let shares_out = position_shares(outs)
        let shares_delta = shares_out - shares_in

        // Stage 6: net receipts minted (positive) or burned (negative) under
        // the vault's bound policy, for this vault's token name.
        let receipt_delta =
          assets.quantity_of(tx.mint, receipt_policy, asset_id)


        // Structural rules that hold for EVERY action.
        //
        // NOTE on solvency: a transaction only ever contains a subset of the
        // vault's position UTxOs, so total locked lovelace is NOT observable
        // here. Global solvency is therefore maintained inductively: every
        // transition below ties `n_assets` to the exact on-chain value delta
        // at the script address, so accounted assets can never outrun the
        // value actually locked. What we can check locally is non-negativity.
        //
        // The OUTGOING committee must be well-formed and the returned state
        // must be pure lovelace; committee immutability is asserted per-action
        // below, because `RotateCommittee` is the one action allowed to change
        // it. The fee rate must always sit inside the protocol cap, the
        // treasury's unclaimed shares can never exceed the total supply, and
        // the fee clock can only move forward.
        let structural =
          operators_valid(operators, threshold) && operators_valid(
            n_operators,
            n_threshold,
          ) && positions_well_formed(outs) && values_pure(outs) && n_shares >= 0 && n_assets >= 0 && locked_out >= 0 && n_epoch >= epoch && fee_bps_ok(
            n_fee_bps,
          ) && n_treasury_shares >= 0 && n_treasury_shares <= n_shares && n_last_fee_time >= last_fee_time && n_treasury == treasury && n_receipt_policy == receipt_policy && bytearray.length(
            receipt_policy,
          ) == 28

        let same_committee = committee_unchanged(d, next)

        // Fee terms may only move through `SetFee`; the fee clock and the
        // treasury's balance may only move through `Accrue`, `SetFee`, and
        // `ClaimFee`.
        let fee_frozen =
          n_fee_bps == fee_bps && n_last_fee_time == last_fee_time && n_treasury_shares == treasury_shares

        // Fee owed since `last_fee_time`, and the shares that settle it.
        // `now` is the transaction's validity lower bound: the fee can never
        // be charged against a time the chain has not reached.
        let settle =
          fn(now: Int) -> (Int, Int) {
            let owed = fee_assets_for(acc, fee_bps, now - last_fee_time)
            (owed, fee_shares_for(acc, owed))
          }

        let transition =
          when redeemer is {
            Deposit -> {
              let deposit = value_delta
              let minted = mint_shares(acc, deposit)
              same_committee && fee_frozen && !paused && n_paused == paused && n_epoch == epoch && deposit_ok(
                acc,
                deposit,
              ) && shares_delta == minted && receipt_delta == minted && n_shares == total_shares + minted && n_assets == total_assets + deposit
            }

            Withdraw { shares } -> {
              let paid = -value_delta
              // V-03: aggregate `shares_delta` alone lets a batched
              // withdrawal re-attribute shares between co-signing owners, and
              // never checks that a returned Position keeps its owner. Bind
              // the transaction to exactly ONE Position input and at most one
              // Position output, owned by the same key, carrying the exact
              // remainder — and run `shares.withdraw_ok`, the per-position
              // bound that was defined and tested but never wired in.
              let owner_continuity =
                when (position_datums(ins), position_datums(outs)) is {
                  ([Position { owner: _o, shares: held }], []) ->
                    shares == held && withdraw_ok(acc, held, shares)
                  (
                    [Position { owner: in_owner, shares: held }],
                    [Position { owner: out_owner, shares: left }],
                  ) ->
                    out_owner == in_owner && left == held - shares && withdraw_ok(
                      acc,
                      held,
                      shares,
                    )
                  _ -> False
                }
              // Withdrawals stay available while paused, at the last price.
              same_committee && fee_frozen && n_paused == paused && n_epoch == epoch && shares > 0 && shares <= total_shares - treasury_shares && owner_continuity && shares_delta == -shares && receipt_delta == -shares && paid > 0 && paid <= redeem_value(
                acc,
                shares,
              ) && n_shares == total_shares - shares && n_assets == total_assets - paid
            }


            // Accrual settles the management fee accrued under the current
            // rate FIRST (minting treasury shares against the pre-yield
            // assets), then books the yield. Requires a finite validity
            // range on BOTH sides so the elapsed time is real (V-05).
            Accrue { amount } -> {
              expect Some(now) = lower_bound_time(tx)
              expect Some(hi) = upper_bound_time(tx)
              let (_owed, fee_shares) = settle(now)
              same_committee && n_fee_bps == fee_bps && !paused && n_paused == paused && amount > 0 && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && now >= last_fee_time && fee_anchor_ok(now, hi, last_fee_time) && n_last_fee_time == now && value_delta == amount && shares_delta == 0 && receipt_delta == 0 && n_shares == total_shares + fee_shares && n_treasury_shares == treasury_shares + fee_shares && n_assets == total_assets + amount && n_epoch == epoch + 1
            }


            SetPaused { paused: want } ->
              same_committee && fee_frozen && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && n_paused == want && want != paused && n_epoch == epoch && n_shares == total_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && receipt_delta == 0

            // Committee rotation: authorized by M-of-N of the OUTGOING
            // committee, and the redeemer must match the committee actually
            // written into the returned state. The vault's money and epoch
            // stand still, so a rotation can never be bundled with an accrual
            // or a withdrawal.
            RotateCommittee { operators: want_ops, threshold: want_thr } ->
              fee_frozen && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && n_operators == want_ops && n_threshold == want_thr && !(
                n_operators == operators && n_threshold == threshold
              ) && n_paused == paused && n_epoch == epoch && n_shares == total_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && receipt_delta == 0

            // Fee change. The fee owed under the OLD rate is settled in the
            // same transaction, so a rate change can never be applied
            // retroactively in either direction. No money moves.
            SetFee { fee_bps: want } -> {
              expect Some(now) = lower_bound_time(tx)
              expect Some(hi) = upper_bound_time(tx)
              let (_owed, fee_shares) = settle(now)
              same_committee && fee_anchor_ok(now, hi, last_fee_time) && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && fee_bps_ok(want) && want != fee_bps && n_fee_bps == want && now >= last_fee_time && n_last_fee_time == now && n_paused == paused && n_epoch == epoch && n_shares == total_shares + fee_shares && n_treasury_shares == treasury_shares + fee_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && receipt_delta == 0
            }

            // Treasury cashes out accrued fee shares at the current price.
            // Payment must land at the treasury key recorded in the datum.
            ClaimFee { shares } -> {
              let paid = -value_delta
              let treasury_paid =
                list.any(
                  tx.outputs,
                  fn(o) {
                    when o.address.payment_credential is {
                      VerificationKey(k) -> k == treasury
                      _ -> False
                    }
                  },
                )
              same_committee && n_fee_bps == fee_bps && n_last_fee_time == last_fee_time && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && treasury_paid && shares > 0 && shares <= treasury_shares && paid > 0 && paid <= redeem_value(
                acc,
                shares,
              ) && shares_delta == 0 && receipt_delta == 0 && n_paused == paused && n_epoch == epoch && n_shares == total_shares - shares && n_treasury_shares == treasury_shares - shares && n_assets == total_assets - paid
            }
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

/// The receipt minting policy bound to the fixture vault (28 bytes).
const rpolicy: ByteArray =
  #"ca06d650b0ff77c959b3776771c3438bb61fe99a072eeb59d8cedb18"

/// Treasury key used across the fixtures.
const treas: ByteArray = #"deadbeef00000000000000000000000000000000000000000000dead"

/// Fixture wall clock (POSIX ms). Every fixture transaction is valid from
/// exactly this instant, so a fee is only charged when a test deliberately
/// moves the vault's `last_fee_time` into the past.
const t0: Int = 1_700_000_000_000

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
    fee_bps: 0,
    treasury: treas,
    treasury_shares: 0,
    last_fee_time: t0,
    receipt_policy: rpolicy,
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

/// Fixture transaction. The receipt mint is derived from the fixture's own
/// depositor-share delta, so the Stage 6 mint rule is satisfied by default and
/// each legacy test keeps exercising exactly the property it was written for.
/// Tests that target the mint rule itself use `tx_minting`.
fn tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  let delta =
    position_shares(list.map(ins, fn(i) { i.output })) * -1 + position_shares(
      outs,
    )
  tx_minting(ins, outs, signers, delta)
}

fn tx_minting(
  ins: List<Input>,
  outs: List<Output>,
  signers: List<ByteArray>,
  receipts: Int,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    extra_signatories: signers,
    mint: assets.from_asset(rpolicy, t_asset, receipts),
    validity_range: interval.between(t0, t0 + 3_600_000),
  }
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
      fee_bps: 0,
      treasury: treas,
      treasury_shares: 0,
      last_fee_time: t0,
      receipt_policy: rpolicy,
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

// --- Committee rotation --------------------------------------------

const op3: ByteArray = #"cc333333333333333333333333333333333333333333333333333333"

fn state_with(
  operators: List<ByteArray>,
  threshold: Int,
  total_shares: Int,
  total_assets: Int,
  epoch: Int,
) -> YieldDatum {
  State {
    total_shares,
    total_assets,
    epoch,
    operators,
    threshold,
    paused: False,
    fee_bps: 0,
    treasury: treas,
    treasury_shares: 0,
    last_fee_time: t0,
    receipt_policy: rpolicy,
  }
}

test committee_can_be_rotated_by_the_outgoing_quorum() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([op1, op3], 2, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, s1)],
      [op1, op2],
    )
  yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    RotateCommittee { operators: [op1, op3], threshold: 2 },
    state_ref,
    t,
  )
}

test rotation_needs_the_outgoing_threshold() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([mallory], 1, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, s1)],
      [op1],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    RotateCommittee { operators: [mallory], threshold: 1 },
    state_ref,
    t,
  )
}

test rotation_redeemer_must_match_the_written_committee() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([mallory], 1, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    RotateCommittee { operators: [op1, op3], threshold: 2 },
    state_ref,
    t,
  )
}

test rotation_cannot_install_an_unsatisfiable_committee() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([op1, op3], 3, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [out(vault_addr(), 2_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    RotateCommittee { operators: [op1, op3], threshold: 3 },
    state_ref,
    t,
  )
}

test rotation_cannot_move_funds() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([op1, op3], 2, 10_000_000, 8_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 4_000_000, s0))],
      [out(vault_addr(), 2_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    RotateCommittee { operators: [op1, op3], threshold: 2 },
    state_ref,
    t,
  )
}

// --- Value purity ----------------------------------------------------

const junk_policy: ByteArray = #"99999999999999999999999999999999999999999999999999999999"

fn out_with_token(addr: Address, lovelace: Int, datum: YieldDatum) -> Output {
  Output {
    address: addr,
    value: assets.merge(
      assets.from_lovelace(lovelace),
      assets.from_asset(junk_policy, #"deadbeef", 1),
    ),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

test a_deposit_cannot_park_native_tokens_in_a_position() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out_with_token(
          vault_addr(),
          10_000_000,
          Position { owner: alice, shares: 10_000_000 },
        ),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

// --- Management fee --------------------------------------------------

/// A vault carrying a live fee rate. `owed_since` is how long ago the fee
/// was last settled, in milliseconds.
fn fee_state(
  total_shares: Int,
  total_assets: Int,
  epoch: Int,
  fee_bps: Int,
  treasury_shares: Int,
  owed_since: Int,
) -> YieldDatum {
  State {
    total_shares,
    total_assets,
    epoch,
    operators: [op1, op2],
    threshold: 2,
    paused: False,
    fee_bps,
    treasury: treas,
    treasury_shares,
    last_fee_time: t0 - owed_since,
    receipt_policy: rpolicy,
  }
}

/// The longest gap a single fee settlement may cover (V-05: 90 days).
const fee_window: Int = max_settle_window

// 1_000 ADA at price 1, one full settle window (90 days) at 100 bps =>
// 2_465_753 lovelace of fee, settled as
// floor(2_465_753 * 1_000_000_000 / 997_534_247) treasury shares.
const fee_year_shares: Int = 2_471_847

test accrue_settles_the_management_fee_in_shares() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_002_000_000, 8, 100, fee_year_shares, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_002_000_000, s1)],
      [op1, op2],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

test accrue_cannot_skip_the_fee() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 = fee_state(1_000_000_000, 1_002_000_000, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_002_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

test accrue_cannot_overcharge_the_fee() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares * 2, 1_002_000_000, 8, 100, fee_year_shares * 2, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_002_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

test accrue_needs_a_bounded_validity_range() fail {
  // An unbounded lower bound would let operators claim arbitrary elapsed time.
  // The validator aborts on the missing finite bound, so the tx is rejected;
  // this is an expected-failure test rather than a `False` result.
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_002_000_000, 8, 100, fee_year_shares, 0)
  let t =
    Transaction {
      ..placeholder,
      inputs: [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      outputs: [out(vault_addr(), 1_002_000_000, s1)],
      extra_signatories: [op1, op2],
    }
  yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

test fee_rate_can_be_set_within_the_cap() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_000_000_000, 7, 250, fee_year_shares, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000_000, s1)],
      [op1, op2],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), SetFee { fee_bps: 250 }, state_ref, t)
}

test fee_rate_above_the_cap_is_rejected() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, 0)
  let s1 = fee_state(1_000_000_000, 1_000_000_000, 7, 900, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), SetFee { fee_bps: 900 }, state_ref, t)
}

test fee_rate_needs_the_operator_threshold() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, 0)
  let s1 = fee_state(1_000_000_000, 1_000_000_000, 7, 250, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000_000, s1)],
      [op1],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), SetFee { fee_bps: 250 }, state_ref, t)
}

test fee_rate_cannot_be_changed_during_a_deposit() {
  let s0 = fee_state(0, 0, 7, 100, 0, 0)
  let s1 = fee_state(10_000_000, 10_000_000, 7, 500, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, s1),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

// --- Fee claims -------------------------------------------------------

// Redeeming the year's fee shares at the post-mint price returns the fee,
// floored: 10_101_010 * 1_000_000_000 / 1_002_471_847 = 9_999_999.
const fee_year_payout: Int = 2_465_752

fn claimable() -> YieldDatum {
  fee_state(1_000_000_000 + fee_year_shares, 1_000_000_000, 8, 100, fee_year_shares, 0)
}

test treasury_can_claim_its_fee_shares() {
  let s0 = claimable()
  let s1 = fee_state(1_000_000_000, 1_000_000_000 - fee_year_payout, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [
        out(vault_addr(), 1_000_000_000 - fee_year_payout, s1),
        plain_out(treas, fee_year_payout),
      ],
      [op1, op2],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), ClaimFee { shares: fee_year_shares }, state_ref, t)
}

test fee_claim_must_pay_the_recorded_treasury() {
  let s0 = claimable()
  let s1 = fee_state(1_000_000_000, 1_000_000_000 - fee_year_payout, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [
        out(vault_addr(), 1_000_000_000 - fee_year_payout, s1),
        plain_out(mallory, fee_year_payout),
      ],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), ClaimFee { shares: fee_year_shares }, state_ref, t)
}

test fee_claim_cannot_exceed_the_accrued_fee_shares() {
  let s0 = claimable()
  let s1 = fee_state(1_000_000_000 - 1, 1_000_000_000 - fee_year_payout - 1, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [
        out(vault_addr(), 1_000_000_000 - fee_year_payout - 1, s1),
        plain_out(treas, fee_year_payout + 1),
      ],
      [op1, op2],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    ClaimFee { shares: fee_year_shares + 1 },
    state_ref,
    t,
  )
}

test depositors_cannot_withdraw_against_treasury_shares() {
  // Only 1_000_000_000 of the 1_002_471_847 shares belong to depositors.
  let s0 = claimable()
  let s1 = fee_state(fee_year_shares, 1_000_000_000 - 999_000_000, 8, 100, fee_year_shares, 0)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 1_000_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 1_002_471_847 })),
      ],
      [out(vault_addr(), 11_000_000, s1), plain_out(alice, 999_000_000)],
      [alice],
    )
  !yield_vault.spend(
    t_version,
    t_asset,
    Some(s0),
    Withdraw { shares: 1_002_471_847 },
    state_ref,
    t,
  )
}


// stage5: fee-aware yield vault (SetFee / ClaimFee / prorated Accrue)


// --- Stage 6: receipt tokens ---------------------------------------

test deposit_must_mint_matching_receipts() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx_minting(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
      10_000_000,
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test deposit_without_receipts_is_rejected() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx_minting(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
      0,
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test deposit_over_minting_receipts_is_rejected() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx_minting(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
      10_000_001,
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

test withdraw_must_burn_the_receipts() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx_minting(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(0, 0, 7, False)),
        plain_out(alice, 10_000_000),
      ],
      [alice],
      -10_000_000,
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 10_000_000 }, state_ref, t)
}

test withdraw_without_burning_receipts_is_rejected() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx_minting(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(0, 0, 7, False)),
        plain_out(alice, 10_000_000),
      ],
      [alice],
      0,
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 10_000_000 }, state_ref, t)
}

test accrue_cannot_mint_receipts() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx_minting(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 4_000_000, state(10_000_000, 12_000_000, 8, False)),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [op1, op2],
      1,
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

/// The bound policy is immutable: a state output may not re-point the vault
/// at an attacker-controlled receipt policy.
test receipt_policy_cannot_be_swapped() {
  let s0 = state(0, 0, 7, False)
  let hijacked =
    State {
      total_shares: 10_000_000,
      total_assets: 10_000_000,
      epoch: 7,
      operators: [op1, op2],
      threshold: 2,
      paused: False,
      fee_bps: 0,
      treasury: treas,
      treasury_shares: 0,
      last_fee_time: t0,
      receipt_policy: #"11111111111111111111111111111111111111111111111111111111",
    }
  let t =
    tx_minting(
      [input_at(0, out(vault_addr(), 2_000_000, s0))],
      [
        out(vault_addr(), 2_000_000, hijacked),
        out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
      10_000_000,
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}


// --- Security scan regressions (AUDIT.md V-01, V-03, V-05) -----------

/// V-01: two State-shaped UTxOs at the vault address may never be spent in
/// one transaction. Both runs would read the same single State output while
/// `locked_in` sums both inputs, letting the second State's lovelace leave
/// the script unaccounted. The validator now traps on `sole_state(ins)`, so
/// this is an expected-failure test rather than a `False` result.
test two_state_inputs_are_rejected() fail {
  let s0 = state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)
  let planted = state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 10_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, planted)),
      ],
      [
        out(vault_addr(), 10_000_000, state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)),
        plain_out(mallory, 10_000_000),
      ],
      [mallory],
    )
  yield_vault.spend(t_version, t_asset, Some(s0), Deposit, state_ref, t)
}

/// V-03: a partial withdrawal may not re-datum the remainder to another key.
test partial_withdraw_must_preserve_owner() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(6_000_000, 6_000_000, 7, False)),
        // Alice signed a withdrawal, not a transfer of her remaining stake.
        out(vault_addr(), 6_000_000, Position { owner: mallory, shares: 6_000_000 }),
        plain_out(alice, 4_000_000),
      ],
      [alice],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 4_000_000 }, state_ref, t)
}

/// V-03: two owners' positions spent together let the aggregate share delta
/// be satisfied by any split of the returned shares. Only one Position input
/// is now permitted, so the batch is rejected outright.
test batched_withdraw_cannot_reshuffle_shares() {
  let s0 = state(20_000_000, 20_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, s0)),
        input_at(1, out(vault_addr(), 10_000_000, Position { owner: alice, shares: 10_000_000 })),
        input_at(2, out(vault_addr(), 10_000_000, Position { owner: mallory, shares: 10_000_000 })),
      ],
      [
        out(vault_addr(), 2_000_000, state(16_000_000, 16_000_000, 7, False)),
        // 4 ADA of shares left the vault, but the remainder is re-split:
        // Mallory keeps 10 and Alice's 6 becomes Mallory's… nobody signed
        // for the split.
        out(vault_addr(), 6_000_000, Position { owner: mallory, shares: 6_000_000 }),
        out(vault_addr(), 10_000_000, Position { owner: mallory, shares: 10_000_000 }),
        plain_out(alice, 4_000_000),
      ],
      [alice, mallory],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Withdraw { shares: 4_000_000 }, state_ref, t)
}

/// V-05: the fee anchor must sit inside the transaction's own validity
/// window. An open-ended upper bound would let the committee post-date the
/// anchor and charge fee for time that has not elapsed; the validator traps
/// on the missing finite bound.
test accrue_rejects_future_anchor() fail {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_002_000_000, 8, 100, fee_year_shares, 0)
  let t =
    Transaction {
      ..placeholder,
      inputs: [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      outputs: [out(vault_addr(), 1_002_000_000, s1)],
      extra_signatories: [op1, op2],
      mint: assets.from_asset(rpolicy, t_asset, 0),
      validity_range: interval.after(t0),
    }
  yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}

/// V-05: a single settlement may not reach back further than 90 days.
test accrue_rejects_oversized_settle_window() {
  let owed_since = max_settle_window + 1
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, owed_since)
  let fee = fee_assets_for(
    VaultAccounting { total_shares: 1_000_000_000, total_assets: 1_000_000_000 },
    100,
    owed_since,
  )
  let minted =
    fee_shares_for(
      VaultAccounting { total_shares: 1_000_000_000, total_assets: 1_000_000_000 },
      fee,
    )
  let s1 = fee_state(1_000_000_000 + minted, 1_002_000_000, 8, 100, minted, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000_000, s0))],
      [out(vault_addr(), 1_002_000_000, s1)],
      [op1, op2],
    )
  !yield_vault.spend(t_version, t_asset, Some(s0), Accrue { amount: 2_000_000 }, state_ref, t)
}
