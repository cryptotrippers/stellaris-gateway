//// sUSDr vault — a Cardano-native, share-accrual tokenized vault over USDr.
////
//// Ported directly from stellaris-gateway's own audited
//// `contracts/vault/validators/yield_vault.ak`, denominated in a native
//// USDr token (policy id + asset name, pinned as validator parameters)
//// instead of lovelace. All share-accrual/fee arithmetic is the SAME
//// `stellaris/shares` module, copied verbatim (see `lib/stellaris/shares.ak`)
//// — reusing proven money-handling logic rather than writing new arithmetic
//// from scratch. See DESIGN.md for the full rationale behind every
//// departure from a literal lovelace-to-USDr find/replace.
////
//// Two kinds of UTxO live at the same applied `(version, usdr_policy,
//// usdr_asset_name)` address:
////
////   * exactly ONE `State` UTxO — the aggregate ledger (shares, USDr
////     accounted, epoch, operator set, pause flag, management fee terms).
////     It must be an input and an output of every action, so the accounting
////     rules below run on every transaction.
////   * many `Position` UTxOs — one per depositor stake, pinning the owner
////     PKH and their share count.
////
//// sUSDr — the depositor-facing "shares" token — is minted by the `mint`
//// handler below, defined in this SAME validator block. Aiken compiles all
//// handlers declared inside one `validator { ... }` block to a single
//// script, so the sUSDr policy id and this vault's own spending script hash
//// are, structurally, the SAME hash: there is no `receipt_policy` field to
//// pin into the datum (as stellaris-gateway's `yield_vault`/`receipt.ak`
//// pair needs — see its RECEIPT.md) and no two-step "derive the vault, then
//// derive a policy parameterized by the applied vault hash" bootstrap
//// ordering. `aiken build`'s plutus.json is the check that this hash-sharing
//// actually holds in this compiler version — see DESIGN.md.
////
//// sUSDr is a PROOF OF CLAIM, not a bearer token: minting/burning it always
//// tracks a Position's depositor-share delta 1:1 on `Deposit`/`Withdraw`,
//// but redemption is authorized by the Position UTxO's owner signature, not
//// by holding sUSDr. A transferee of sUSDr acquires no redemption right —
//// see DESIGN.md, "sUSDr is a proof-of-claim receipt, not a bearer token".
////
//// Authorization split:
////   * spending a Position requires the OWNER's signature and an output
////     back to the owner (mirrors `vault.ak`'s continuity rule);
////   * spending the State requires the transition to balance, and for
////     `Accrue` / `SetPaused` / `RotateCommittee` / `SetFee` / `ClaimFee`
////     additionally M-of-N operator signatures (`realfi/committee`).
////
//// `Accrue` requires REAL, on-chain USDr landing at the vault address in
//// the SAME transaction — `value_delta == amount` below is the
//// enforcement. There is no "report yield now, repatriate capital later"
//// path; see DESIGN.md, "Two decisions already made".

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use realfi/committee.{committee_valid, threshold_met}
use stellaris/shares.{
  VaultAccounting, deposit_ok, fee_assets_for, fee_bps_ok, fee_shares_for,
  max_settle_window, min_position_value, mint_shares, redeem_value, withdraw_ok,
}

pub type SusdrDatum {
  /// A single depositor's stake.
  Position { owner: ByteArray, shares: Int }
  /// The vault's aggregate ledger. Exactly one per vault. Fee fields mirror
  /// `yield_vault.ak`'s Stage 5 design: an annual management-fee rate in
  /// basis points, prorated by wall-clock time, settled by MINTING shares
  /// to the treasury rather than paying USDr out directly.
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
  }
}

pub type SusdrRedeemer {
  /// Add USDr, mint sUSDr shares at the current price.
  Deposit
  /// Burn `shares` from a position, take at most `redeem_value(shares)`.
  Withdraw { shares: Int }
  /// Operators add `amount` of real, on-chain USDr yield; depositor share
  /// count untouched, but the accrued management fee is minted to the
  /// treasury first, so the fee is never charged on yield that has not
  /// actually landed.
  Accrue { amount: Int }
  /// Operators halt deposits and accruals. Withdrawals stay open.
  SetPaused { paused: Bool }
  /// Operators replace the signing committee. Requires M-of-N of the
  /// OUTGOING committee; the incoming committee must itself be valid.
  /// Nothing else about the vault may move in the same transaction.
  RotateCommittee { operators: List<ByteArray>, threshold: Int }
  /// Governance-executed fee change. Settles the fee accrued under the OLD
  /// rate first, then writes the new rate. Capped by `shares.max_fee_bps`.
  SetFee { fee_bps: Int }
  /// Treasury cashes out part of its accrued fee shares at the current
  /// price.
  ClaimFee { shares: Int }
}

/// Fixed token name for every sUSDr unit minted by this vault's own `mint`
/// handler: "sUSDr" in UTF-8 bytes.
pub const susdr_asset_name: ByteArray = #"7355534472"

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

fn datum_of(output: Output) -> Option<SusdrDatum> {
  when output.datum is {
    InlineDatum(raw) -> {
      expect d: SusdrDatum = raw
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

/// The accounted USDr quantity in a Value, per the policy/asset-name pinned
/// as this validator's own parameters.
fn usdr_of(value: assets.Value, usdr_policy: ByteArray, usdr_asset_name: ByteArray) -> Int {
  assets.quantity_of(value, usdr_policy, usdr_asset_name)
}

fn usdr_sum(
  outs: List<Output>,
  usdr_policy: ByteArray,
  usdr_asset_name: ByteArray,
) -> Int {
  list.foldr(
    outs,
    0,
    fn(o, acc) { acc + usdr_of(o.value, usdr_policy, usdr_asset_name) },
  )
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
fn position_datums(outs: List<Output>) -> List<SusdrDatum> {
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

/// Depositor shares (`total_shares - treasury_shares`) recorded by the sole
/// State UTxO among `outs`. `None` unless there is exactly one — used by the
/// `mint` handler below, which never runs `spend` itself and so must derive
/// this independently from whichever State UTxOs it can see in the tx.
fn sole_depositor_shares(outs: List<Output>) -> Option<Int> {
  let states =
    list.filter_map(
      outs,
      fn(o) {
        when datum_of(o) is {
          Some(State { total_shares, treasury_shares, .. }) ->
            Some(total_shares - treasury_shares)
          _ -> None
        }
      },
    )
  when states is {
    [only] -> Some(only)
    _ -> None
  }
}

/// Every Position returned to the vault must carry a strictly positive share
/// count AND enough accounted USDr to clear the protocol's own dust floor.
/// This is an ACCOUNTING minimum carried over from `shares.ak`, NOT
/// Cardano's separate, ledger-enforced min-ADA rule — see DESIGN.md,
/// "min-UTxO-ADA is a ledger rule". Every output at this address must also
/// carry a readable datum.
fn positions_well_formed(
  outs: List<Output>,
  usdr_policy: ByteArray,
  usdr_asset_name: ByteArray,
) -> Bool {
  list.all(
    outs,
    fn(o) {
      when datum_of(o) is {
        Some(Position { shares, .. }) ->
          shares > 0 && usdr_of(o.value, usdr_policy, usdr_asset_name) >= min_position_value
        Some(State { .. }) -> True
        None -> False
      }
    },
  )
}

/// Outputs returned to the vault may carry ONLY lovelace (required by the
/// ledger's min-UTxO-ADA rule, independent of anything this validator
/// checks) and the accounted USDr token. A third native asset — an
/// attacker-planted NFT, a foreign token — would inflate the output's
/// min-ADA requirement or simply pollute accounting; this is the USDr-vault
/// analogue of `yield_vault.ak`'s `values_pure` (which only had to exclude
/// everything, since lovelace was both the accounted asset AND the min-ADA
/// currency there).
fn only_usdr_and_lovelace(value: assets.Value, usdr_policy: ByteArray) -> Bool {
  list.all(
    assets.policies(value),
    fn(p) { p == assets.ada_policy_id || p == usdr_policy },
  )
}

fn values_ok(outs: List<Output>, usdr_policy: ByteArray) -> Bool {
  list.all(outs, fn(o) { only_usdr_and_lovelace(o.value, usdr_policy) })
}

/// The single State datum among `outs`, or None if there isn't exactly one.
fn sole_state(outs: List<Output>) -> Option<SusdrDatum> {
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

/// The committee may not change through ordinary spending.
fn committee_unchanged(before: SusdrDatum, after: SusdrDatum) -> Bool {
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

/// The latest time this transaction can be on chain, in POSIX ms. A fee
/// action must carry a FINITE upper bound so the anchor can be pinned inside
/// a real window; without it the committee could post-date the anchor and
/// charge management fee for time that has not elapsed.
fn upper_bound_time(tx: Transaction) -> Option<Int> {
  when tx.validity_range.upper_bound.bound_type is {
    Finite(t) -> Some(t)
    _ -> None
  }
}

/// The fee anchor must sit inside the transaction's own validity window and
/// may not reach further back than `max_settle_window`.
fn fee_anchor_ok(now: Int, hi: Int, last_fee_time: Int) -> Bool {
  now <= hi && now - last_fee_time <= max_settle_window
}

// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator susdr_vault(_version: Int, usdr_policy: ByteArray, usdr_asset_name: ByteArray) {
  spend(
    datum: Option<SusdrDatum>,
    redeemer: SusdrRedeemer,
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
      } -> {
        // Exactly ONE State UTxO may be spent — without this, two State
        // UTxOs at this address could be collapsed into the single required
        // State output, letting one of them leave the script unaccounted.
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
        } = next

        let acc = VaultAccounting { total_shares, total_assets }
        let locked_in = usdr_sum(ins, usdr_policy, usdr_asset_name)
        let locked_out = usdr_sum(outs, usdr_policy, usdr_asset_name)
        let value_delta = locked_out - locked_in
        let shares_in = position_shares(ins)
        let shares_out = position_shares(outs)
        let shares_delta = shares_out - shares_in

        // Net sUSDr minted (positive) or burned (negative) under this
        // vault's OWN script hash, which is structurally the sUSDr policy id
        // (see the module doc comment above).
        let susdr_delta = assets.quantity_of(tx.mint, hash, susdr_asset_name)

        // Structural rules that hold for EVERY action.
        //
        // NOTE on solvency: a transaction only ever contains a subset of the
        // vault's position UTxOs, so total locked USDr is NOT observable
        // here. Global solvency is therefore maintained inductively: every
        // transition below ties `n_assets` to the exact on-chain USDr delta
        // at the script address, so accounted assets can never outrun the
        // value actually locked.
        let structural =
          committee_valid(operators, threshold) && committee_valid(
            n_operators,
            n_threshold,
          ) && positions_well_formed(outs, usdr_policy, usdr_asset_name) && values_ok(
            outs,
            usdr_policy,
          ) && n_shares >= 0 && n_assets >= 0 && locked_out >= 0 && n_epoch >= epoch && fee_bps_ok(
            n_fee_bps,
          ) && n_treasury_shares >= 0 && n_treasury_shares <= n_shares && n_last_fee_time >= last_fee_time && n_treasury == treasury

        let same_committee = committee_unchanged(d, next)

        // Fee terms may only move through `SetFee`; the fee clock and the
        // treasury's balance may only move through `Accrue`, `SetFee`, and
        // `ClaimFee`.
        let fee_frozen =
          n_fee_bps == fee_bps && n_last_fee_time == last_fee_time && n_treasury_shares == treasury_shares

        // Fee owed since `last_fee_time`, and the shares that settle it.
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
              ) && shares_delta == minted && susdr_delta == minted && n_shares == total_shares + minted && n_assets == total_assets + deposit
            }

            Withdraw { shares } -> {
              let paid = -value_delta
              // Bind the transaction to exactly ONE Position input and at
              // most one Position output, owned by the same key, carrying
              // the exact remainder — a batched, multi-owner withdrawal
              // could otherwise re-attribute shares between co-signing
              // owners via the aggregate `shares_delta` alone.
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
              same_committee && fee_frozen && n_paused == paused && n_epoch == epoch && shares > 0 && shares <= total_shares - treasury_shares && owner_continuity && shares_delta == -shares && susdr_delta == -shares && paid > 0 && paid <= redeem_value(
                acc,
                shares,
              ) && n_shares == total_shares - shares && n_assets == total_assets - paid
            }

            // Accrual settles the management fee accrued under the current
            // rate FIRST (minting treasury shares against the pre-yield
            // assets), then books the yield. `value_delta == amount` is what
            // makes this REAL: the datum can only claim exactly the USDr
            // that actually landed at the script address in this same tx.
            Accrue { amount } -> {
              expect Some(now) = lower_bound_time(tx)
              expect Some(hi) = upper_bound_time(tx)
              let (_owed, fee_shares) = settle(now)
              same_committee && n_fee_bps == fee_bps && !paused && n_paused == paused && amount > 0 && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && now >= last_fee_time && fee_anchor_ok(now, hi, last_fee_time) && n_last_fee_time == now && value_delta == amount && shares_delta == 0 && susdr_delta == 0 && n_shares == total_shares + fee_shares && n_treasury_shares == treasury_shares + fee_shares && n_assets == total_assets + amount && n_epoch == epoch + 1
            }

            SetPaused { paused: want } ->
              same_committee && fee_frozen && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && n_paused == want && want != paused && n_epoch == epoch && n_shares == total_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && susdr_delta == 0

            // Committee rotation: authorized by M-of-N of the OUTGOING
            // committee, and the redeemer must match the committee actually
            // written into the returned state. The vault's money and epoch
            // stand still, so a rotation can never be bundled with an
            // accrual or a withdrawal.
            RotateCommittee { operators: want_ops, threshold: want_thr } ->
              fee_frozen && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && n_operators == want_ops && n_threshold == want_thr && !(
                n_operators == operators && n_threshold == threshold
              ) && n_paused == paused && n_epoch == epoch && n_shares == total_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && susdr_delta == 0

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
              ) && fee_bps_ok(want) && want != fee_bps && n_fee_bps == want && now >= last_fee_time && n_last_fee_time == now && n_paused == paused && n_epoch == epoch && n_shares == total_shares + fee_shares && n_treasury_shares == treasury_shares + fee_shares && n_assets == total_assets && value_delta == 0 && shares_delta == 0 && susdr_delta == 0
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
              ) && shares_delta == 0 && susdr_delta == 0 && n_paused == paused && n_epoch == epoch && n_shares == total_shares - shares && n_treasury_shares == treasury_shares - shares && n_assets == total_assets - paid
            }
          }

        structural && transition
      }
    }
  }

  // ------------------------------------------------------------------
  // sUSDr minting policy — see the module doc comment for why this lives in
  // the SAME validator block as `spend` rather than a separate file.
  // ------------------------------------------------------------------
  mint(_redeemer: Data, policy_id: assets.PolicyId, tx: Transaction) {
    // `policy_id` IS this vault's own spending script hash (same-block
    // handlers share one hash), so the vault's State/Position UTxOs are
    // found at that same credential.
    let vault_ins = script_inputs(tx, policy_id)
    let vault_outs = script_outputs(tx, policy_id)

    expect Some(before) = sole_depositor_shares(vault_ins)
    expect Some(after) = sole_depositor_shares(vault_outs)

    let minted = assets.tokens(tx.mint, policy_id)
    let quantity = assets.quantity_of(tx.mint, policy_id, susdr_asset_name)

    // Exactly one token name may move under this policy, and it must equal
    // the depositor-share delta of the vault transition happening in the
    // same tx — `Deposit`/`Withdraw` move it; `Accrue`, `SetFee`,
    // `ClaimFee`, `SetPaused`, `RotateCommittee` all leave depositor shares
    // flat, so the delta is 0 and this policy refuses to run at all.
    dict.size(minted) == 1 && quantity != 0 && quantity == after - before
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

const op3: ByteArray = #"cc333333333333333333333333333333333333333333333333333333"

const t_version: Int = 1

/// USDr policy id used across the fixtures (28 bytes).
const usdrp: ByteArray =
  #"ca06d650b0ff77c959b3776771c3438bb61fe99a072eeb59d8cedb18"

const usdrn: ByteArray = #"55534472"

const treas: ByteArray = #"deadbeef00000000000000000000000000000000000000000000dead"

const t0: Int = 1_700_000_000_000

fn vault_addr() -> address.Address {
  address.Address { payment_credential: Script(vhash), stake_credential: None }
}

fn user_addr(pkh: ByteArray) -> address.Address {
  address.Address {
    payment_credential: VerificationKey(pkh),
    stake_credential: None,
  }
}

fn usdr_value(lovelace: Int, usdr: Int) -> assets.Value {
  assets.merge(assets.from_lovelace(lovelace), assets.from_asset(usdrp, usdrn, usdr))
}

fn out(addr: address.Address, lovelace: Int, usdr: Int, datum: SusdrDatum) -> Output {
  Output {
    address: addr,
    value: usdr_value(lovelace, usdr),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn plain_out(pkh: ByteArray, lovelace: Int, usdr: Int) -> Output {
  Output {
    address: user_addr(pkh),
    value: usdr_value(lovelace, usdr),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

fn state(total_shares: Int, total_assets: Int, epoch: Int, paused: Bool) -> SusdrDatum {
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

const state_ref: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

/// Fixture transaction. The sUSDr mint is derived from the fixture's own
/// depositor-share delta by default, matching what the `mint` handler would
/// require in a real transaction, so most tests exercise exactly the
/// property they were written for. Tests that target the mint rule itself
/// use `tx_minting` directly with a deliberately wrong quantity.
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
    mint: assets.from_asset(vhash, susdr_asset_name, receipts),
    validity_range: interval.between(t0, t0 + 3_600_000),
  }
}

// --- Deposit -------------------------------------------------------

test deposit_bootstraps_shares_one_to_one() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test deposit_fails_when_minting_more_shares_than_paid_for() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(11_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 11_000_000 }),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test deposit_below_bootstrap_minimum_is_rejected() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(5_000_000, 5_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 5_000_000, Position { owner: alice, shares: 5_000_000 }),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test deposit_fails_while_paused() {
  let s0 = state(0, 0, 7, True)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, True)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test deposit_must_mint_matching_susdr() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx_minting(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
      9_999_999,
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

// --- Accrue --------------------------------------------------------

fn funded_tx_for_accrue(signers: List<ByteArray>, new_epoch: Int) -> Transaction {
  tx(
    [
      input_at(0, out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, False))),
      input_at(
        1,
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ),
    ],
    [
      out(vault_addr(), 4_000_000, 2_000_000, state(10_000_000, 12_000_000, new_epoch, False)),
      out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
    ],
    signers,
  )
}

test accrue_ok_with_full_operator_threshold() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1, op2], 8),
  )
}

test accrue_fails_below_operator_threshold() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1], 8),
  )
}

test accrue_must_bump_the_epoch() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    funded_tx_for_accrue([op1, op2], 7),
  )
}

test accrue_fails_without_a_matching_usdr_increase() {
  // Datum claims +2 USDr of yield but no USDr actually arrived.
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 2_000_000, 0, state(10_000_000, 12_000_000, 8, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

test accrue_cannot_mint_susdr() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx_minting(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 4_000_000, 2_000_000, state(10_000_000, 12_000_000, 8, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [op1, op2],
      1,
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

// --- Withdraw ------------------------------------------------------

test full_withdraw_burns_shares_and_drains_assets() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [out(vault_addr(), 2_000_000, 0, state(0, 0, 7, False)), plain_out(alice, 2_000_000, 10_000_000)],
      [alice],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 10_000_000 },
    state_ref,
    t,
  )
}

test withdraw_cannot_take_more_than_the_share_price_allows() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 1_000_000, 0, state(0, -1_000_000, 7, False)),
        plain_out(alice, 3_000_000, 11_000_000),
      ],
      [alice],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 10_000_000 },
    state_ref,
    t,
  )
}

test partial_withdraw_leaves_a_viable_position() {
  // 4 USDr taken from a 10 USDr position at price 1; 6 USDr stays behind.
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 2_000_000, 0, state(6_000_000, 6_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 6_000_000, Position { owner: alice, shares: 6_000_000 }),
        plain_out(alice, 2_000_000, 4_000_000),
      ],
      [alice],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 4_000_000 },
    state_ref,
    t,
  )
}

test partial_withdraw_stranding_a_dust_position_is_rejected() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 2_000_000, 0, state(500_000, 500_000, 7, False)),
        out(vault_addr(), 2_000_000, 500_000, Position { owner: alice, shares: 500_000 }),
        plain_out(alice, 2_000_000, 9_500_000),
      ],
      [alice],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 9_500_000 },
    state_ref,
    t,
  )
}

test withdraw_is_still_allowed_while_paused() {
  let s0 = state(10_000_000, 10_000_000, 7, True)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [out(vault_addr(), 2_000_000, 0, state(0, 0, 7, True)), plain_out(alice, 2_000_000, 10_000_000)],
      [alice],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 10_000_000 },
    state_ref,
    t,
  )
}

test withdraw_must_burn_the_susdr() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx_minting(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [out(vault_addr(), 2_000_000, 0, state(0, 0, 7, False)), plain_out(alice, 2_000_000, 10_000_000)],
      [alice],
      0,
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 10_000_000 },
    state_ref,
    t,
  )
}

// --- Position spends -----------------------------------------------

fn position_spend_tx(signers: List<ByteArray>, payee: ByteArray) -> Transaction {
  tx(
    [
      input_at(0, out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, False))),
      input_at(
        1,
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ),
    ],
    [out(vault_addr(), 2_000_000, 0, state(0, 0, 7, False)), plain_out(payee, 2_000_000, 10_000_000)],
    signers,
  )
}

test position_spend_ok_when_owner_signs_and_is_paid() {
  let p = Position { owner: alice, shares: 10_000_000 }
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([alice], alice),
  )
}

test position_spend_fails_when_owner_did_not_sign() {
  let p = Position { owner: alice, shares: 10_000_000 }
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([mallory], alice),
  )
}

test position_spend_fails_when_funds_go_to_a_stranger() {
  let p = Position { owner: alice, shares: 10_000_000 }
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    position_spend_tx([alice], mallory),
  )
}

test position_spend_fails_without_the_state_utxo() {
  let p = Position { owner: alice, shares: 10_000_000 }
  let t =
    tx(
      [input_at(1, out(vault_addr(), 2_000_000, 0, p))],
      [plain_out(alice, 2_000_000, 10_000_000)],
      [alice],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(p),
    Withdraw { shares: 10_000_000 },
    ref_at(1),
    t,
  )
}

// --- Pause / committee ---------------------------------------------

test operators_can_pause() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 10_000_000, state(10_000_000, 10_000_000, 7, True))],
      [op1, op2],
    )
  susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), SetPaused { paused: True }, state_ref, t)
}

test a_single_operator_cannot_pause() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 10_000_000, state(10_000_000, 10_000_000, 7, True))],
      [op1],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), SetPaused { paused: True }, state_ref, t)
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
    }
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, hijacked),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test state_must_be_recreated_exactly_once() fail {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 10_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 10_000_000, state(10_000_000, 10_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

// --- Committee rotation --------------------------------------------

fn state_with(
  operators: List<ByteArray>,
  threshold: Int,
  total_shares: Int,
  total_assets: Int,
  epoch: Int,
) -> SusdrDatum {
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
  }
}

test committee_can_be_rotated_by_the_outgoing_quorum() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([op1, op3], 2, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 10_000_000, s1)],
      [op1, op2],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
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
      [input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 10_000_000, s1)],
      [op1],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    RotateCommittee { operators: [mallory], threshold: 1 },
    state_ref,
    t,
  )
}

test rotation_cannot_install_an_unsatisfiable_committee() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let s1 = state_with([op1, op3], 3, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 10_000_000, s1)],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
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
      [input_at(0, out(vault_addr(), 4_000_000, 10_000_000, s0))],
      [out(vault_addr(), 2_000_000, 8_000_000, s1)],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    RotateCommittee { operators: [op1, op3], threshold: 2 },
    state_ref,
    t,
  )
}

// --- Value purity ----------------------------------------------------

const junk_policy: ByteArray = #"99999999999999999999999999999999999999999999999999999999"

fn out_with_token(addr: address.Address, lovelace: Int, usdr: Int, datum: SusdrDatum) -> Output {
  Output {
    address: addr,
    value: assets.merge(usdr_value(lovelace, usdr), assets.from_asset(junk_policy, #"deadbeef", 1)),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

test a_deposit_cannot_park_native_tokens_in_a_position() {
  let s0 = state(0, 0, 7, False)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, s0))],
      [
        out(vault_addr(), 2_000_000, 0, state(10_000_000, 10_000_000, 7, False)),
        out_with_token(
          vault_addr(),
          2_000_000,
          10_000_000,
          Position { owner: alice, shares: 10_000_000 },
        ),
      ],
      [alice],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

// --- Management fee --------------------------------------------------

fn fee_state(
  total_shares: Int,
  total_assets: Int,
  epoch: Int,
  fee_bps: Int,
  treasury_shares: Int,
  owed_since: Int,
) -> SusdrDatum {
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
  }
}

const fee_window: Int = max_settle_window

// 1_000 USDr at price 1, one full settle window (90 days) at 100 bps =>
// 2_465_753 USDr-units of fee, settled as
// floor(2_465_753 * 1_000_000_000 / 997_534_247) treasury shares.
const fee_year_shares: Int = 2_471_847

test accrue_settles_the_management_fee_in_shares() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_002_000_000, 8, 100, fee_year_shares, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000, 1_002_000_000, s1)],
      [op1, op2],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

test accrue_cannot_skip_the_fee() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 = fee_state(1_000_000_000, 1_002_000_000, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000, 1_002_000_000, s1)],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

test fee_rate_can_be_set_within_the_cap() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_000_000_000, 7, 250, fee_year_shares, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000, 1_000_000_000, s1)],
      [op1, op2],
    )
  susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), SetFee { fee_bps: 250 }, state_ref, t)
}

test fee_rate_above_the_cap_is_rejected() {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, 0)
  let s1 = fee_state(1_000_000_000, 1_000_000_000, 7, 900, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000, 1_000_000_000, s1)],
      [op1, op2],
    )
  !susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), SetFee { fee_bps: 900 }, state_ref, t)
}

// --- Fee claims -------------------------------------------------------

const fee_year_payout: Int = 2_465_752

fn claimable() -> SusdrDatum {
  fee_state(1_000_000_000 + fee_year_shares, 1_000_000_000, 8, 100, fee_year_shares, 0)
}

test treasury_can_claim_its_fee_shares() {
  let s0 = claimable()
  let s1 = fee_state(1_000_000_000, 1_000_000_000 - fee_year_payout, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [
        out(vault_addr(), 1_000_000, 1_000_000_000 - fee_year_payout, s1),
        plain_out(treas, 1_000_000, fee_year_payout),
      ],
      [op1, op2],
    )
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    ClaimFee { shares: fee_year_shares },
    state_ref,
    t,
  )
}

test fee_claim_must_pay_the_recorded_treasury() {
  let s0 = claimable()
  let s1 = fee_state(1_000_000_000, 1_000_000_000 - fee_year_payout, 8, 100, 0, 0)
  let t =
    tx(
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [
        out(vault_addr(), 1_000_000, 1_000_000_000 - fee_year_payout, s1),
        plain_out(mallory, 1_000_000, fee_year_payout),
      ],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    ClaimFee { shares: fee_year_shares },
    state_ref,
    t,
  )
}

// --- Security scan regressions (ported from AUDIT.md V-01, V-03, V-05) ---

test two_state_inputs_are_rejected() fail {
  let s0 = state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)
  let planted = state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 10_000_000, s0)),
        input_at(1, out(vault_addr(), 2_000_000, 10_000_000, planted)),
      ],
      [
        out(vault_addr(), 2_000_000, 10_000_000, state_with([op1, op2], 2, 10_000_000, 10_000_000, 7)),
        plain_out(mallory, 2_000_000, 10_000_000),
      ],
      [mallory],
    )
  susdr_vault.spend(t_version, usdrp, usdrn, Some(s0), Deposit, state_ref, t)
}

test partial_withdraw_must_preserve_owner() {
  let s0 = state(10_000_000, 10_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 2_000_000, 0, state(6_000_000, 6_000_000, 7, False)),
        // Alice signed a withdrawal, not a transfer of her remaining stake.
        out(vault_addr(), 2_000_000, 6_000_000, Position { owner: mallory, shares: 6_000_000 }),
        plain_out(alice, 2_000_000, 4_000_000),
      ],
      [alice],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 4_000_000 },
    state_ref,
    t,
  )
}

test batched_withdraw_cannot_reshuffle_shares() {
  let s0 = state(20_000_000, 20_000_000, 7, False)
  let t =
    tx(
      [
        input_at(0, out(vault_addr(), 2_000_000, 0, s0)),
        input_at(
          1,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: alice, shares: 10_000_000 }),
        ),
        input_at(
          2,
          out(vault_addr(), 2_000_000, 10_000_000, Position { owner: mallory, shares: 10_000_000 }),
        ),
      ],
      [
        out(vault_addr(), 2_000_000, 0, state(16_000_000, 16_000_000, 7, False)),
        out(vault_addr(), 2_000_000, 6_000_000, Position { owner: mallory, shares: 6_000_000 }),
        out(vault_addr(), 2_000_000, 10_000_000, Position { owner: mallory, shares: 10_000_000 }),
        plain_out(alice, 2_000_000, 4_000_000),
      ],
      [alice, mallory],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Withdraw { shares: 4_000_000 },
    state_ref,
    t,
  )
}

test accrue_needs_a_bounded_validity_range() fail {
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, fee_window)
  let s1 =
    fee_state(1_000_000_000 + fee_year_shares, 1_002_000_000, 8, 100, fee_year_shares, 0)
  let t =
    Transaction {
      ..placeholder,
      inputs: [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      outputs: [out(vault_addr(), 1_000_000, 1_002_000_000, s1)],
      extra_signatories: [op1, op2],
      mint: assets.from_asset(vhash, susdr_asset_name, 0),
    }
  susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

test accrue_rejects_oversized_settle_window() {
  let owed_since = max_settle_window + 1
  let s0 = fee_state(1_000_000_000, 1_000_000_000, 7, 100, 0, owed_since)
  let fee =
    fee_assets_for(
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
      [input_at(0, out(vault_addr(), 1_000_000, 1_000_000_000, s0))],
      [out(vault_addr(), 1_000_000, 1_002_000_000, s1)],
      [op1, op2],
    )
  !susdr_vault.spend(
    t_version,
    usdrp,
    usdrn,
    Some(s0),
    Accrue { amount: 2_000_000 },
    state_ref,
    t,
  )
}

// --- sUSDr mint handler, exercised directly ---------------------------

fn mint_state(total_shares: Int, treasury_shares: Int) -> SusdrDatum {
  State {
    total_shares,
    total_assets: total_shares,
    epoch: 1,
    operators: [op1],
    threshold: 1,
    paused: False,
    fee_bps: 0,
    treasury: treas,
    treasury_shares,
    last_fee_time: t0,
  }
}

fn mint_tx(ins: List<Input>, outs: List<Output>, mint: assets.Value) -> Transaction {
  Transaction { ..placeholder, inputs: ins, outputs: outs, mint: mint }
}

test mint_matches_deposit_share_delta() {
  let t =
    mint_tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, mint_state(0, 0)))],
      [out(vault_addr(), 2_000_000, 10_000_000, mint_state(10_000_000, 0))],
      assets.from_asset(vhash, susdr_asset_name, 10_000_000),
    )
  susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}

test mint_more_than_the_share_delta_is_rejected() {
  let t =
    mint_tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, mint_state(0, 0)))],
      [out(vault_addr(), 2_000_000, 10_000_000, mint_state(10_000_000, 0))],
      assets.from_asset(vhash, susdr_asset_name, 10_000_001),
    )
  !susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}

test mint_burn_matches_withdrawn_shares() {
  let t =
    mint_tx(
      [input_at(0, out(vault_addr(), 2_000_000, 12_000_000, mint_state(10_000_000, 0)))],
      [out(vault_addr(), 2_000_000, 2_000_000, mint_state(4_000_000, 0))],
      assets.from_asset(vhash, susdr_asset_name, -6_000_000),
    )
  susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}

test mint_accrual_mints_no_susdr() {
  // Treasury fee shares only: total and treasury rise together, depositor
  // delta 0 — the mint handler must refuse to run at all.
  let t =
    mint_tx(
      [input_at(0, out(vault_addr(), 2_000_000, 12_000_000, mint_state(10_000_000, 0)))],
      [out(vault_addr(), 2_000_000, 13_000_000, mint_state(10_050_000, 50_000))],
      assets.from_asset(vhash, susdr_asset_name, 50_000),
    )
  !susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}

test mint_without_a_vault_state_input_is_rejected() fail {
  let t =
    mint_tx(
      [],
      [out(vault_addr(), 2_000_000, 10_000_000, mint_state(10_000_000, 0))],
      assets.from_asset(vhash, susdr_asset_name, 10_000_000),
    )
  susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}

test mint_two_state_outputs_are_rejected() fail {
  let t =
    mint_tx(
      [input_at(0, out(vault_addr(), 2_000_000, 0, mint_state(0, 0)))],
      [
        out(vault_addr(), 2_000_000, 10_000_000, mint_state(10_000_000, 0)),
        out(vault_addr(), 2_000_000, 10_000_000, mint_state(10_000_000, 0)),
      ],
      assets.from_asset(vhash, susdr_asset_name, 10_000_000),
    )
  susdr_vault.mint(t_version, usdrp, usdrn, Void, vhash, t)
}
