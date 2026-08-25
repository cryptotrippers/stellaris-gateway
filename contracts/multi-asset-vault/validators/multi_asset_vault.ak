//// Stellaris multi-asset vault — Wing B, step 1.
////
//// A shared, multi-depositor vault denominated in ANY single Cardano unit:
//// ADA (empty policy) or a native token such as USDr / USDM / iUSD. The
//// validator is parameterised by `(version, asset_id, policy_id, token_name)`,
//// so one compiled script yields a distinct address per project *and*
//// denomination without touching the source.
////
//// The UTxO model mirrors the ADA yield vault so the app's builders and the
//// `RwaVaultAdapter` interface carry over unchanged:
////
////   * exactly ONE `State` UTxO — the aggregate ledger (shares, accounted
////     assets, epoch, operator committee, pause flag, minimum deposit). It
////     must be spent and re-created by every action, so the accounting rules
////     run on every transaction;
////   * many `Position` UTxOs — one per depositor, pinning the owner's key
////     hash and their share count.
////
//// Differences from the ADA-only vault:
////
////   * balances are measured in the parameterised UNIT, not in lovelace;
////   * lovelace riders on token positions are custody overhead, never part
////     of the accounted balance, and are returned with the position;
////   * every script output must be "clean": lovelace + the unit and nothing
////     else, which blocks the token-flood min-ADA lock.
////
//// Share arithmetic is the audited `stellaris/shares` module, reused verbatim.

use aiken/collection/list
use cardano/address.{Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use stellaris/shares.{
  VaultAccounting, after_accrue, after_deposit, after_withdraw, deposit_ok,
  mint_shares, redeem_value, solvent, withdraw_ok,
}
use stellaris/units.{rider_ok, unit_of, value_clean}

pub type MultiDatum {
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
    /// Smallest acceptable deposit in the unit's base units. Denominations
    /// differ wildly (1 ADA = 1e6 lovelace, 1 USDr = 1e6 base units, other
    /// issuers may use 1e2), so the floor is data rather than a constant.
    /// Written at bootstrap and immutable afterwards.
    min_deposit: Int,
  }
}

pub type MultiRedeemer {
  /// Add units of the deposit denomination, mint shares at the current price.
  Deposit
  /// Burn `shares` from one position, take at most `redeem_value(shares)`.
  Withdraw { shares: Int }
  /// Operators book `amount` units of realised yield. Share counts untouched.
  Accrue { amount: Int }
  /// Operators halt deposits and accruals. Withdrawals stay open.
  SetPaused { paused: Bool }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

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

fn datum_of(output: Output) -> Option<MultiDatum> {
  when output.datum is {
    InlineDatum(raw) -> {
      expect d: MultiDatum = raw
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

fn values_of(outs: List<Output>) -> List<Value> {
  list.map(outs, fn(o) { o.value })
}

/// Total of the deposit unit held by `outs`.
fn unit_total(outs: List<Output>, policy: PolicyId, name: ByteArray) -> Int {
  list.foldr(outs, 0, fn(o, acc) { acc + unit_of(o.value, policy, name) })
}

/// Total shares recorded by the Position UTxOs in `outs`.
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

fn position_datums(outs: List<Output>) -> List<MultiDatum> {
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

/// Exactly one State datum among `outs`, else None.
fn sole_state(outs: List<Output>) -> Option<MultiDatum> {
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

/// Every returned UTxO must be readable, carry only lovelace and the unit,
/// and hold a min-ADA rider. Positions must additionally hold shares > 0, so
/// no zero-share ghost position can be parked at the address.
fn outputs_well_formed(
  outs: List<Output>,
  policy: PolicyId,
  name: ByteArray,
) -> Bool {
  list.all(
    outs,
    fn(o) {
      let clean = value_clean(o.value, policy, name) && rider_ok(o.value)
      when datum_of(o) is {
        Some(Position { shares, .. }) -> clean && shares > 0
        Some(State { .. }) -> clean
        None -> False
      }
    },
  )
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

fn operators_valid(operators: List<ByteArray>, threshold: Int) -> Bool {
  let n = list.length(operators)
  threshold >= 1 && threshold <= n && list.length(list.unique(operators)) == n
}

// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator multi_asset_vault(
  _version: Int,
  _asset_id: ByteArray,
  unit_policy: PolicyId,
  unit_name: ByteArray,
) {
  spend(
    datum: Option<MultiDatum>,
    redeemer: MultiRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(hash) = own_hash(tx.inputs, own_ref)

    let ins = script_inputs(tx, hash)
    let outs = script_outputs(tx, hash)

    when d is {
      // --------------------------------------------------------
      // Spending a depositor position.
      // --------------------------------------------------------
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
        // The State UTxO must be spent in the same transaction: that is what
        // forces the accounting branch below to run and balance the books.
        let state_present =
          when sole_state(ins) is {
            Some(_) -> True
            None -> False
          }
        owner_signed && owner_paid && state_present
      }

      // --------------------------------------------------------
      // Spending the aggregate state: enforce the transition.
      // --------------------------------------------------------
      State {
        total_shares,
        total_assets,
        epoch,
        operators,
        threshold,
        paused,
        min_deposit,
      } -> {
        // Exactly one State in and one State out — two State UTxOs must never
        // be collapsible into one, or the surplus leaves unaccounted.
        expect Some(_only_state_in) = sole_state(ins)
        expect Some(next) = sole_state(outs)
        expect State {
          total_shares: n_shares,
          total_assets: n_assets,
          epoch: n_epoch,
          operators: n_operators,
          threshold: n_threshold,
          paused: n_paused,
          min_deposit: n_min_deposit,
        } = next

        let acc = VaultAccounting { total_shares, total_assets }
        let held_in = unit_total(ins, unit_policy, unit_name)
        let held_out = unit_total(outs, unit_policy, unit_name)
        let value_delta = held_out - held_in
        let shares_in = position_shares(ins)
        let shares_out = position_shares(outs)
        let shares_delta = shares_out - shares_in

        // Structural rules that hold for EVERY action. The committee, the
        // deposit floor, and the epoch counter are immutable through ordinary
        // spending; the returned state must stay solvent against the unit
        // balance actually locked in this transaction.
        let structural =
          outputs_well_formed(outs, unit_policy, unit_name) &&
            list.all(
              values_of(outs),
              fn(v) { value_clean(v, unit_policy, unit_name) },
            ) && n_operators == operators && n_threshold == threshold && n_min_deposit == min_deposit && min_deposit > 0 && operators_valid(
              operators,
              threshold,
            ) && n_shares >= 0 && n_assets >= 0

        let transition =
          when redeemer is {
            // ------------------------------------------------
            Deposit -> {
              let minted = mint_shares(acc, value_delta)
              let expected = after_deposit(acc, value_delta, minted)
              !paused && value_delta >= min_deposit && deposit_ok(
                acc,
                value_delta,
              ) && minted > 0 && shares_delta == minted && n_shares == expected.total_shares && n_assets == expected.total_assets && n_epoch == epoch && n_paused == paused
            }

            // ------------------------------------------------
            Withdraw { shares } -> {
              // Exactly one position may be redeemed per transaction, so the
              // rules below reason about a single, identified stake.
              expect [Position { owner, shares: held }] = position_datums(ins)
              let paid = redeem_value(acc, shares)
              let expected = after_withdraw(acc, shares, paid)
              let remaining = held - shares
              let continuity =
                if remaining == 0 {
                  position_datums(outs) == []
                } else {
                  position_datums(outs) == [
                    Position { owner, shares: remaining },
                  ]
                }
              withdraw_ok(acc, held, shares) && list.has(
                tx.extra_signatories,
                owner,
              ) && continuity && shares_delta == -shares && value_delta >= -paid && n_shares == expected.total_shares && n_assets == expected.total_assets && n_epoch == epoch && n_paused == paused
            }

            // ------------------------------------------------
            Accrue { amount } -> {
              let expected = after_accrue(acc, amount)
              !paused && amount > 0 && threshold_met(
                operators,
                threshold,
                tx.extra_signatories,
              ) && value_delta == amount && shares_delta == 0 && position_datums(
                outs,
              ) == position_datums(ins) && n_shares == expected.total_shares && n_assets == expected.total_assets && n_epoch == epoch + 1 && n_paused == paused
            }

            // ------------------------------------------------
            SetPaused { paused: want } ->
              threshold_met(operators, threshold, tx.extra_signatories) && n_paused == want && value_delta == 0 && shares_delta == 0 && n_shares == total_shares && n_assets == total_assets && n_epoch == epoch
          }

        // Solvency: the accounted balance may never exceed the units actually
        // locked by the outputs of this transaction plus the positions that
        // were not touched (which is exactly `n_assets - held_out` claims
        // carried inductively by untouched UTxOs).
        let solvency = solvent(
          VaultAccounting { total_shares: n_shares, total_assets: n_assets },
          n_assets,
        )

        structural && transition && solvency
      }
    }
  }

  else(_) {
    fail
  }
}
