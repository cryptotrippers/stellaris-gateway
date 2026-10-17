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
////
//// State identity (Phase 1, AUDIT.md F-1): the validator is parameterised by
//// a `seed` OutputReference and mints a one-shot state-thread token into the
//// State at bootstrap. Every transition requires the spent and the returned
//// State to carry it, so a State datum paid here by anyone else is inert.
////
//// Position identity (AUDIT.md F-4): each `Deposit` mints one position
//// marker into the Position it creates; markers are conserved at the script
//// and only a marked Position can be withdrawn. Without it a Position datum
//// anyone pays here could be withdrawn against the State for nothing — this
//// vault has no receipt token to burn.

use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use stellaris/shares.{
  VaultAccounting, after_accrue, after_deposit, after_withdraw, deposit_ok,
  mint_shares, redeem_value, withdraw_ok,
}
use stellaris/thread.{
  holds_marker, holds_thread, marker_name, one_shot_mint, thread_name,
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

/// Exactly one State-shaped output among `outs`, else None. Shape only —
/// callers check the thread token separately.
fn sole_state_output(outs: List<Output>) -> Option<Output> {
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
    [only] -> Some(only)
    _ -> None
  }
}

/// Exactly one State datum among `outs`, else None.
fn sole_state(outs: List<Output>) -> Option<MultiDatum> {
  when sole_state_output(outs) is {
    Some(o) -> datum_of(o)
    None -> None
  }
}

/// F-4: every Position among `outs` carries exactly one position marker.
fn positions_marked(outs: List<Output>, policy: PolicyId) -> Bool {
  list.all(
    outs,
    fn(o) {
      when datum_of(o) is {
        Some(Position { .. }) -> holds_marker(o.value, policy)
        _ -> True
      }
    },
  )
}

/// A valid initial ledger: empty books, a sane committee and deposit floor.
fn bootstrap_ok(d: MultiDatum) -> Bool {
  when d is {
    State { total_shares, total_assets, operators, threshold, min_deposit, .. } ->
      total_shares == 0 && total_assets == 0 && min_deposit > 0 && operators_valid(
        operators,
        threshold,
      )
    _ -> False
  }
}

/// Every returned UTxO must be readable, carry only lovelace and the unit,
/// and hold a min-ADA rider. Positions must additionally hold shares > 0, so
/// no zero-share ghost position can be parked at the address.
fn outputs_well_formed(
  outs: List<Output>,
  own: PolicyId,
  policy: PolicyId,
  name: ByteArray,
) -> Bool {
  list.all(
    outs,
    fn(o) {
      let clean = fn(v) { value_clean(v, policy, name) && rider_ok(v) }
      when datum_of(o) is {
        // F-4: a Position carries exactly one marker beside lovelace + unit.
        Some(Position { shares, .. }) ->
          holds_marker(o.value, own) && clean(
            assets.add(o.value, own, marker_name, -1),
          ) && shares > 0
        // The State carries exactly one thread token beside lovelace + unit.
        Some(State { .. }) ->
          holds_thread(o.value, own) && clean(
            assets.add(o.value, own, thread_name, -1),
          )
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
  seed: OutputReference,
) {
  /// Bootstrap: mint the one-shot state-thread token into the initial State.
  /// Position markers (F-4) need the GENUINE State spent alongside; its
  /// accounting branch fixes the exact quantity.
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    when dict.to_pairs(assets.tokens(tx.mint, policy_id)) is {
      [Pair(name, _)] ->
        if name == thread_name {
          let outs = script_outputs(tx, policy_id)
          expect [boot] = outs
          expect Some(boot_datum) = datum_of(boot)
          one_shot_mint(tx, policy_id, seed) && script_inputs(tx, policy_id) == [] && outputs_well_formed(
            outs,
            policy_id,
            unit_policy,
            unit_name,
          ) && bootstrap_ok(boot_datum)
        } else if name == marker_name {
          when sole_state_output(script_inputs(tx, policy_id)) is {
            Some(s) -> holds_thread(s.value, policy_id)
            None -> False
          }
        } else {
          False
        }
      _ -> False
    }
  }

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
        // F-4: only a Position the vault minted a marker into is spendable.
        expect Some(own_in) =
          list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
        let marked = holds_marker(own_in.output.value, hash)
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
          when sole_state_output(ins) is {
            Some(s) -> holds_thread(s.value, hash)
            None -> False
          }
        marked && owner_signed && owner_paid && state_present
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
        // F-1: this State must be the genuine one, and so must its successor.
        expect Some(own_in) =
          list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
        expect Some(next_out) = sole_state_output(outs)
        expect Some(next) = datum_of(next_out)
        let genuine =
          holds_thread(own_in.output.value, hash) && holds_thread(
            next_out.value,
            hash,
          )
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

        // F-4: markers are conserved at the script — they can only leave by
        // being burned — so positions_out - positions_in == minted markers.
        let marker_delta = assets.quantity_of(tx.mint, hash, marker_name)
        let markers_conserved =
          positions_marked(ins, hash) && list.length(position_datums(outs)) - list.length(
            position_datums(ins),
          ) == marker_delta

        // Structural rules that hold for EVERY action. The committee, the
        // deposit floor, and the epoch counter are immutable through ordinary
        // spending; the returned state must stay solvent against the unit
        // balance actually locked in this transaction.
        let structural =
          genuine && markers_conserved && outputs_well_formed(outs, hash, unit_policy, unit_name) && n_operators == operators && n_threshold == threshold && n_min_deposit == min_deposit && min_deposit > 0 && operators_valid(
              operators,
              threshold,
            ) && n_shares >= 0 && n_assets >= 0

        let transition =
          when redeemer is {
            // ------------------------------------------------
            Deposit -> {
              let minted = mint_shares(acc, value_delta)
              let expected = after_deposit(acc, value_delta, minted)
              // F-4: exactly one new, marked Position; none spent.
              marker_delta == 1 && position_datums(ins) == [] && !paused && value_delta >= min_deposit && deposit_ok(
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

        // AUDIT.md M-1: a `solvent(.., n_assets)` check used to sit here. It
        // compared `n_assets <= n_assets`, i.e. checked nothing. As in
        // yield_vault (V-07), solvency is inductive: every branch above ties
        // `n_assets` to the exact unit delta at the script address.
        structural && transition
      }
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests — the validator had none before Phase 1. These cover the
// state-thread token (AUDIT.md F-1) plus an honest deposit / withdraw path
// so the token checks are tested against transactions that otherwise pass.
// ------------------------------------------------------------------

const t_hash: ByteArray =
  #"77777777777777777777777777777777777777777777777777777777"

const t_op1: ByteArray =
  #"aa111111111111111111111111111111111111111111111111111111"

const t_op2: ByteArray =
  #"bb222222222222222222222222222222222222222222222222222222"

const t_alice: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

const t_mallory: ByteArray =
  #"22222222222222222222222222222222222222222222222222222222"

// "sfm-01"
const t_asset: ByteArray = #"73666d2d3031"

const t_seed: OutputReference =
  OutputReference {
    transaction_id: #"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed",
    output_index: 0,
  }

fn t_state(total_shares: Int, total_assets: Int) -> MultiDatum {
  State {
    total_shares,
    total_assets,
    epoch: 3,
    operators: [t_op1, t_op2],
    threshold: 2,
    paused: False,
    min_deposit: 10_000_000,
  }
}

fn t_addr() -> Address {
  Address { payment_credential: Script(t_hash), stake_credential: None }
}

/// A UTxO at the vault with NO thread token: what anyone can pay here.
fn t_bare(lovelace: Int, d: MultiDatum) -> Output {
  Output {
    address: t_addr(),
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

/// A vault UTxO; a State carries the genuine thread token.
fn t_out(lovelace: Int, d: MultiDatum) -> Output {
  let o = t_bare(lovelace, d)
  when d is {
    State { .. } -> Output { ..o, value: assets.add(o.value, t_hash, thread_name, 1) }
    Position { .. } -> Output { ..o, value: assets.add(o.value, t_hash, marker_name, 1) }
  }
}

fn t_key(pkh: ByteArray, lovelace: Int) -> Output {
  Output {
    address: Address { payment_credential: VerificationKey(pkh), stake_credential: None },
    value: assets.from_lovelace(lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

fn t_ref(ix: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: ix,
  }
}

fn t_in(ix: Int, o: Output) -> Input {
  Input { output_reference: t_ref(ix), output: o }
}

/// The marker mint implied by the fixture: one per Position created, minus
/// one per Position consumed.
fn t_tx(ins: List<Input>, outs: List<Output>, signers: List<ByteArray>) -> Transaction {
  let created =
    list.length(position_datums(outs)) - list.length(
      position_datums(list.map(ins, fn(i) { i.output })),
    )
  Transaction {
    ..placeholder,
    inputs: ins,
    outputs: outs,
    extra_signatories: signers,
    mint: assets.from_asset(t_hash, marker_name, created),
  }
}

/// Spend the input at index `ix` holding datum `d`. ADA-denominated vault.
fn t_spend(d: MultiDatum, r: MultiRedeemer, ix: Int, t: Transaction) -> Bool {
  multi_asset_vault.spend(1, t_asset, #"", #"", t_seed, Some(d), r, t_ref(ix), t)
}

fn t_mint(t: Transaction) -> Bool {
  multi_asset_vault.mint(1, t_asset, #"", #"", t_seed, Void, t_hash, t)
}

fn t_boot_tx(ins: List<Input>, outs: List<Output>, minted: Int) -> Transaction {
  Transaction {
    ..t_tx(ins, outs, [t_op1]),
    mint: assets.from_asset(t_hash, thread_name, minted),
  }
}

fn t_seed_in() -> Input {
  Input { output_reference: t_seed, output: t_key(t_op1, 50_000_000) }
}

test bootstrap_mints_the_thread_token_into_an_empty_state() {
  t_mint(t_boot_tx([t_seed_in()], [t_out(2_000_000, t_state(0, 0))], 1))
}

test bootstrap_without_the_seed_is_rejected() {
  !t_mint(t_boot_tx([t_in(9, t_key(t_op1, 50_000_000))], [t_out(2_000_000, t_state(0, 0))], 1))
}

test bootstrap_cannot_start_with_assets_on_the_books() {
  !t_mint(
    t_boot_tx([t_seed_in()], [t_out(2_000_000, t_state(10_000_000, 10_000_000))], 1),
  )
}

test bootstrap_cannot_happen_while_a_state_is_spent() {
  !t_mint(
    t_boot_tx(
      [t_seed_in(), t_in(0, t_out(2_000_000, t_state(10_000_000, 10_000_000)))],
      [t_out(2_000_000, t_state(0, 0))],
      1,
    ),
  )
}

test bootstrap_cannot_burn_the_thread_token() {
  !t_mint(t_boot_tx([t_seed_in()], [t_out(2_000_000, t_state(0, 0))], -1))
}

/// Honest control: a 10 ADA deposit at price 1 into the genuine State.
test genuine_state_accepts_a_deposit() {
  let s0 = t_state(10_000_000, 10_000_000)
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0))],
      [
        t_out(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  t_spend(s0, Deposit, 0, t)
}

/// F-1: the identical deposit against a token-less planted State fails.
test planted_state_cannot_take_a_deposit() {
  let s0 = t_state(10_000_000, 10_000_000)
  let t =
    t_tx(
      [t_in(0, t_bare(2_000_000, s0))],
      [
        t_out(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  !t_spend(s0, Deposit, 0, t)
}

/// F-1: the State may not shed its token.
test state_must_keep_its_thread_token() {
  let s0 = t_state(10_000_000, 10_000_000)
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0))],
      [
        t_bare(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  !t_spend(s0, Deposit, 0, t)
}

/// The thread token is the only extra the State may carry.
test state_cannot_carry_junk_beside_its_thread_token() {
  let s0 = t_state(10_000_000, 10_000_000)
  let s1 = t_out(2_000_000, t_state(20_000_000, 20_000_000))
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0))],
      [
        Output { ..s1, value: assets.add(s1.value, t_op1, #"ff", 1) },
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  !t_spend(s0, Deposit, 0, t)
}

/// Honest control: a full withdraw against the genuine State.
test position_can_be_withdrawn_against_the_genuine_state() {
  let s0 = t_state(10_000_000, 10_000_000)
  let p = Position { owner: t_alice, shares: 10_000_000 }
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0)), t_in(1, t_out(10_000_000, p))],
      [t_out(2_000_000, t_state(0, 0)), t_key(t_alice, 10_000_000)],
      [t_alice],
    )
  t_spend(p, Withdraw { shares: 10_000_000 }, 1, t)
}

/// F-1: the same Position cannot be redeemed against a planted State, so
/// shares minted at an attacker's price can never be cashed in.
test position_cannot_be_withdrawn_against_a_planted_state() {
  let s0 = t_state(10_000_000, 10_000_000)
  let p = Position { owner: t_mallory, shares: 10_000_000 }
  let t =
    t_tx(
      [t_in(0, t_bare(2_000_000, s0)), t_in(1, t_out(10_000_000, p))],
      [t_out(2_000_000, t_state(0, 0)), t_key(t_mallory, 10_000_000)],
      [t_mallory],
    )
  !t_spend(p, Withdraw { shares: 10_000_000 }, 1, t)
}

/// F-4: the attack this vault had no defence against at all. A Position datum
/// paid here by Mallory (no marker) claims 10M shares; withdrawing it would
/// take 10 ADA out of the State's balance for nothing.
fn t_f4(position: Output) -> Transaction {
  t_tx(
    [t_in(0, t_out(12_000_000, t_state(10_000_000, 10_000_000))), t_in(1, position)],
    // 10 ADA of shares paid out: 2 from the Position, 8 from the State.
    [t_out(4_000_000, t_state(0, 0)), t_key(t_mallory, 10_000_000)],
    [t_mallory],
  )
}

test planted_position_cannot_be_withdrawn() {
  let p = Position { owner: t_mallory, shares: 10_000_000 }
  !t_spend(p, Withdraw { shares: 10_000_000 }, 1, t_f4(t_bare(2_000_000, p))) && !t_spend(
    t_state(10_000_000, 10_000_000),
    Withdraw { shares: 10_000_000 },
    0,
    t_f4(t_bare(2_000_000, p)),
  )
}

/// Control: the same withdrawal of a marked Position is accepted by BOTH
/// branches, so the test above fails for exactly one reason — the marker.
test marked_position_with_the_same_shape_is_withdrawn() {
  let p = Position { owner: t_mallory, shares: 10_000_000 }
  let t = t_f4(t_out(2_000_000, p))
  t_spend(p, Withdraw { shares: 10_000_000 }, 1, t) && t_spend(
    t_state(10_000_000, 10_000_000),
    Withdraw { shares: 10_000_000 },
    0,
    t,
  )
}

test deposit_must_mint_exactly_one_marker() {
  let s0 = t_state(10_000_000, 10_000_000)
  let base =
    t_tx(
      [t_in(0, t_out(2_000_000, s0))],
      [
        t_out(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  let none = Transaction { ..base, mint: assets.zero }
  t_spend(s0, Deposit, 0, base) && !t_spend(s0, Deposit, 0, none)
}

test deposit_cannot_send_the_marker_to_a_wallet() {
  let s0 = t_state(10_000_000, 10_000_000)
  let leaked =
    Output {
      ..t_key(t_mallory, 2_000_000),
      value: assets.add(assets.from_lovelace(2_000_000), t_hash, marker_name, 1),
    }
  let t =
    Transaction {
      ..t_tx(
        [t_in(0, t_out(2_000_000, s0))],
        [
          t_out(2_000_000, t_state(20_000_000, 20_000_000)),
          t_bare(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
          leaked,
        ],
        [t_alice],
      ),
      mint: assets.from_asset(t_hash, marker_name, 1),
    }
  !t_spend(s0, Deposit, 0, t)
}

test markers_need_the_genuine_state_to_be_spent() {
  let outs =
    [
      t_out(2_000_000, t_state(20_000_000, 20_000_000)),
      t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
    ]
  let genuine = t_tx([t_in(0, t_out(2_000_000, t_state(10_000_000, 10_000_000)))], outs, [t_alice])
  let planted = t_tx([t_in(0, t_bare(2_000_000, t_state(10_000_000, 10_000_000)))], outs, [t_alice])
  t_mint(genuine) && !t_mint(planted)
}

/// A full close must burn the marker, not carry it off to a wallet.
test full_withdraw_must_burn_the_marker() {
  let p = Position { owner: t_alice, shares: 10_000_000 }
  let s0 = t_state(10_000_000, 10_000_000)
  let carried =
    Output {
      ..t_key(t_alice, 10_000_000),
      value: assets.add(assets.from_lovelace(10_000_000), t_hash, marker_name, 1),
    }
  let t =
    Transaction {
      ..t_tx(
        [t_in(0, t_out(2_000_000, s0)), t_in(1, t_out(10_000_000, p))],
        [t_out(2_000_000, t_state(0, 0)), carried],
        [t_alice],
      ),
      mint: assets.zero,
    }
  !t_spend(s0, Withdraw { shares: 10_000_000 }, 0, t)
}

/// A deposit creates exactly ONE Position.
test deposit_cannot_create_two_positions() {
  let s0 = t_state(10_000_000, 10_000_000)
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0))],
      [
        t_out(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(5_000_000, Position { owner: t_alice, shares: 5_000_000 }),
        t_out(5_000_000, Position { owner: t_alice, shares: 5_000_000 }),
      ],
      [t_alice],
    )
  !t_spend(s0, Deposit, 0, t)
}

/// A deposit spends no existing Position.
test deposit_cannot_spend_an_existing_position() {
  let s0 = t_state(10_000_000, 10_000_000)
  let mine = Position { owner: t_alice, shares: 10_000_000 }
  let t =
    t_tx(
      [t_in(0, t_out(2_000_000, s0)), t_in(1, t_out(10_000_000, mine))],
      [
        t_out(2_000_000, t_state(20_000_000, 20_000_000)),
        t_out(10_000_000, mine),
        t_out(10_000_000, Position { owner: t_alice, shares: 10_000_000 }),
      ],
      [t_alice],
    )
  !t_spend(s0, Deposit, 0, t)
}
