//// sTSRA vault (Phase 2.4, SPEC.md §3).
////
//// One script, parameterised by `(seed, reserve)`, is the spending validator
//// for the vault State, long-tier Positions and cooldown Tickets, and the
//// minting policy for `state` (one-shot thread token), `sTSRA` (fungible
//// short-tier shares) and `position` (the marker in every Position and
//// Ticket, the Phase 1 F-4 lesson).
////
//// * Two share classes in one State: short (sTSRA) and long (Positions).
//// * ReportYield splits net yield by weighted assets (`vault_state.split_yield`);
////   the protocol cut is paid out in TSRA, half to the first-loss address.
//// * Unstaking escrows the request-time value in a Ticket; a Claim pays
////   `value * loss_index_now / index_at_request`, never more than `value`.
//// * Committee and `kyc_stake` are read live from the genuine Reserve State
////   (reference input). The datum is PROVISIONAL.
//// * Only ReportLoss (2.5) may ever lower a price; no redeemer here can.
//// * Hardening (Phase 2-H, SPEC.md §3.15): reported yield vests into the
////   prices over 7 days, booked at the validity lower bound; stakes price at
////   the upper bound, exits at the lower bound. Long lock >= 2x cooldown.
////   UnlockLong needs the owner. Claim and UnlockLong pay the spent UTxO's
////   ADA to the owner. Every continuing or new vault output keeps the
////   State's address and carries no reference script (AUDIT.md F-6).

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, Value, lovelace_of, quantity_of}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use stellaris/outputs.{continuing_ok, genesis_out_ok, keeps_lovelace}
use stellaris/thread.{
  marker_name, marker_value, one_shot_mint, thread_name, thread_value,
}
use tessera/eligibility.{eligible}
use tessera/exchange
use tessera/reserve_ref.{genuine_reserve}
use tessera/reserve_state.{ReserveState, threshold_met}
use tessera/rules
use tessera/vault_state.{
  Position, PositionDatum, StateDatum, Ticket, TicketDatum, VaultDatum,
  VaultState, bounds_ok, fold, long_assets_at, loss_index_start,
  short_assets_at, split_yield, stsra_name, vest_period_ms,
}

pub type VaultRedeemer {
  /// Stake `amount` TSRA into the short tier for sTSRA.
  StakeShort { amount: Int, holder: ByteArray }
  /// Stake `amount` TSRA into a long-tier Position payable to `owner`.
  StakeLong { amount: Int, holder: ByteArray, owner: Address }
  /// Burn `shares` sTSRA into a cooldown Ticket payable to `owner`.
  RequestUnstake { shares: Int, owner: Address }
  /// Claim a Ticket after its cooldown (spends the Ticket only).
  Claim
  /// Pay out a long-tier Position after `unlock_at` (State + Position).
  UnlockLong
  /// Committee: credit `gross` TSRA of delivered yield.
  ReportYield { gross: Int }
  /// Committee: change the bounds within their hard limits.
  SetBounds {
    long_weight_bps: Int,
    short_cooldown_ms: Int,
    long_lock_ms: Int,
    protocol_bps: Int,
  }
}

// ---------------------------------------------------------------- helpers

fn own_inputs(inputs: List<Input>, policy: PolicyId) -> List<Output> {
  inputs
    |> list.filter_map(
        fn(i) {
          if i.output.address.payment_credential == Script(policy) {
            Some(i.output)
          } else {
            None
          }
        },
      )
}

fn own_outputs(outputs: List<Output>, policy: PolicyId) -> List<Output> {
  outputs
    |> list.filter(fn(o) { o.address.payment_credential == Script(policy) })
}

fn vault_datum(o: Output) -> Option<VaultDatum> {
  when o.datum is {
    InlineDatum(d) ->
      if d is v: VaultDatum {
        Some(v)
      } else {
        None
      }
    _ -> None
  }
}

fn state_of(o: Output) -> Option<VaultState> {
  when vault_datum(o) is {
    Some(StateDatum(s)) -> Some(s)
    _ -> None
  }
}

/// The one genuine State among `outs`: the output carrying the thread token
/// (exactly one), with a State datum. Planted lookalikes are ignored.
fn sole_state(outs: List<Output>, policy: PolicyId) -> Option<(Output, VaultState)> {
  let marked =
    outs |> list.filter(fn(o) { quantity_of(o.value, policy, thread_name) > 0 })
  when marked is {
    [only] ->
      if quantity_of(only.value, policy, thread_name) == 1 {
        when state_of(only) is {
          Some(s) -> Some((only, s))
          None -> None
        }
      } else {
        None
      }
    _ -> None
  }
}

fn tsra(reserve: PolicyId, qty: Int) -> Value {
  assets.from_asset(reserve, rules.tsra_name, qty)
}

/// Everything paid to `addr`, summed across all outputs.
fn paid_to(tx: Transaction, addr: Address) -> Value {
  list.foldl(
    tx.outputs,
    assets.zero,
    fn(o, acc) {
      if o.address == addr {
        assets.merge(acc, o.value)
      } else {
        acc
      }
    },
  )
}

/// TSRA (under the reserve's policy) paid to `addr` across all outputs.
fn paid_tsra(tx: Transaction, addr: Address, reserve: PolicyId) -> Int {
  quantity_of(paid_to(tx, addr), reserve, rules.tsra_name)
}

/// An exit pays `owner` at least `payout` TSRA and at least the lovelace of
/// the spent Position / Ticket (H2.3), across all outputs to that address.
fn owner_paid(
  tx: Transaction,
  owner: Address,
  reserve: PolicyId,
  payout: Int,
  spent: Output,
) -> Bool {
  let paid = paid_to(tx, owner)
  and {
    quantity_of(paid, reserve, rules.tsra_name) >= payout,
    lovelace_of(paid) >= lovelace_of(spent.value),
  }
}

/// The owner authorised this transaction (H2.3): a key owner signed it; a
/// script owner has an input of its own spent in it, so its validator runs.
fn owner_authorised(tx: Transaction, owner: Address) -> Bool {
  when owner.payment_credential is {
    VerificationKey(k) -> list.has(tx.extra_signatories, k)
    Script(h) ->
      list.any(
        tx.inputs,
        fn(i) { i.output.address.payment_credential == Script(h) },
      )
  }
}

/// The State holds exactly ADA + the thread token + the TSRA both classes own
/// (booked and still vesting).
fn state_value_ok(
  out: Output,
  policy: PolicyId,
  reserve: PolicyId,
  s: VaultState,
) -> Bool {
  assets.without_lovelace(out.value) == assets.merge(
    thread_value(policy),
    tsra(reserve, s.short_assets + s.long_assets + s.vest_short + s.vest_long),
  )
}

/// A Position holds exactly ADA + one marker (its TSRA stays in the State).
fn position_value_ok(out: Output, policy: PolicyId) -> Bool {
  assets.without_lovelace(out.value) == marker_value(policy)
}

/// A Ticket holds exactly ADA + one marker + its escrowed TSRA.
fn ticket_value_ok(
  out: Output,
  policy: PolicyId,
  reserve: PolicyId,
  value: Int,
) -> Bool {
  assets.without_lovelace(out.value) == assets.merge(
    marker_value(policy),
    tsra(reserve, value),
  )
}

/// What this transaction mints or burns under the vault's own policy.
fn own_mint(tx: Transaction, policy: PolicyId) -> Value {
  assets.restricted_to(tx.mint, [policy])
}

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

/// Staking gate: the genuine Reserve State must be referenced; with its
/// `kyc_stake` switch on, `holder` must pass the one eligibility check.
fn kyc_stake_ok(tx: Transaction, reserve: PolicyId, holder: ByteArray) -> Bool {
  when genuine_reserve(tx, reserve) is {
    Some(r) -> !r.kyc_stake || eligible(tx, r.eligibility_policy, holder)
    None -> False
  }
}

/// The reserve committee (read live from the Reserve State) signed.
fn committee_ok(tx: Transaction, reserve: PolicyId) -> Bool {
  when genuine_reserve(tx, reserve) is {
    Some(r) -> threshold_met(r.operators, r.threshold, tx.extra_signatories)
    None -> False
  }
}

/// A valid genesis State: empty books, the starting loss index, bounds within
/// their hard limits, and fee addresses that are distinct and not the vault.
fn genesis_ok(s: VaultState, policy: PolicyId) -> Bool {
  and {
    s.short_shares == 0,
    s.short_assets == 0,
    s.long_shares == 0,
    s.long_assets == 0,
    s.loss_index == loss_index_start,
    s.vest_short == 0,
    s.vest_long == 0,
    s.vest_from == 0,
    s.vest_until == 0,
    s.epoch == 0,
    bounds_ok(
      s.long_weight_bps,
      s.short_cooldown_ms,
      s.long_lock_ms,
      s.protocol_bps,
      exchange.max_yield_fee_bps,
    ),
    s.first_loss_addr.payment_credential != Script(policy),
    s.treasury_addr.payment_credential != Script(policy),
    s.first_loss_addr != s.treasury_addr,
  }
}

/// Genesis: one-shot mint of `state` (seed consumed, nothing else minted), no
/// vault input spent, exactly one vault output holding exactly ADA + the token,
/// at the vault's enterprise address with no reference script (F-6).
fn genesis(
  tx: Transaction,
  policy: PolicyId,
  seed: OutputReference,
  reserve: PolicyId,
) -> Bool {
  when own_outputs(tx.outputs, policy) is {
    [boot] ->
      when state_of(boot) is {
        Some(s) ->
          and {
            one_shot_mint(tx, policy, seed),
            own_inputs(tx.inputs, policy) == [],
            genesis_out_ok(boot, policy),
            state_value_ok(boot, policy, reserve, s),
            genesis_ok(s, policy),
          }
        None -> False
      }
    _ -> False
  }
}

/// The one vault output that is not the next State.
fn other_output(outs: List<Output>, next_out: Output) -> Option<Output> {
  when list.filter(outs, fn(o) { o != next_out }) is {
    [o] -> Some(o)
    _ -> None
  }
}

// ---------------------------------------------------------------- State

fn state_transition(
  s0: VaultState,
  redeemer: VaultRedeemer,
  tx: Transaction,
  policy: PolicyId,
  reserve: PolicyId,
  ins: List<Output>,
  outs: List<Output>,
) -> Bool {
  // V-01 + F-1: exactly one genuine State on both sides, and the input being
  // spent is that State.
  expect Some((lo, hi)) = finite_bounds(tx)
  expect Some((state_in, in_state)) = sole_state(ins, policy)
  expect Some((next_out, s1)) = sole_state(outs, policy)
  // H2.1: book the yield vested by `lo` first. `lo` has certainly been
  // reached (the ledger refuses the tx before it); `hi` has not, so booking
  // at `hi` would let a far-future upper bound vest everything at once.
  let sf = fold(s0, lo)
  // F-6: the State keeps its exact address, carries no reference script and
  // never loses lovelace (no redeemer pays ADA out of the State).
  let common =
    and {
      in_state == s0,
      state_value_ok(next_out, policy, reserve, s1),
      continuing_ok(next_out, state_in),
      keeps_lovelace(next_out, state_in),
    }
  when redeemer is {
    // Stakes price at `hi` (the most yield that can have vested by the time
    // the tx lands): a staker never buys below the true price.
    StakeShort { amount, holder } -> {
      let price_assets = short_assets_at(sf, hi)
      let minted = exchange.mint_shares(amount, sf.short_shares, price_assets)
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 1,
        amount > 0,
        exchange.deposit_ok(amount, sf.short_shares, price_assets),
        kyc_stake_ok(tx, reserve, holder),
        own_mint(tx, policy) == assets.from_asset(policy, stsra_name, minted),
        s1 == VaultState {
          ..sf,
          short_shares: sf.short_shares + minted,
          short_assets: sf.short_assets + amount,
          epoch: s0.epoch + 1,
        },
      }
    }

    StakeLong { amount, holder, owner } -> {
      expect Some(pos) = other_output(outs, next_out)
      let price_assets = long_assets_at(sf, hi)
      let minted = exchange.mint_shares(amount, sf.long_shares, price_assets)
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 2,
        amount >= exchange.min_position_value,
        exchange.deposit_ok(amount, sf.long_shares, price_assets),
        kyc_stake_ok(tx, reserve, holder),
        // a Position owned by the vault itself could never be paid out
        owner.payment_credential != Script(policy),
        vault_datum(pos) == Some(
          PositionDatum(
            Position { owner, shares: minted, unlock_at: hi + s0.long_lock_ms },
          ),
        ),
        position_value_ok(pos, policy),
        continuing_ok(pos, state_in),
        own_mint(tx, policy) == marker_value(policy),
        s1 == VaultState {
          ..sf,
          long_shares: sf.long_shares + minted,
          long_assets: sf.long_assets + amount,
          epoch: s0.epoch + 1,
        },
      }
    }

    // Exits price at `lo`: only yield vested by then is paid out.
    RequestUnstake { shares, owner } -> {
      expect Some(ticket) = other_output(outs, next_out)
      let v = exchange.redeem_value(shares, sf.short_shares, sf.short_assets)
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 2,
        shares > 0,
        shares <= sf.short_shares,
        v >= exchange.min_position_value,
        // a Ticket owned by the vault itself could never be claimed
        owner.payment_credential != Script(policy),
        vault_datum(ticket) == Some(
          TicketDatum(
            Ticket {
              owner,
              value: v,
              index_at_request: s0.loss_index,
              claim_after: hi + s0.short_cooldown_ms,
            },
          ),
        ),
        ticket_value_ok(ticket, policy, reserve, v),
        continuing_ok(ticket, state_in),
        own_mint(tx, policy) == assets.merge(
          marker_value(policy),
          assets.from_asset(policy, stsra_name, -shares),
        ),
        s1 == VaultState {
          ..sf,
          short_shares: sf.short_shares - shares,
          short_assets: sf.short_assets - v,
          epoch: s0.epoch + 1,
        },
      }
    }

    UnlockLong -> {
      expect [pos] = list.filter(ins, fn(o) { o != state_in })
      expect Some(PositionDatum(p)) = vault_datum(pos)
      let payout =
        exchange.redeem_value(p.shares, sf.long_shares, sf.long_assets)
      and {
        common,
        list.length(ins) == 2,
        list.length(outs) == 1,
        position_value_ok(pos, policy),
        lo >= p.unlock_at,
        // H2.3: a Position keeps earning after `unlock_at`, so only its
        // owner may end it.
        owner_authorised(tx, p.owner),
        own_mint(tx, policy) == assets.from_asset(policy, marker_name, -1),
        owner_paid(tx, p.owner, reserve, payout, pos),
        s1 == VaultState {
          ..sf,
          long_shares: sf.long_shares - p.shares,
          long_assets: sf.long_assets - payout,
          epoch: s0.epoch + 1,
        },
      }
    }

    // The yield is weighted by each class's whole TSRA (booked + vesting),
    // and vests from max(lo, vest_from) over `vest_period_ms`, together with
    // whatever had not vested yet. The committee window is at most one day,
    // so `lo` cannot be backdated to vest the yield early.
    ReportYield { gross } -> {
      let a_short = sf.short_assets + sf.vest_short
      let a_long = sf.long_assets + sf.vest_long
      if a_short * 10_000 + a_long * s0.long_weight_bps > 0 {
        let (to_first_loss, to_treasury, y_short, y_long) =
          split_yield(gross, s0.protocol_bps, a_short, a_long, s0.long_weight_bps)
        let start =
          if lo > sf.vest_from {
            lo
          } else {
            sf.vest_from
          }
        and {
          common,
          list.length(ins) == 1,
          list.length(outs) == 1,
          gross > 0,
          hi - lo <= rules.max_attest_window,
          committee_ok(tx, reserve),
          own_mint(tx, policy) == assets.zero,
          paid_tsra(tx, s0.first_loss_addr, reserve) >= to_first_loss,
          paid_tsra(tx, s0.treasury_addr, reserve) >= to_treasury,
          s1 == VaultState {
            ..sf,
            vest_short: sf.vest_short + y_short,
            vest_long: sf.vest_long + y_long,
            vest_from: start,
            vest_until: start + vest_period_ms,
            epoch: s0.epoch + 1,
          },
        }
      } else {
        // yield into an empty vault has no one to credit
        False
      }
    }

    SetBounds { long_weight_bps, short_cooldown_ms, long_lock_ms, protocol_bps } ->
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 1,
        committee_ok(tx, reserve),
        bounds_ok(
          long_weight_bps,
          short_cooldown_ms,
          long_lock_ms,
          protocol_bps,
          exchange.max_yield_fee_bps,
        ),
        own_mint(tx, policy) == assets.zero,
        s1 == VaultState {
          ..sf,
          long_weight_bps: long_weight_bps,
          short_cooldown_ms: short_cooldown_ms,
          long_lock_ms: long_lock_ms,
          protocol_bps: protocol_bps,
          epoch: s0.epoch + 1,
        },
      }

    Claim -> False
  }
}

// ---------------------------------------------------------------- Ticket

/// Claim: after the cooldown, pay `owner` the escrowed value scaled by the
/// loss index (never more than the escrow), burn the marker, burn any excess
/// TSRA. Spends only this Ticket; the State is read as a reference input.
/// Permissionless (a Ticket earns nothing, so an early Claim costs its owner
/// nothing); the owner also gets the Ticket's ADA (H2.3).
fn claim(
  t: Ticket,
  own: Output,
  tx: Transaction,
  policy: PolicyId,
  reserve: PolicyId,
  ins: List<Output>,
) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((_, s)) =
    sole_state(list.map(tx.reference_inputs, fn(i) { i.output }), policy)
  let scaled = t.value * s.loss_index / t.index_at_request
  let payout =
    if scaled > t.value {
      t.value
    } else {
      scaled
    }
  let excess = t.value - payout
  and {
    ins == [own],
    own_outputs(tx.outputs, policy) == [],
    ticket_value_ok(own, policy, reserve, t.value),
    lo >= t.claim_after,
    own_mint(tx, policy) == assets.from_asset(policy, marker_name, -1),
    owner_paid(tx, t.owner, reserve, payout, own),
    excess == 0 || quantity_of(tx.mint, reserve, rules.tsra_name) <= -excess,
  }
}

// ---------------------------------------------------------------- validator

validator stsra_vault(seed: OutputReference, reserve: PolicyId) {
  spend(
    datum: Option<VaultDatum>,
    redeemer: VaultRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(own_in) =
      tx.inputs |> list.find(fn(i) { i.output_reference == own_ref })
    expect Script(policy) = own_in.output.address.payment_credential
    let ins = own_inputs(tx.inputs, policy)
    let outs = own_outputs(tx.outputs, policy)
    when d is {
      StateDatum(s0) ->
        state_transition(s0, redeemer, tx, policy, reserve, ins, outs)
      // A Position is only ever spent by UnlockLong, whose State branch does
      // the accounting; here it must be genuine (marker) and the genuine State
      // must be spent alongside.
      PositionDatum(_) ->
        position_value_ok(own_in.output, policy) && sole_state(ins, policy) != None
      TicketDatum(t) -> claim(t, own_in.output, tx, policy, reserve, ins)
    }
  }

  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let names = assets.tokens(tx.mint, policy_id)
    if dict.has_key(names, thread_name) {
      genesis(tx, policy_id, seed, reserve)
    } else if list.all(
      dict.to_pairs(names),
      fn(p) {
        when p is {
          Pair(name, qty) -> name == marker_name && qty < 0
        }
      },
    ) {
      // Only marker burns: a marker exists only inside a Position or Ticket,
      // whose own spend rules decide when it may be burned.
      True
    } else {
      // sTSRA mint/burn or a new marker: the genuine State must transition in
      // this transaction; its branch fixes the exact amounts.
      sole_state(own_inputs(tx.inputs, policy_id), policy_id) != None
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_own: PolicyId =
  #"31313131313131313131313131313131313131313131313131313131"

const t_reserve: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const t_elig: PolicyId =
  #"77777777777777777777777777777777777777777777777777777777"

const t_op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const t_op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const t_op3: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const t_alice: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const t_bob: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

const day: Int = 86_400_000

/// Validity window used by stake / unstake fixtures.
const t_lo: Int = 1_000_000

const t_hi: Int = 2_000_000

fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 3,
  }
}

fn r(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0505050505050505050505050505050505050505050505050505050505050505",
    output_index: i,
  }
}

fn vault_addr() -> Address {
  Address { payment_credential: Script(t_own), stake_credential: None }
}

fn key_addr(k: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(k), stake_credential: None }
}

fn fl_addr() -> Address {
  key_addr(#"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1")
}

fn tr_addr() -> Address {
  key_addr(#"f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2")
}

fn t_vs(ss: Int, sa: Int, ls: Int, la: Int) -> VaultState {
  VaultState {
    short_shares: ss,
    short_assets: sa,
    long_shares: ls,
    long_assets: la,
    loss_index: loss_index_start,
    vest_short: 0,
    vest_long: 0,
    vest_from: 0,
    vest_until: 0,
    long_weight_bps: 12_500,
    short_cooldown_ms: 7 * day,
    long_lock_ms: 30 * day,
    protocol_bps: 1_250,
    first_loss_addr: fl_addr(),
    treasury_addr: tr_addr(),
    epoch: 0,
  }
}

fn bump(s: VaultState) -> VaultState {
  VaultState { ..s, epoch: s.epoch + 1 }
}

fn ada() -> Value {
  assets.from_lovelace(2_000_000)
}

fn state_out_with(s: VaultState, with_token: Bool) -> Output {
  let base =
    ada()
      |> assets.merge(
          tsra(t_reserve, s.short_assets + s.long_assets + s.vest_short + s.vest_long),
        )
  Output {
    address: vault_addr(),
    value: if with_token {
      base |> assets.merge(thread_value(t_own))
    } else {
      base
    },
    datum: InlineDatum(StateDatum(s)),
    reference_script: None,
  }
}

fn state_out(s: VaultState) -> Output {
  state_out_with(s, True)
}

fn state_in(s: VaultState) -> Input {
  Input { output_reference: r(0), output: state_out(s) }
}

fn pos_out(p: Position) -> Output {
  Output {
    address: vault_addr(),
    value: ada() |> assets.merge(marker_value(t_own)),
    datum: InlineDatum(PositionDatum(p)),
    reference_script: None,
  }
}

fn ticket_out(t: Ticket) -> Output {
  Output {
    address: vault_addr(),
    value: ada()
      |> assets.merge(marker_value(t_own))
      |> assets.merge(tsra(t_reserve, t.value)),
    datum: InlineDatum(TicketDatum(t)),
    reference_script: None,
  }
}

fn pay(addr: Address, qty: Int) -> Output {
  Output {
    address: addr,
    value: ada() |> assets.merge(tsra(t_reserve, qty)),
    datum: NoDatum,
    reference_script: None,
  }
}

fn stsra(q: Int) -> Value {
  assets.from_asset(t_own, stsra_name, q)
}

fn marker(q: Int) -> Value {
  assets.from_asset(t_own, marker_name, q)
}

fn t_reserve_state(kyc_stake: Bool, operators: List<ByteArray>) -> ReserveState {
  ReserveState {
    minted_supply: 0,
    attested_reserve: 0,
    mint_cap: 0,
    attestation_epoch: 0,
    attested_at: 0,
    epoch: 0,
    operators,
    threshold: 2,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake,
    eligibility_policy: t_elig,
  }
}

fn reserve_ref_with(rs: ReserveState, with_token: Bool) -> Input {
  Input {
    output_reference: r(9),
    output: Output {
      address: Address {
        payment_credential: Script(t_reserve),
        stake_credential: None,
      },
      value: if with_token {
        ada() |> assets.merge(thread_value(t_reserve))
      } else {
        ada()
      },
      datum: InlineDatum(rs),
      reference_script: None,
    },
  }
}

fn reserve_ref() -> Input {
  reserve_ref_with(t_reserve_state(False, [t_op1, t_op2]), True)
}

fn vtx(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: inputs,
    reference_inputs: [reserve_ref()],
    outputs: outputs,
    mint: mint,
    extra_signatories: signers,
    validity_range: interval.between(t_lo, t_hi),
  }
}

fn spend_state(s0: VaultState, rd: VaultRedeemer, tx: Transaction) -> Bool {
  stsra_vault.spend(t_seed(), t_reserve, Some(StateDatum(s0)), rd, r(0), tx)
}

// -- Genesis

fn genesis_tx(outputs: List<Output>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [Input { output_reference: t_seed(), output: pay(key_addr(t_op1), 0) }],
    outputs: outputs,
    mint: thread_value(t_own),
  }
}

fn boot(s: VaultState) -> Bool {
  stsra_vault.mint(t_seed(), t_reserve, Void, t_own, genesis_tx([state_out(s)]))
}

test good_genesis_is_accepted() {
  boot(t_vs(0, 0, 0, 0))
}

test genesis_with_short_shares_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), short_shares: 1 })
}

test genesis_with_short_assets_is_rejected() {
  !boot(t_vs(0, 10, 0, 0))
}

test genesis_with_long_shares_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), long_shares: 1 })
}

test genesis_with_long_assets_is_rejected() {
  !boot(t_vs(0, 0, 0, 10))
}

test genesis_with_a_different_loss_index_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), loss_index: loss_index_start - 1 })
}

test genesis_with_a_non_zero_epoch_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), epoch: 1 })
}

test genesis_with_weight_above_one_and_a_half_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), long_weight_bps: 15_001 })
}

test genesis_with_weight_below_one_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), long_weight_bps: 9_999 })
}

test genesis_with_cooldown_below_seven_days_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 7 * day - 1 })
}

test genesis_with_cooldown_above_fourteen_days_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 14 * day + 1 })
}

test genesis_with_lock_above_ninety_days_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), long_lock_ms: 90 * day + 1 })
}

test genesis_with_lock_shorter_than_cooldown_is_rejected() {
  !boot(
    VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 10 * day, long_lock_ms: 9 * day },
  )
}

test genesis_with_protocol_share_above_twenty_percent_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), protocol_bps: 2_001 })
}

test genesis_with_the_first_loss_address_at_the_vault_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), first_loss_addr: vault_addr() })
}

test genesis_with_the_treasury_at_the_vault_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), treasury_addr: vault_addr() })
}

test genesis_with_one_address_for_both_fees_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), treasury_addr: fl_addr() })
}

test genesis_token_sent_elsewhere_is_rejected() {
  let to_wallet =
    Output { ..pay(key_addr(t_op1), 0), value: ada() |> assets.merge(thread_value(t_own)) }
  !stsra_vault.mint(
    t_seed(),
    t_reserve,
    Void,
    t_own,
    genesis_tx([state_out_with(t_vs(0, 0, 0, 0), False), to_wallet]),
  )
}

test genesis_with_two_vault_outputs_is_rejected() {
  !stsra_vault.mint(
    t_seed(),
    t_reserve,
    Void,
    t_own,
    genesis_tx([state_out(t_vs(0, 0, 0, 0)), pos_out(Position(key_addr(t_alice), 1, 0))]),
  )
}

test genesis_state_holding_tsra_is_rejected() {
  let with_tsra =
    Output {
      ..state_out(t_vs(0, 0, 0, 0)),
      value: ada()
        |> assets.merge(thread_value(t_own))
        |> assets.merge(tsra(t_reserve, 5)),
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, genesis_tx([with_tsra]))
}

test genesis_state_holding_a_foreign_token_is_rejected() {
  let junk =
    Output {
      ..state_out(t_vs(0, 0, 0, 0)),
      value: ada()
        |> assets.merge(thread_value(t_own))
        |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "x", 1),
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, genesis_tx([junk]))
}

test genesis_without_the_seed_is_rejected() {
  let tx =
    Transaction {
      ..genesis_tx([state_out(t_vs(0, 0, 0, 0))]),
      inputs: [Input { output_reference: r(7), output: pay(key_addr(t_op1), 0) }],
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test genesis_cannot_spend_a_vault_input() {
  let tx =
    Transaction {
      ..genesis_tx([state_out(t_vs(0, 0, 0, 0))]),
      inputs: [
        Input { output_reference: t_seed(), output: pay(key_addr(t_op1), 0) },
        state_in(t_vs(0, 0, 0, 0)),
      ],
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test genesis_mints_exactly_one_state_token() {
  let tx =
    Transaction {
      ..genesis_tx([state_out(t_vs(0, 0, 0, 0))]),
      mint: assets.from_asset(t_own, thread_name, 2),
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test genesis_cannot_mint_stsra_at_the_same_time() {
  let tx =
    Transaction {
      ..genesis_tx([state_out(t_vs(0, 0, 0, 0))]),
      mint: thread_value(t_own) |> assets.merge(stsra(10)),
    }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test genesis_without_a_state_datum_is_rejected() {
  let no_datum = Output { ..state_out(t_vs(0, 0, 0, 0)), datum: NoDatum }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, genesis_tx([no_datum]))
}

// -- StakeShort

fn stake_short(s0: VaultState, amount: Int, minted: Int) -> Transaction {
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: s0.short_shares + minted,
      short_assets: s0.short_assets + amount,
    }
  vtx([state_in(s0)], [state_out(s1)], stsra(minted), [])
}

fn short(s0: VaultState, amount: Int, tx: Transaction) -> Bool {
  spend_state(s0, StakeShort { amount, holder: t_alice }, tx)
}

test first_short_stake_of_ten_tsra_is_accepted() {
  let s0 = t_vs(0, 0, 0, 0)
  short(s0, 10_000_000, stake_short(s0, 10_000_000, 10_000_000))
}

test first_short_stake_below_ten_tsra_is_rejected() {
  // first-depositor inflation: a tiny first stake cannot set the price
  let s0 = t_vs(0, 0, 0, 0)
  !short(s0, 9_999_999, stake_short(s0, 9_999_999, 9_999_999))
}

test short_stake_mints_at_the_current_price() {
  // price 1.08: 108 TSRA buys exactly 100 sTSRA
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  short(s0, 108_000_000, stake_short(s0, 108_000_000, 100_000_000))
}

test short_stake_rounds_shares_down() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  short(s0, 107_999_999, stake_short(s0, 107_999_999, 99_999_999)) && !short(
    s0,
    107_999_999,
    stake_short(s0, 107_999_999, 100_000_000),
  )
}

test short_stake_minting_one_extra_share_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx =
    Transaction { ..stake_short(s0, 108_000_000, 100_000_000), mint: stsra(100_000_001) }
  !short(s0, 108_000_000, tx)
}

test short_stake_without_the_tsra_arriving_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = stake_short(s0, 108_000_000, 100_000_000)
  expect [o] = tx.outputs
  let short_paid =
    Output {
      ..o,
      value: ada()
        |> assets.merge(thread_value(t_own))
        |> assets.merge(tsra(t_reserve, 215_999_999)),
    }
  !short(s0, 108_000_000, Transaction { ..tx, outputs: [short_paid] })
}

test short_stake_in_a_lookalike_token_is_rejected() {
  // "TSRA" under another policy is not TSRA
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = stake_short(s0, 108_000_000, 100_000_000)
  expect [o] = tx.outputs
  let fake =
    Output {
      ..o,
      value: ada()
        |> assets.merge(thread_value(t_own))
        |> assets.merge(tsra(t_reserve, 108_000_000))
        |> assets.merge(
            assets.from_asset(
              #"66666666666666666666666666666666666666666666666666666666",
              rules.tsra_name,
              108_000_000,
            ),
          ),
    }
  !short(s0, 108_000_000, Transaction { ..tx, outputs: [fake] })
}

test short_stake_with_kyc_on_and_no_eligibility_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx =
    Transaction {
      ..stake_short(s0, 10_000_000, 10_000_000),
      reference_inputs: [reserve_ref_with(t_reserve_state(True, [t_op1, t_op2]), True)],
      extra_signatories: [t_alice],
    }
  !short(s0, 10_000_000, tx)
}

test short_stake_with_kyc_on_and_eligibility_is_accepted() {
  let s0 = t_vs(0, 0, 0, 0)
  let token =
    Input {
      output_reference: r(8),
      output: Output {
        ..pay(key_addr(t_op1), 0),
        value: ada() |> assets.add(t_elig, t_alice, 1),
      },
    }
  let tx =
    Transaction {
      ..stake_short(s0, 10_000_000, 10_000_000),
      reference_inputs: [
        reserve_ref_with(t_reserve_state(True, [t_op1, t_op2]), True),
        token,
      ],
      extra_signatories: [t_alice],
    }
  short(s0, 10_000_000, tx)
}

test short_stake_without_the_reserve_state_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = Transaction { ..stake_short(s0, 10_000_000, 10_000_000), reference_inputs: [] }
  !short(s0, 10_000_000, tx)
}

test short_stake_against_a_planted_reserve_state_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx =
    Transaction {
      ..stake_short(s0, 10_000_000, 10_000_000),
      reference_inputs: [reserve_ref_with(t_reserve_state(False, [t_op1, t_op2]), False)],
    }
  !short(s0, 10_000_000, tx)
}

test short_stake_cannot_spend_another_vault_utxo() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  let extra =
    Input {
      output_reference: r(1),
      output: ticket_out(Ticket(key_addr(t_alice), 5_000_000, loss_index_start, 0)),
    }
  !short(s0, 10_000_000, Transaction { ..tx, inputs: [state_in(s0), extra] })
}

test short_stake_cannot_create_another_vault_utxo() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  let extra = pos_out(Position(key_addr(t_alice), 1, 0))
  !short(s0, 10_000_000, Transaction { ..tx, outputs: [extra, ..tx.outputs] })
}

// -- StakeLong

fn stake_long(s0: VaultState, amount: Int, minted: Int, unlock_at: Int) -> Transaction {
  let s1 =
    VaultState {
      ..bump(s0),
      long_shares: s0.long_shares + minted,
      long_assets: s0.long_assets + amount,
    }
  vtx(
    [state_in(s0)],
    [state_out(s1), pos_out(Position(key_addr(t_alice), minted, unlock_at))],
    marker(1),
    [],
  )
}

fn long(s0: VaultState, amount: Int, tx: Transaction) -> Bool {
  spend_state(s0, StakeLong { amount, holder: t_alice, owner: key_addr(t_alice) }, tx)
}

test first_long_stake_of_ten_tsra_is_accepted() {
  let s0 = t_vs(0, 0, 0, 0)
  long(s0, 10_000_000, stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day))
}

test first_long_stake_below_ten_tsra_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  !long(s0, 9_999_999, stake_long(s0, 9_999_999, 9_999_999, t_hi + 30 * day))
}

test long_position_below_two_tsra_is_rejected() {
  let s0 = t_vs(0, 0, 100_000_000, 100_000_000)
  !long(s0, 1_999_999, stake_long(s0, 1_999_999, 1_999_999, t_hi + 30 * day)) && long(
    s0,
    2_000_000,
    stake_long(s0, 2_000_000, 2_000_000, t_hi + 30 * day),
  )
}

test long_position_unlocking_early_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  !long(s0, 10_000_000, stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day - 1))
}

test long_position_with_the_wrong_shares_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  !long(s0, 10_000_000, stake_long(s0, 10_000_000, 10_000_001, t_hi + 30 * day))
}

test long_position_payable_to_someone_else_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  !spend_state(
    s0,
    StakeLong { amount: 10_000_000, holder: t_alice, owner: key_addr(t_bob) },
    tx,
  )
}

test long_position_without_a_marker_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  expect [st, pos] = tx.outputs
  let bare = Output { ..pos, value: ada() }
  !long(s0, 10_000_000, Transaction { ..tx, outputs: [st, bare] })
}

test long_position_holding_tsra_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  expect [st, pos] = tx.outputs
  let fat = Output { ..pos, value: pos.value |> assets.merge(tsra(t_reserve, 1)) }
  !long(s0, 10_000_000, Transaction { ..tx, outputs: [st, fat] })
}

test long_stake_minting_two_markers_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  !long(s0, 10_000_000, Transaction { ..tx, mint: marker(2) })
}

test long_stake_with_unbounded_validity_is_rejected() fail {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  long(s0, 10_000_000, Transaction { ..tx, validity_range: interval.after(t_lo) })
}

test long_stake_with_kyc_on_and_no_eligibility_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx =
    Transaction {
      ..stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day),
      reference_inputs: [reserve_ref_with(t_reserve_state(True, [t_op1, t_op2]), True)],
      extra_signatories: [t_alice],
    }
  !long(s0, 10_000_000, tx)
}

// -- RequestUnstake

fn unstake_tx(s0: VaultState, shares: Int, v: Int, t: Ticket) -> Transaction {
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: s0.short_shares - shares,
      short_assets: s0.short_assets - v,
    }
  vtx(
    [state_in(s0)],
    [state_out(s1), ticket_out(t)],
    marker(1) |> assets.merge(stsra(-shares)),
    [],
  )
}

fn t_ticket(v: Int) -> Ticket {
  Ticket {
    owner: key_addr(t_alice),
    value: v,
    index_at_request: loss_index_start,
    claim_after: t_hi + 7 * day,
  }
}

fn unstake(s0: VaultState, shares: Int, tx: Transaction) -> Bool {
  spend_state(s0, RequestUnstake { shares, owner: key_addr(t_alice) }, tx)
}

test unstake_escrows_the_request_time_value() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  unstake(s0, 50_000_000, unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000)))
}

test unstake_value_rounds_down() {
  // 10_000_001 * 100 / 30 = 33_333_336.67 -> 33_333_336
  let s0 = t_vs(30_000_000, 100_000_000, 0, 0)
  unstake(s0, 10_000_001, unstake_tx(s0, 10_000_001, 33_333_336, t_ticket(33_333_336))) && !unstake(
    s0,
    10_000_001,
    unstake_tx(s0, 10_000_001, 33_333_337, t_ticket(33_333_337)),
  )
}

test unstake_of_everything_takes_all_assets() {
  let s0 = t_vs(30_000_000, 100_000_000, 0, 0)
  unstake(s0, 30_000_000, unstake_tx(s0, 30_000_000, 100_000_000, t_ticket(100_000_000)))
}

test ticket_claimable_too_early_is_rejected() {
  // cooldown bypass: claim_after one ms short of hi + cooldown
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let t = Ticket { ..t_ticket(54_000_000), claim_after: t_hi + 7 * day - 1 }
  !unstake(s0, 50_000_000, unstake_tx(s0, 50_000_000, 54_000_000, t))
}

test ticket_with_a_stale_loss_index_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let t = Ticket { ..t_ticket(54_000_000), index_at_request: loss_index_start + 1 }
  !unstake(s0, 50_000_000, unstake_tx(s0, 50_000_000, 54_000_000, t))
}

test ticket_payable_to_someone_else_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let t = Ticket { ..t_ticket(54_000_000), owner: key_addr(t_bob) }
  !unstake(s0, 50_000_000, unstake_tx(s0, 50_000_000, 54_000_000, t))
}

test unstake_without_burning_the_shares_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  !unstake(s0, 50_000_000, Transaction { ..tx, mint: marker(1) })
}

test unstake_burning_too_few_shares_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  !unstake(
    s0,
    50_000_000,
    Transaction { ..tx, mint: marker(1) |> assets.merge(stsra(-49_999_999)) },
  )
}

test unstake_of_more_than_the_supply_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  !unstake(
    s0,
    100_000_001,
    unstake_tx(s0, 100_000_001, 108_000_000, t_ticket(108_000_000)),
  )
}

test unstake_of_zero_shares_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  !unstake(s0, 0, unstake_tx(s0, 0, 0, t_ticket(0)))
}

test ticket_below_two_tsra_is_rejected() {
  let s0 = t_vs(100_000_000, 100_000_000, 0, 0)
  !unstake(s0, 1_999_999, unstake_tx(s0, 1_999_999, 1_999_999, t_ticket(1_999_999)))
}

test ticket_short_of_its_tsra_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  expect [st, tk] = tx.outputs
  let thin =
    Output {
      ..tk,
      value: ada()
        |> assets.merge(marker_value(t_own))
        |> assets.merge(tsra(t_reserve, 53_999_999)),
    }
  !unstake(s0, 50_000_000, Transaction { ..tx, outputs: [st, thin] })
}

test ticket_without_a_marker_is_rejected() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  expect [st, tk] = tx.outputs
  let bare = Output { ..tk, value: ada() |> assets.merge(tsra(t_reserve, 54_000_000)) }
  !unstake(s0, 50_000_000, Transaction { ..tx, outputs: [st, bare] })
}

// -- Claim

fn vault_ref(s: VaultState) -> Input {
  Input { output_reference: r(6), output: state_out(s) }
}

fn ticket_in(t: Ticket) -> Input {
  Input { output_reference: r(1), output: ticket_out(t) }
}

fn claim_tx(t: Ticket, index_now: Int, outputs: List<Output>, mint: Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [ticket_in(t)],
    reference_inputs: [vault_ref(VaultState { ..t_vs(1, 1, 0, 0), loss_index: index_now })],
    outputs: outputs,
    mint: mint,
    validity_range: interval.between(t.claim_after, t.claim_after + 1_000),
  }
}

fn claim_ok(t: Ticket, tx: Transaction) -> Bool {
  stsra_vault.spend(t_seed(), t_reserve, Some(TicketDatum(t)), Claim, r(1), tx)
}

test claim_after_the_cooldown_pays_the_owner() {
  let t = t_ticket(54_000_000)
  claim_ok(t, claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1)))
}

test claim_before_the_cooldown_is_rejected() {
  let t = t_ticket(54_000_000)
  let tx = claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1))
  !claim_ok(
    t,
    Transaction {
      ..tx,
      validity_range: interval.between(t.claim_after - 1, t.claim_after + 1_000),
    },
  )
}

test claim_paying_someone_else_is_rejected() {
  let t = t_ticket(54_000_000)
  !claim_ok(t, claim_tx(t, loss_index_start, [pay(key_addr(t_bob), 54_000_000)], marker(-1)))
}

test claim_paying_the_owner_short_is_rejected() {
  let t = t_ticket(54_000_000)
  !claim_ok(t, claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 53_999_999)], marker(-1)))
}

test claim_without_burning_the_marker_is_rejected() {
  let t = t_ticket(54_000_000)
  !claim_ok(t, claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], assets.zero))
}

test claim_cannot_recreate_the_ticket() {
  // replay: the claim may not leave anything behind at the vault
  let t = t_ticket(54_000_000)
  let tx =
    claim_tx(
      t,
      loss_index_start,
      [pay(key_addr(t_alice), 54_000_000), ticket_out(t)],
      marker(-1),
    )
  !claim_ok(t, tx)
}

test a_planted_ticket_cannot_be_claimed() {
  let t = t_ticket(54_000_000)
  let planted =
    Input {
      output_reference: r(1),
      output: Output { ..ticket_out(t), value: ada() |> assets.merge(tsra(t_reserve, 54_000_000)) },
    }
  let tx =
    Transaction {
      ..claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1)),
      inputs: [planted],
    }
  !claim_ok(t, tx)
}

test two_tickets_cannot_share_one_payout() {
  // double satisfaction: both tickets pay alice; one output may not serve both
  let t = t_ticket(54_000_000)
  let second = Input { output_reference: r(2), output: ticket_out(t) }
  let tx =
    Transaction {
      ..claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-2)),
      inputs: [ticket_in(t), second],
    }
  !claim_ok(t, tx)
}

test claim_against_a_planted_vault_state_is_rejected() fail {
  let t = t_ticket(54_000_000)
  let planted =
    Input {
      output_reference: r(6),
      output: state_out_with(VaultState { ..t_vs(1, 1, 0, 0), loss_index: loss_index_start * 2 }, False),
    }
  let tx =
    Transaction {
      ..claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1)),
      reference_inputs: [planted],
    }
  claim_ok(t, tx)
}

test claim_after_a_loss_pays_the_lower_value_and_burns_the_rest() {
  // index halved during cooldown: owner gets 27, the other 27 TSRA is burned
  let t = t_ticket(54_000_000)
  let mint = marker(-1) |> assets.merge(tsra(t_reserve, -27_000_000))
  claim_ok(
    t,
    claim_tx(t, loss_index_start / 2, [pay(key_addr(t_alice), 27_000_000)], mint),
  )
}

test claim_after_a_loss_must_burn_the_excess() {
  let t = t_ticket(54_000_000)
  !claim_ok(
    t,
    claim_tx(t, loss_index_start / 2, [pay(key_addr(t_alice), 27_000_000)], marker(-1)),
  )
}

test claim_after_a_loss_cannot_pay_the_request_time_value() {
  // escaping the loss: pay 54 and burn nothing
  let t = t_ticket(54_000_000)
  !claim_ok(
    t,
    claim_tx(t, loss_index_start / 2, [pay(key_addr(t_alice), 54_000_000)], marker(-1)),
  )
}

test claim_never_pays_more_than_the_escrow() {
  // a higher index (cannot happen; ReportLoss only lowers it) is capped
  let t = t_ticket(54_000_000)
  claim_ok(t, claim_tx(t, loss_index_start * 2, [pay(key_addr(t_alice), 54_000_000)], marker(-1)))
}

test the_marker_burn_of_a_claim_passes_the_policy() {
  let t = t_ticket(54_000_000)
  stsra_vault.mint(
    t_seed(),
    t_reserve,
    Void,
    t_own,
    claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1)),
  )
}

// -- UnlockLong

fn t_pos(shares: Int) -> Position {
  Position { owner: key_addr(t_alice), shares, unlock_at: 1_500_000 }
}

fn pos_in(p: Position) -> Input {
  Input { output_reference: r(1), output: pos_out(p) }
}

fn unlock_tx(s0: VaultState, p: Position, payout: Int, to: Address) -> Transaction {
  let s1 =
    VaultState {
      ..bump(s0),
      long_shares: s0.long_shares - p.shares,
      long_assets: s0.long_assets - payout,
    }
  Transaction {
    ..vtx([state_in(s0), pos_in(p)], [state_out(s1), pay(to, payout)], marker(-1), [t_alice]),
    validity_range: interval.between(p.unlock_at, p.unlock_at + 1_000),
  }
}

test unlock_after_the_lock_pays_the_long_price() {
  // class L price 1.25: 40 shares pay 50 TSRA
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  spend_state(s0, UnlockLong, unlock_tx(s0, t_pos(40_000_000), 50_000_000, key_addr(t_alice)))
}

test unlock_before_the_lock_ends_is_rejected() {
  // early unstake
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let p = t_pos(40_000_000)
  let tx = unlock_tx(s0, p, 50_000_000, key_addr(t_alice))
  !spend_state(
    s0,
    UnlockLong,
    Transaction { ..tx, validity_range: interval.between(p.unlock_at - 1, p.unlock_at + 1_000) },
  )
}

test unlock_paying_someone_else_is_rejected() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  !spend_state(s0, UnlockLong, unlock_tx(s0, t_pos(40_000_000), 50_000_000, key_addr(t_bob)))
}

test unlock_overpaying_from_the_pool_is_rejected() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  !spend_state(s0, UnlockLong, unlock_tx(s0, t_pos(40_000_000), 50_000_001, key_addr(t_alice)))
}

test unlock_without_burning_the_marker_is_rejected() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let tx = unlock_tx(s0, t_pos(40_000_000), 50_000_000, key_addr(t_alice))
  !spend_state(s0, UnlockLong, Transaction { ..tx, mint: assets.zero })
}

test a_planted_position_cannot_be_unlocked() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let p = t_pos(40_000_000)
  let tx = unlock_tx(s0, p, 50_000_000, key_addr(t_alice))
  let planted = Input { output_reference: r(1), output: Output { ..pos_out(p), value: ada() } }
  let tx = Transaction { ..tx, inputs: [state_in(s0), planted] }
  !spend_state(s0, UnlockLong, tx) && !stsra_vault.spend(
    t_seed(),
    t_reserve,
    Some(PositionDatum(p)),
    UnlockLong,
    r(1),
    tx,
  )
}

test two_positions_cannot_unlock_together() fail {
  // double satisfaction: one payout output may not serve two Positions
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let p = t_pos(40_000_000)
  let tx = unlock_tx(s0, p, 50_000_000, key_addr(t_alice))
  let second = Input { output_reference: r(2), output: pos_out(p) }
  spend_state(s0, UnlockLong, Transaction { ..tx, inputs: [state_in(s0), pos_in(p), second] })
}

test unlocking_the_last_position_takes_all_long_assets() {
  let s0 = t_vs(0, 0, 40_000_000, 50_000_001)
  spend_state(s0, UnlockLong, unlock_tx(s0, t_pos(40_000_000), 50_000_001, key_addr(t_alice)))
}

test a_position_is_spendable_only_beside_the_genuine_state() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let p = t_pos(40_000_000)
  let with_state = unlock_tx(s0, p, 50_000_000, key_addr(t_alice))
  let alone = Transaction { ..with_state, inputs: [pos_in(p)] }
  stsra_vault.spend(t_seed(), t_reserve, Some(PositionDatum(p)), UnlockLong, r(1), with_state) && !stsra_vault.spend(
    t_seed(),
    t_reserve,
    Some(PositionDatum(p)),
    UnlockLong,
    r(1),
    alone,
  )
}

// -- ReportYield

fn yield_s0() -> VaultState {
  t_vs(100_000_000, 100_000_000, 100_000_000, 100_000_000)
}

/// gross 10 TSRA, 12.5% cut (0.625 + 0.625), net 8.75 split 1 : 1.25 by assets.
fn yield_tx(y_short: Int, y_long: Int, fl: Int, tr: Int, signers: List<ByteArray>) -> Transaction {
  let s0 = yield_s0()
  let s1 = vesting(s0, y_short, y_long)
  vtx([state_in(s0)], [state_out(s1), pay(fl_addr(), fl), pay(tr_addr(), tr)], assets.zero, signers)
}

/// The State after a ReportYield at `t_lo` into a vault with nothing vesting:
/// the yield waits in `vest_*` for 7 days from `t_lo` (H2.1).
fn vesting(s0: VaultState, y_short: Int, y_long: Int) -> VaultState {
  VaultState {
    ..bump(s0),
    vest_short: y_short,
    vest_long: y_long,
    vest_from: t_lo,
    vest_until: t_lo + vest_period_ms,
  }
}

fn report(tx: Transaction) -> Bool {
  spend_state(yield_s0(), ReportYield { gross: 10_000_000 }, tx)
}

test report_yield_splits_by_weight_and_pays_the_fees() {
  // y_long = 8_750_000 * 1.25 / 2.25 = 4_861_111 (floor), y_short = 3_888_889
  report(yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2]))
}

test report_yield_needs_the_committee() {
  !report(yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1]))
}

test report_yield_follows_a_reserve_rotation() {
  let rotated = reserve_ref_with(t_reserve_state(False, [t_op2, t_op3]), True)
  let old = Transaction { ..yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2]), reference_inputs: [rotated] }
  let fresh = Transaction { ..old, extra_signatories: [t_op2, t_op3] }
  !report(old) && report(fresh)
}

test report_yield_crediting_more_than_net_is_rejected() {
  // yield reported without funds: the datum claims more than arrived
  !report(yield_tx(3_888_890, 4_861_111, 625_000, 625_000, [t_op1, t_op2]))
}

test report_yield_without_the_tsra_arriving_is_rejected() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  expect [st, fl, tr] = tx.outputs
  let thin = Output { ..st, value: st.value |> assets.merge(tsra(t_reserve, -1)) }
  !report(Transaction { ..tx, outputs: [thin, fl, tr] })
}

test report_yield_with_the_wrong_tier_split_is_rejected() {
  // the long tier taking the short tier's rounding unit
  !report(yield_tx(3_888_888, 4_861_112, 625_000, 625_000, [t_op1, t_op2]))
}

test report_yield_with_an_unweighted_split_is_rejected() {
  !report(yield_tx(4_375_000, 4_375_000, 625_000, 625_000, [t_op1, t_op2]))
}

test report_yield_short_paying_the_first_loss_reserve_is_rejected() {
  !report(yield_tx(3_888_889, 4_861_111, 624_999, 625_000, [t_op1, t_op2]))
}

test report_yield_short_paying_the_treasury_is_rejected() {
  !report(yield_tx(3_888_889, 4_861_111, 625_000, 624_999, [t_op1, t_op2]))
}

test report_yield_keeping_the_cut_in_the_pool_is_rejected() {
  // fee above cap in effect: crediting stakers with the protocol's share
  let tx = yield_tx(4_444_445, 5_555_555, 0, 0, [t_op1, t_op2])
  !report(tx)
}

test report_yield_into_an_empty_vault_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = vtx([state_in(s0)], [state_out(bump(s0))], assets.zero, [t_op1, t_op2])
  !spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

test report_yield_of_zero_is_rejected() {
  let s0 = yield_s0()
  let tx = vtx([state_in(s0)], [state_out(bump(s0))], assets.zero, [t_op1, t_op2])
  !spend_state(s0, ReportYield { gross: 0 }, tx)
}

test report_yield_cannot_change_shares() {
  let s0 = yield_s0()
  let s1 =
    VaultState { ..vesting(s0, 3_888_889, 4_861_111), short_shares: s0.short_shares + 1 }
  let tx =
    vtx(
      [state_in(s0)],
      [state_out(s1), pay(fl_addr(), 625_000), pay(tr_addr(), 625_000)],
      assets.zero,
      [t_op1, t_op2],
    )
  !report(tx)
}

test report_yield_cannot_mint_stsra() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, mint: stsra(1) })
}

test report_yield_on_a_short_only_vault_credits_the_short_tier() {
  let s0 = t_vs(100_000_000, 100_000_000, 0, 0)
  let s1 = vesting(s0, 8_750_000, 0)
  let tx =
    vtx(
      [state_in(s0)],
      [state_out(s1), pay(fl_addr(), 625_000), pay(tr_addr(), 625_000)],
      assets.zero,
      [t_op1, t_op2],
    )
  spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

// -- SetBounds

fn bounds_tx(s0: VaultState, s1: VaultState, signers: List<ByteArray>) -> Transaction {
  vtx([state_in(s0)], [state_out(s1)], assets.zero, signers)
}

fn set_bounds(s0: VaultState, s1: VaultState, w: Int, c: Int, l: Int, p: Int, signers: List<ByteArray>) -> Bool {
  spend_state(
    s0,
    SetBounds { long_weight_bps: w, short_cooldown_ms: c, long_lock_ms: l, protocol_bps: p },
    bounds_tx(s0, s1, signers),
  )
}

fn bounded(s0: VaultState, w: Int, c: Int, l: Int, p: Int) -> VaultState {
  VaultState {
    ..bump(s0),
    long_weight_bps: w,
    short_cooldown_ms: c,
    long_lock_ms: l,
    protocol_bps: p,
  }
}

test set_bounds_by_the_committee_is_accepted() {
  let s0 = yield_s0()
  set_bounds(s0, bounded(s0, 15_000, 14 * day, 90 * day, 2_000), 15_000, 14 * day, 90 * day, 2_000, [t_op1, t_op2])
}

test set_bounds_needs_the_committee() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), 13_000, 7 * day, 30 * day, 1_250, [t_op1])
}

test set_bounds_weighting_above_the_cap_is_rejected() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 15_001, 7 * day, 30 * day, 1_250), 15_001, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

test set_bounds_fee_above_the_cap_is_rejected() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 12_500, 7 * day, 30 * day, 2_001), 12_500, 7 * day, 30 * day, 2_001, [t_op1, t_op2])
}

test set_bounds_cooldown_outside_seven_to_fourteen_days_is_rejected() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 12_500, 7 * day - 1, 30 * day, 1_250), 12_500, 7 * day - 1, 30 * day, 1_250, [t_op1, t_op2]) && !set_bounds(
    s0,
    bounded(s0, 12_500, 14 * day + 1, 30 * day, 1_250),
    12_500,
    14 * day + 1,
    30 * day,
    1_250,
    [t_op1, t_op2],
  )
}

test set_bounds_lock_above_ninety_days_is_rejected() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 12_500, 7 * day, 90 * day + 1, 1_250), 12_500, 7 * day, 90 * day + 1, 1_250, [t_op1, t_op2])
}

test set_bounds_cannot_touch_the_balances() {
  let s0 = yield_s0()
  let s1 = VaultState { ..bounded(s0, 13_000, 7 * day, 30 * day, 1_250), short_assets: 1 }
  !set_bounds(s0, s1, 13_000, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

test set_bounds_cannot_touch_the_fee_addresses() {
  let s0 = yield_s0()
  let s1 = VaultState { ..bounded(s0, 13_000, 7 * day, 30 * day, 1_250), treasury_addr: key_addr(t_bob) }
  !set_bounds(s0, s1, 13_000, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

test set_bounds_datum_must_match_the_redeemer() {
  let s0 = yield_s0()
  !set_bounds(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), 14_000, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

test set_bounds_must_bump_the_epoch() {
  let s0 = yield_s0()
  let s1 = VaultState { ..bounded(s0, 13_000, 7 * day, 30 * day, 1_250), epoch: s0.epoch }
  !set_bounds(s0, s1, 13_000, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

test set_bounds_cannot_change_the_loss_index() {
  // only ReportLoss (2.5) may lower prices
  let s0 = yield_s0()
  let s1 = VaultState { ..bounded(s0, 13_000, 7 * day, 30 * day, 1_250), loss_index: 1 }
  !set_bounds(s0, s1, 13_000, 7 * day, 30 * day, 1_250, [t_op1, t_op2])
}

// -- Identity

test a_planted_state_cannot_be_spent() fail {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  let planted = Input { output_reference: r(0), output: state_out_with(s0, False) }
  short(s0, 10_000_000, Transaction { ..tx, inputs: [planted] })
}

test two_genuine_states_cannot_be_spent_together() fail {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  let second = Input { output_reference: r(1), output: state_out(s0) }
  short(s0, 10_000_000, Transaction { ..tx, inputs: [state_in(s0), second] })
}

test the_state_may_not_carry_a_foreign_token() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  expect [o] = tx.outputs
  let junk = Output { ..o, value: o.value |> assets.add(#"44444444444444444444444444444444444444444444444444444444", "x", 1) }
  !short(s0, 10_000_000, Transaction { ..tx, outputs: [junk] })
}

test a_spent_lookalike_beside_the_state_is_rejected() {
  // the spent input must BE the genuine State
  let s0 = t_vs(0, 0, 0, 0)
  let evil = VaultState { ..s0, protocol_bps: 0 }
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  !short(evil, 10_000_000, tx)
}

test stsra_cannot_be_minted_without_the_state() {
  let tx = Transaction { ..transaction.placeholder, mint: stsra(1_000) }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test stsra_cannot_be_minted_beside_a_planted_state() {
  let planted = Input { output_reference: r(0), output: state_out_with(t_vs(0, 0, 0, 0), False) }
  let tx = Transaction { ..transaction.placeholder, inputs: [planted], mint: stsra(1_000) }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test a_marker_cannot_be_minted_without_the_state() {
  let tx = Transaction { ..transaction.placeholder, mint: marker(1) }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test the_state_token_can_never_be_burned() {
  let tx = Transaction { ..transaction.placeholder, inputs: [state_in(t_vs(0, 0, 0, 0))], mint: assets.from_asset(t_own, thread_name, -1) }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test the_policy_accepts_stsra_with_the_genuine_state() {
  let s0 = t_vs(0, 0, 0, 0)
  stsra_vault.mint(t_seed(), t_reserve, Void, t_own, stake_short(s0, 10_000_000, 10_000_000))
}

test burning_stsra_with_a_marker_burn_still_needs_the_state() {
  // the marker-burn shortcut must not cover sTSRA
  let tx = Transaction { ..transaction.placeholder, mint: marker(-1) |> assets.merge(stsra(-5)) }
  !stsra_vault.mint(t_seed(), t_reserve, Void, t_own, tx)
}

test the_state_branch_refuses_a_claim_redeemer() {
  let s0 = t_vs(0, 0, 0, 0)
  !spend_state(s0, Claim, stake_short(s0, 10_000_000, 10_000_000))
}

test ticket_records_the_current_loss_index_not_the_starting_one() {
  // after a loss the State's index is below the start; the Ticket takes it
  let s0 = VaultState { ..t_vs(100_000_000, 108_000_000, 0, 0), loss_index: loss_index_start / 2 }
  let t = Ticket { ..t_ticket(54_000_000), index_at_request: loss_index_start / 2 }
  unstake(s0, 50_000_000, unstake_tx(s0, 50_000_000, 54_000_000, t)) && !unstake(
    s0,
    50_000_000,
    unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000)),
  )
}

test a_state_holding_two_tokens_is_not_genuine() fail {
  // cannot happen on chain (one-shot, quantity 1); pins the rule
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  let doubled =
    Input {
      output_reference: r(0),
      output: Output {
        ..state_out(s0),
        value: state_out(s0).value |> assets.merge(thread_value(t_own)),
      },
    }
  short(s0, 10_000_000, Transaction { ..tx, inputs: [doubled] })
}

test report_yield_without_the_reserve_state_is_rejected() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, reference_inputs: [] })
}

test report_yield_against_a_planted_reserve_state_is_rejected() {
  // an attacker's own committee in a State-shaped UTxO without the token
  let planted = reserve_ref_with(t_reserve_state(False, [t_bob, t_alice]), False)
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_bob, t_alice])
  !report(Transaction { ..tx, reference_inputs: [planted] })
}

test set_bounds_without_the_reserve_state_is_rejected() {
  let s0 = yield_s0()
  let tx = bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2])
  !spend_state(
    s0,
    SetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 30 * day, protocol_bps: 1_250 },
    Transaction { ..tx, reference_inputs: [] },
  )
}

test short_stake_datum_shares_must_match_the_mint() {
  // mint is right (10), but the datum books 11 shares
  let s0 = t_vs(0, 0, 0, 0)
  let s1 = VaultState { ..bump(s0), short_shares: 10_000_001, short_assets: 10_000_000 }
  let tx = vtx([state_in(s0)], [state_out(s1)], stsra(10_000_000), [])
  !short(s0, 10_000_000, tx)
}

test short_stake_cannot_change_a_bound() {
  let s0 = t_vs(0, 0, 0, 0)
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 10_000_000,
      short_assets: 10_000_000,
      protocol_bps: 0,
    }
  !short(s0, 10_000_000, vtx([state_in(s0)], [state_out(s1)], stsra(10_000_000), []))
}

test short_stake_must_bump_the_epoch() {
  let s0 = t_vs(0, 0, 0, 0)
  let s1 = VaultState { ..s0, short_shares: 10_000_000, short_assets: 10_000_000 }
  !short(s0, 10_000_000, vtx([state_in(s0)], [state_out(s1)], stsra(10_000_000), []))
}

test long_stake_cannot_spend_an_existing_position() {
  // would let the old Position's marker leave the vault
  let s0 = t_vs(0, 0, 100_000_000, 100_000_000)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  let old = Input { output_reference: r(1), output: pos_out(t_pos(40_000_000)) }
  !long(s0, 10_000_000, Transaction { ..tx, inputs: [state_in(s0), old] })
}

test long_stake_datum_must_match() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  expect [_, pos] = tx.outputs
  let s1 = VaultState { ..bump(s0), long_shares: 10_000_000, long_assets: 10_000_000, epoch: 0 }
  !long(s0, 10_000_000, Transaction { ..tx, outputs: [state_out(s1), pos] })
}

// -- Mutation-pass gaps (2.4): a guard existed, no test pinned it

fn some_position() -> Input {
  Input { output_reference: r(1), output: pos_out(t_pos(40_000_000)) }
}

fn junk_vault_output() -> Output {
  Output { ..pay(vault_addr(), 0), datum: NoDatum }
}

// RequestUnstake

test unstake_cannot_spend_an_existing_position() {
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  !unstake(s0, 50_000_000, Transaction { ..tx, inputs: [state_in(s0), some_position()] })
}

test unstake_datum_must_match() {
  // ticket and mint right, but the datum books the wrong short supply
  let s0 = t_vs(100_000_000, 108_000_000, 0, 0)
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  expect [_, tk] = tx.outputs
  let s1 = VaultState { ..bump(s0), short_shares: 50_000_001, short_assets: 54_000_000 }
  !unstake(s0, 50_000_000, Transaction { ..tx, outputs: [state_out(s1), tk] })
}

// StakeLong (datum)

test long_stake_datum_long_shares_must_match() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_long(s0, 10_000_000, 10_000_000, t_hi + 30 * day)
  expect [_, pos] = tx.outputs
  let s1 = VaultState { ..bump(s0), long_shares: 9_999_999, long_assets: 10_000_000 }
  !long(s0, 10_000_000, Transaction { ..tx, outputs: [state_out(s1), pos] })
}

// UnlockLong

test unlock_cannot_create_another_vault_output() {
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let tx = unlock_tx(s0, t_pos(40_000_000), 50_000_000, key_addr(t_alice))
  !spend_state(s0, UnlockLong, Transaction { ..tx, outputs: [junk_vault_output(), ..tx.outputs] })
}

// ReportYield

test report_yield_cannot_spend_a_position() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, inputs: [state_in(yield_s0()), some_position()] })
}

test report_yield_cannot_create_another_vault_output() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, outputs: [junk_vault_output(), ..tx.outputs] })
}

// SetBounds

fn bounds_rd() -> VaultRedeemer {
  SetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 30 * day, protocol_bps: 1_250 }
}

fn bounds_ok_tx() -> Transaction {
  let s0 = yield_s0()
  bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2])
}

test set_bounds_fixture_is_accepted() {
  spend_state(yield_s0(), bounds_rd(), bounds_ok_tx())
}

test set_bounds_cannot_spend_a_position() {
  let tx = bounds_ok_tx()
  !spend_state(yield_s0(), bounds_rd(), Transaction { ..tx, inputs: [state_in(yield_s0()), some_position()] })
}

test set_bounds_cannot_create_another_vault_output() {
  let tx = bounds_ok_tx()
  !spend_state(yield_s0(), bounds_rd(), Transaction { ..tx, outputs: [junk_vault_output(), ..tx.outputs] })
}

test set_bounds_cannot_mint_stsra() {
  // unbacked sTSRA would dilute every staker
  let tx = bounds_ok_tx()
  !spend_state(yield_s0(), bounds_rd(), Transaction { ..tx, mint: stsra(1_000_000) })
}

test report_yield_against_a_reserve_state_off_the_reserve_address_is_rejected() {
  // the genuine token and committee, but not at the reserve address
  let moved =
    Input {
      ..reserve_ref(),
      output: Output { ..reserve_ref().output, address: key_addr(t_bob) },
    }
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, reference_inputs: [moved] })
}

// -- Phase 2-H helpers

fn map_out(tx: Transaction, i: Int, f: fn(Output) -> Output) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.indexed_map(
      tx.outputs,
      fn(j, o) {
        if j == i {
          f(o)
        } else {
          o
        }
      },
    ),
  }
}

fn staked(o: Output) -> Output {
  Output {
    ..o,
    address: Address {
      ..o.address,
      stake_credential: Some(address.Inline(VerificationKey(t_bob))),
    },
  }
}

fn with_ref_script(o: Output) -> Output {
  Output { ..o, reference_script: Some(t_bob) }
}

fn lovelace_delta(o: Output, d: Int) -> Output {
  Output { ..o, value: assets.add(o.value, "", "", d) }
}

fn at(tx: Transaction, lo: Int, hi: Int) -> Transaction {
  Transaction { ..tx, validity_range: interval.between(lo, hi) }
}

fn long_ok_tx() -> Transaction {
  stake_long(t_vs(0, 0, 0, 0), 10_000_000, 10_000_000, t_hi + 30 * day)
}

fn long_ok(tx: Transaction) -> Bool {
  long(t_vs(0, 0, 0, 0), 10_000_000, tx)
}

fn unstake_ok_s0() -> VaultState {
  t_vs(100_000_000, 108_000_000, 0, 0)
}

fn unstake_ok_tx() -> Transaction {
  unstake_tx(unstake_ok_s0(), 50_000_000, 54_000_000, t_ticket(54_000_000))
}

fn unstake_ok(tx: Transaction) -> Bool {
  unstake(unstake_ok_s0(), 50_000_000, tx)
}

fn bounds_ok_with(tx: Transaction) -> Bool {
  spend_state(yield_s0(), bounds_rd(), tx)
}

// -- F-6: continuing and new vault outputs keep the State's address, carry
// no reference script, and the State never loses lovelace

test f6_fixtures_are_accepted() {
  bounds_ok_with(bounds_ok_tx()) && long_ok(long_ok_tx()) && unstake_ok(unstake_ok_tx())
}

test f6_state_under_a_foreign_stake_credential_is_rejected() {
  !bounds_ok_with(map_out(bounds_ok_tx(), 0, staked))
}

test f6_state_with_a_reference_script_is_rejected() {
  !bounds_ok_with(map_out(bounds_ok_tx(), 0, with_ref_script))
}

test f6_state_losing_lovelace_is_rejected() {
  !bounds_ok_with(map_out(bounds_ok_tx(), 0, fn(o) { lovelace_delta(o, -1) }))
}

test f6_state_may_gain_lovelace() {
  bounds_ok_with(map_out(bounds_ok_tx(), 0, fn(o) { lovelace_delta(o, 1_000_000) }))
}

test f6_position_under_a_foreign_stake_credential_is_rejected() {
  !long_ok(map_out(long_ok_tx(), 1, staked))
}

test f6_position_with_a_reference_script_is_rejected() {
  !long_ok(map_out(long_ok_tx(), 1, with_ref_script))
}

test f6_ticket_under_a_foreign_stake_credential_is_rejected() {
  !unstake_ok(map_out(unstake_ok_tx(), 1, staked))
}

test f6_ticket_with_a_reference_script_is_rejected() {
  !unstake_ok(map_out(unstake_ok_tx(), 1, with_ref_script))
}

test f6_genesis_under_a_stake_credential_is_rejected() {
  !stsra_vault.mint(
    t_seed(),
    t_reserve,
    Void,
    t_own,
    genesis_tx([staked(state_out(t_vs(0, 0, 0, 0)))]),
  )
}

test f6_genesis_with_a_reference_script_is_rejected() {
  !stsra_vault.mint(
    t_seed(),
    t_reserve,
    Void,
    t_own,
    genesis_tx([with_ref_script(state_out(t_vs(0, 0, 0, 0)))]),
  )
}

test genesis_with_a_vesting_balance_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), vest_short: 1 }) && !boot(
    VaultState { ..t_vs(0, 0, 0, 0), vest_long: 1 },
  ) && !boot(VaultState { ..t_vs(0, 0, 0, 0), vest_from: 1, vest_until: 1 }) && !boot(
    VaultState { ..t_vs(0, 0, 0, 0), vest_until: 1 },
  )
}

// -- H2.1: yield vests over 7 days; stakes price at hi, exits at lo

/// Half-way and four-sevenths through a vest that started at 0.
const half: Int = 302_400_000

const four_sevenths: Int = 345_600_000

/// 7 TSRA vesting into each class, from 0 to 7 days.
fn vesting_s0() -> VaultState {
  VaultState {
    ..t_vs(100_000_000, 100_000_000, 100_000_000, 125_000_000),
    vest_short: 7_000_000,
    vest_long: 7_000_000,
    vest_from: 0,
    vest_until: vest_period_ms,
  }
}

/// `vesting_s0` booked at `half`: 3.5 TSRA of each class has vested.
fn vesting_half() -> VaultState {
  VaultState {
    ..vesting_s0(),
    short_assets: 103_500_000,
    long_assets: 128_500_000,
    vest_short: 3_500_000,
    vest_long: 3_500_000,
    vest_from: half,
  }
}

test vesting_fold_matches_the_hand_computed_state() {
  fold(vesting_s0(), half) == vesting_half()
}

test vesting_stake_prices_at_the_upper_bound() {
  // price at hi: 103.5 + 0.5 vested by 4/7 = 104 TSRA per 100 sTSRA
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      short_shares: 200_000_000,
      short_assets: 207_500_000,
      epoch: 1,
    }
  let tx = at(vtx([state_in(s0)], [state_out(s1)], stsra(100_000_000), []), half, four_sevenths)
  short(s0, 104_000_000, tx)
}

test vesting_stake_at_the_lower_bound_price_is_rejected() {
  // 104 TSRA at the lo price (103.5) would mint 100_483_091 sTSRA
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      short_shares: 200_483_091,
      short_assets: 207_500_000,
      epoch: 1,
    }
  let tx = at(vtx([state_in(s0)], [state_out(s1)], stsra(100_483_091), []), half, four_sevenths)
  !short(s0, 104_000_000, tx)
}

test vesting_a_far_future_upper_bound_only_costs_the_staker() {
  // hi = 10 weeks: the staker pays the fully vested price (107)...
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      short_shares: 200_000_000,
      short_assets: 210_500_000,
      epoch: 1,
    }
  let tx = at(vtx([state_in(s0)], [state_out(s1)], stsra(100_000_000), []), half, 10 * vest_period_ms)
  short(s0, 107_000_000, tx)
}

test vesting_a_far_future_upper_bound_cannot_book_the_vest_early() {
  // ...but the book still only folds at lo: booking everything at hi (which
  // would let the next exit take the whole week's yield now) is rejected
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..s0,
      short_shares: 200_000_000,
      short_assets: 214_000_000,
      long_assets: 132_000_000,
      vest_short: 0,
      vest_long: 0,
      vest_from: vest_period_ms,
      epoch: 1,
    }
  let tx = at(vtx([state_in(s0)], [state_out(s1)], stsra(100_000_000), []), half, 10 * vest_period_ms)
  !short(s0, 107_000_000, tx)
}

fn vesting_unstake(v: Int) -> Bool {
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      short_shares: 50_000_000,
      short_assets: 103_500_000 - v,
      epoch: 1,
    }
  let t =
    Ticket {
      owner: key_addr(t_alice),
      value: v,
      index_at_request: loss_index_start,
      claim_after: four_sevenths + 7 * day,
    }
  let tx =
    at(
      vtx(
        [state_in(s0)],
        [state_out(s1), ticket_out(t)],
        marker(1) |> assets.merge(stsra(-50_000_000)),
        [],
      ),
      half,
      four_sevenths,
    )
  unstake(s0, 50_000_000, tx)
}

test vesting_unstake_prices_at_the_lower_bound() {
  // half of 103.5 booked at lo
  vesting_unstake(51_750_000)
}

test vesting_unstake_at_the_upper_bound_price_is_rejected() {
  // half of 104 (the hi price)
  !vesting_unstake(52_000_000)
}

fn vesting_unlock(payout: Int) -> Bool {
  let s0 = vesting_s0()
  let p = t_pos(40_000_000)
  let s1 =
    VaultState {
      ..vesting_half(),
      long_shares: 60_000_000,
      long_assets: 128_500_000 - payout,
      epoch: 1,
    }
  let tx =
    at(
      vtx(
        [state_in(s0), pos_in(p)],
        [state_out(s1), pay(key_addr(t_alice), payout)],
        marker(-1),
        [t_alice],
      ),
      half,
      half + 1_000,
    )
  spend_state(s0, UnlockLong, tx)
}

test vesting_unlock_prices_at_the_lower_bound() {
  // 40% of 128.5 booked at lo
  vesting_unlock(51_400_000)
}

test vesting_unlock_at_the_upper_bound_price_is_rejected() {
  // 40% of 128_500_011 (11 more vested by hi)
  !vesting_unlock(51_400_004)
}

fn vesting_report(s1: VaultState, lo: Int, hi: Int) -> Bool {
  let s0 = vesting_s0()
  let tx =
    at(
      vtx(
        [state_in(s0)],
        [state_out(s1), pay(fl_addr(), 625_000), pay(tr_addr(), 625_000)],
        assets.zero,
        [t_op1, t_op2],
      ),
      lo,
      hi,
    )
  spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

/// Report 10 TSRA at `half`: weights 107 (short) : 132 x 1.25 (long), so
/// y_long = 8_750_000 * 165 / 272 = 5_307_904 and y_short = 3_442_096. The
/// 3.5 TSRA per class still vesting rolls into a new week from `half`.
fn rolled() -> VaultState {
  VaultState {
    ..vesting_half(),
    vest_short: 3_500_000 + 3_442_096,
    vest_long: 3_500_000 + 5_307_904,
    vest_from: half,
    vest_until: half + vest_period_ms,
    epoch: 1,
  }
}

test vesting_report_rolls_the_unvested_into_a_new_week() {
  vesting_report(rolled(), half, half + 1_000)
}

test vesting_report_conserves_every_unit() {
  // booked + vesting after == booked + vesting before + the credited yield
  let s0 = vesting_s0()
  let s1 = rolled()
  let (fl, tr, ys, yl) = split_yield(10_000_000, 1_250, 107_000_000, 132_000_000, 12_500)
  and {
    s1.short_assets + s1.vest_short == s0.short_assets + s0.vest_short + ys,
    s1.long_assets + s1.vest_long == s0.long_assets + s0.vest_long + yl,
    fl + tr + ys + yl == 10_000_000,
  }
}

test vesting_report_dropping_the_unvested_is_rejected() {
  !vesting_report(
    VaultState { ..rolled(), vest_short: 3_442_096, short_assets: 107_000_000 },
    half,
    half + 1_000,
  )
}

test vesting_report_weighting_only_booked_assets_is_rejected() {
  let (_, _, ys, yl) = split_yield(10_000_000, 1_250, 103_500_000, 128_500_000, 12_500)
  !vesting_report(
    VaultState { ..rolled(), vest_short: 3_500_000 + ys, vest_long: 3_500_000 + yl },
    half,
    half + 1_000,
  )
}

test vesting_report_cannot_keep_the_old_vest_end() {
  // keeping the old end date would vest the new yield in half a week
  !vesting_report(VaultState { ..rolled(), vest_until: vest_period_ms }, half, half + 1_000)
}

test vesting_report_window_is_at_most_one_day() {
  vesting_report(rolled(), half, half + day) && !vesting_report(
    rolled(),
    half,
    half + day + 1,
  )
}

test vesting_report_with_a_stale_lower_bound_keeps_the_vest_start() {
  // lo before vest_from (a backdated report): nothing is booked, and the new
  // week starts at vest_from, not at the earlier lo
  let s0 = vesting_half()
  let (_, _, ys, yl) = split_yield(10_000_000, 1_250, 107_000_000, 132_000_000, 12_500)
  let s1 =
    VaultState {
      ..s0,
      vest_short: 3_500_000 + ys,
      vest_long: 3_500_000 + yl,
      vest_until: half + vest_period_ms,
      epoch: 1,
    }
  let tx =
    at(
      vtx(
        [state_in(s0)],
        [state_out(s1), pay(fl_addr(), 625_000), pay(tr_addr(), 625_000)],
        assets.zero,
        [t_op1, t_op2],
      ),
      half - 1_000,
      half,
    )
  spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

// -- H2.2: long lock at least twice the short cooldown

test lock_of_exactly_twice_the_cooldown_is_accepted() {
  let s0 = yield_s0()
  boot(VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 7 * day, long_lock_ms: 14 * day }) && spend_state(
    s0,
    SetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 14 * day, protocol_bps: 1_250 },
    bounds_tx(s0, bounded(s0, 13_000, 7 * day, 14 * day, 1_250), [t_op1, t_op2]),
  )
}

test genesis_with_lock_below_twice_the_cooldown_is_rejected() {
  !boot(
    VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 7 * day, long_lock_ms: 14 * day - 1 },
  ) && !boot(
    VaultState { ..t_vs(0, 0, 0, 0), short_cooldown_ms: 10 * day, long_lock_ms: 19 * day },
  )
}

test set_bounds_with_lock_below_twice_the_cooldown_is_rejected() {
  let s0 = yield_s0()
  !spend_state(
    s0,
    SetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 14 * day - 1, protocol_bps: 1_250 },
    bounds_tx(s0, bounded(s0, 13_000, 7 * day, 14 * day - 1, 1_250), [t_op1, t_op2]),
  )
}

// -- H2.3: UnlockLong needs its owner; exits return the spent UTxO's ADA

fn unlock_ok_tx() -> Transaction {
  unlock_tx(t_vs(0, 0, 100_000_000, 125_000_000), t_pos(40_000_000), 50_000_000, key_addr(t_alice))
}

fn unlock_ok(tx: Transaction) -> Bool {
  spend_state(t_vs(0, 0, 100_000_000, 125_000_000), UnlockLong, tx)
}

test unlock_without_the_owners_signature_is_rejected() {
  !unlock_ok(Transaction { ..unlock_ok_tx(), extra_signatories: [] })
}

test unlock_signed_by_someone_else_is_rejected() {
  !unlock_ok(Transaction { ..unlock_ok_tx(), extra_signatories: [t_bob] })
}

const t_owner_script: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

fn script_owner_unlock(with_input: Bool) -> Bool {
  let owner = Address { payment_credential: Script(t_owner_script), stake_credential: None }
  let s0 = t_vs(0, 0, 100_000_000, 125_000_000)
  let p = Position { owner, shares: 40_000_000, unlock_at: 1_500_000 }
  let tx = unlock_tx(s0, p, 50_000_000, owner)
  let own_input =
    Input {
      output_reference: r(5),
      output: Output { address: owner, value: ada(), datum: NoDatum, reference_script: None },
    }
  let inputs =
    if with_input {
      list.concat(tx.inputs, [own_input])
    } else {
      tx.inputs
    }
  spend_state(s0, UnlockLong, Transaction { ..tx, inputs: inputs, extra_signatories: [] })
}

test unlock_by_a_script_owner_with_its_input_is_accepted() {
  script_owner_unlock(True)
}

test unlock_by_a_script_owner_without_its_input_is_rejected() {
  !script_owner_unlock(False)
}

test unlock_keeping_the_positions_ada_is_rejected() {
  !unlock_ok(map_out(unlock_ok_tx(), 1, fn(o) { lovelace_delta(o, -1) }))
}

test claim_needs_no_signature() {
  let t = t_ticket(54_000_000)
  let tx = claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1))
  tx.extra_signatories == [] && claim_ok(t, tx)
}

test claim_keeping_the_tickets_ada_is_rejected() {
  let t = t_ticket(54_000_000)
  let paid = lovelace_delta(pay(key_addr(t_alice), 54_000_000), -1)
  !claim_ok(t, claim_tx(t, loss_index_start, [paid], marker(-1)))
}

test long_stake_owned_by_the_vault_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let p = Position(vault_addr(), 10_000_000, t_hi + 30 * day)
  let tx = map_out(long_ok_tx(), 1, fn(o) { Output { ..o, datum: InlineDatum(PositionDatum(p)) } })
  !spend_state(s0, StakeLong { amount: 10_000_000, holder: t_alice, owner: vault_addr() }, tx)
}

test unstake_owned_by_the_vault_is_rejected() {
  let s0 = unstake_ok_s0()
  let t = Ticket { ..t_ticket(54_000_000), owner: vault_addr() }
  let tx = map_out(unstake_ok_tx(), 1, fn(o) { Output { ..o, datum: InlineDatum(TicketDatum(t)) } })
  !spend_state(s0, RequestUnstake { shares: 50_000_000, owner: vault_addr() }, tx)
}

// -- Mutation-pass gaps (2-H)

test genesis_with_a_future_vest_start_is_rejected() {
  // nothing vesting, but every later report would start its week here
  !boot(VaultState { ..t_vs(0, 0, 0, 0), vest_from: 10 * vest_period_ms })
}

fn vesting_long(minted: Int) -> Bool {
  // class L price at hi: 128.5 booked + 0.5 vested by 4/7 = 129 per 100 shares
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      long_shares: 100_000_000 + minted,
      long_assets: 257_500_000,
      epoch: 1,
    }
  let p = Position(key_addr(t_alice), minted, four_sevenths + 30 * day)
  let tx =
    at(vtx([state_in(s0)], [state_out(s1), pos_out(p)], marker(1), []), half, four_sevenths)
  long(s0, 129_000_000, tx)
}

test vesting_long_stake_prices_at_the_upper_bound() {
  vesting_long(100_000_000)
}

test vesting_long_stake_at_the_lower_bound_price_is_rejected() {
  // 129 TSRA at the lo price (128.5) would mint 100_389_105 shares
  !vesting_long(100_389_105)
}

test vesting_set_bounds_books_the_vested_yield() {
  // like every State transition, SetBounds first folds what vested by lo
  let s0 = vesting_s0()
  let s1 =
    VaultState {
      ..vesting_half(),
      long_weight_bps: 13_000,
      short_cooldown_ms: 7 * day,
      long_lock_ms: 30 * day,
      protocol_bps: 1_250,
      epoch: 1,
    }
  let tx = at(bounds_tx(s0, s1, [t_op1, t_op2]), half, half + 1_000)
  spend_state(s0, bounds_rd(), tx) && !spend_state(
    s0,
    bounds_rd(),
    at(bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2]), half, half + 1_000),
  )
}
