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
use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use stellaris/shares.{
  VaultAccounting, deposit_ok, min_position_value, mint_shares, redeem_value,
  solvent,
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
        let structural =
          committee_unchanged(d, next) && operators_valid(operators, threshold) && positions_well_formed(
            outs,
          ) && solvent(
            VaultAccounting { total_shares: n_shares, total_assets: n_assets },
            locked_out,
          ) && n_epoch >= epoch

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
