//// sTSRA vault operations (Phase 2.5b, SPEC.md §3a.15): the validation of the
//// vault's committee-driven and accounting State transitions, run as a
//// withdraw-zero script so that `stsra_vault` itself stays under the size
//// limit (a script must fit in the transaction that publishes it).
////
//// * `ReportLoss`, `ReportYield`, `SetBounds` and the State side of `Claim`
////   moved here from `stsra_vault.ak` unchanged. The vault's branch for each
////   only checks that a zero withdrawal from this script's credential is in
////   the transaction and that its redeemer names the vault's own policy and
////   this action; everything else is checked here.
//// * Parameterised by the reserve policy only. The vault is parameterised by
////   this script's hash, so this script cannot be parameterised by the vault;
////   it finds the State by the policy named in its redeemer, which the vault
////   binds to itself.
//// * The withdrawal is a gate, not a reward account: the amount must be 0, and
////   the only certificate the script allows for its own credential is its
////   registration. Deregistering or delegating it would freeze every
////   transition above.

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value, lovelace_of, quantity_of}
use cardano/certificate.{Certificate, RegisterCredential}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use stellaris/outputs.{continuing_ok, keeps_lovelace}
use stellaris/thread.{marker_name, marker_value, thread_name, thread_value}
use tessera/first_loss_state.{
  FirstLossState, first_loss_balance, first_loss_moves, first_loss_spent,
}
use tessera/loss.{LossSplit, class_dead, split_loss}
use tessera/loss_fixture
use tessera/reserve_ref.{
  genuine_config, genuine_supply, spent_config, spent_supply,
}
use tessera/reserve_state.{
  ConfigDatum, ConfigState, SupplyDatum, SupplyState, threshold_met,
}
use tessera/reserve_threads.{config_value, supply_value}
use tessera/rules
use tessera/vault_state.{
  Claim, OpsAction, OpsClaim, OpsRedeemer, OpsReportLoss, OpsReportYield,
  OpsSetBounds, Position, PositionDatum, RequestUnstake, StakeLong, StakeShort,
  StateDatum, Ticket, TicketDatum, UnlockLong, VaultDatum, VaultRedeemer,
  VaultState, bounds_ok, fold, long_assets_at, loss_index_start,
  short_assets_at, split_yield, stsra_name, stsra_name_of, ticket_payout,
  vest_period_ms,
}
use tessera/exchange

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

/// The genuine Reserve Config (reference input) with no freeze in force at
/// the transaction's lower bound `lo`. A missing, planted or duplicated Config
/// fails closed. Every exit and stake goes through it (D-15, D-16).
fn open_config(tx: Transaction, reserve: PolicyId, lo: Int) -> Option<ConfigState> {
  when genuine_config(tx, reserve) is {
    Some(r) ->
      if rules.frozen(r.loss_pending_until, lo) {
        None
      } else {
        Some(r)
      }
    None -> None
  }
}

/// Exits: the Config is referenced and no freeze is in force.
fn exits_open(tx: Transaction, reserve: PolicyId, lo: Int) -> Bool {
  when open_config(tx, reserve, lo) is {
    Some(_) -> True
    None -> False
  }
}

/// The reserve committee (read live from the Config) signed.
fn committee_ok(tx: Transaction, reserve: PolicyId) -> Bool {
  when genuine_config(tx, reserve) is {
    Some(r) -> threshold_met(r.operators, r.threshold, tx.extra_signatories)
    None -> False
  }
}

fn clamp0(x: Int) -> Int {
  if x < 0 {
    0
  } else {
    x
  }
}

// ---------------------------------------------------------------- State

/// One of the four transitions, against the one genuine State being spent.
fn ops_transition(
  action: OpsAction,
  tx: Transaction,
  policy: PolicyId,
  reserve: PolicyId,
  ins: List<Output>,
  outs: List<Output>,
) -> Bool {
  expect Some((lo, hi)) = finite_bounds(tx)
  expect Some((state_in, s0)) = sole_state(ins, policy)
  expect Some((next_out, s1)) = sole_state(outs, policy)
  let sf = fold(s0, lo)
  let common =
    and {
      state_value_ok(next_out, policy, reserve, s1),
      continuing_ok(next_out, state_in),
      keeps_lovelace(next_out, state_in),
    }
  when action is {
    // The yield is weighted by each class's whole TSRA (booked + vesting),
    // and vests from max(lo, vest_from) over `vest_period_ms`, together with
    // whatever had not vested yet. The committee window is at most one day,
    // so `lo` cannot be backdated to vest the yield early. Half the protocol
    // cut goes to the first-loss State until it holds 3% of the minted supply
    // (D-10); what it cannot take goes to the treasury.
    OpsReportYield { gross } -> {
      let a_short = sf.short_assets + sf.vest_short
      let a_long = sf.long_assets + sf.vest_long
      if a_short * 10_000 + a_long * s0.long_weight_bps > 0 {
        let (half, rest, y_short, y_long) =
          split_yield(gross, s0.protocol_bps, a_short, a_long, s0.long_weight_bps)
        expect Some(supply) = genuine_supply(tx, reserve)
        expect Some(balance) = first_loss_balance(tx, s0.first_loss)
        let cap = supply.minted_supply * rules.first_loss_cap_bps / 10_000
        let room =
          if cap > balance {
            cap - balance
          } else {
            0
          }
        let to_reserve =
          if half < room {
            half
          } else {
            room
          }
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
          to_reserve == 0 || first_loss_moves(
            tx,
            s0.first_loss,
            balance,
            balance + to_reserve,
          ),
          paid_tsra(tx, s0.treasury_addr, reserve) >= rest + half - to_reserve,
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

    OpsSetBounds { long_weight_bps, short_cooldown_ms, long_lock_ms, protocol_bps } ->
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

    // A Claim spends the State (to lower `ticket_escrow`) and the one Ticket,
    // and nothing else. The Ticket's own validator pays the owner and checks
    // the excess burn. No fold: nothing is priced. `ticket_escrow` tracks the
    // Tickets' CURRENT value (what a Claim would pay), so it falls by the
    // payout: the excess was written off by an earlier ReportLoss, which
    // already took it out of the escrow. Rounding dust can leave the escrow a
    // few units short of the last payout, hence the clamp at zero.
    OpsClaim -> {
      expect [tk] = list.filter(ins, fn(o) { o != state_in })
      expect Some(TicketDatum(t)) = vault_datum(tk)
      let left =
        s0.ticket_escrow - ticket_payout(t.value, s0.loss_index, t.index_at_request)
      and {
        common,
        list.length(ins) == 2,
        list.length(outs) == 1,
        exits_open(tx, reserve, lo),
        ticket_value_ok(tk, policy, reserve, t.value),
        own_mint(tx, policy) == assets.from_asset(policy, marker_name, -1),
        s1 == VaultState {
          ..s0,
          ticket_escrow: clamp0(left),
          epoch: s0.epoch + 1,
        },
      }
    }

    // SPEC.md §3a.2. The waterfall is recomputed here from the folded State,
    // the first-loss balance and `loss`; the reserve's `LossBurn` (run for the
    // Supply and the Config inputs) burns, and this checks every number it was
    // given: the burn, the Supply and Config next datums and the first-loss
    // move.
    OpsReportLoss { loss } -> {
      expect Some((c0, c1)) = spent_config(tx, reserve)
      expect Some((p0, p1)) = spent_supply(tx, reserve)
      expect Some(balance) = first_loss_balance(tx, s0.first_loss)
      let sp =
        split_loss(
          loss,
          sf.vest_short,
          sf.vest_long,
          balance,
          sf.short_assets,
          sf.long_assets,
          sf.ticket_escrow,
          sf.loss_index,
        )
      let dead_s = class_dead(sf.short_shares, sf.short_assets - sp.r_short)
      let dead_l = class_dead(sf.long_shares, sf.long_assets - sp.r_long)
      let sweep_s =
        if dead_s {
          sf.short_assets - sp.r_short + sf.vest_short - sp.u_short
        } else {
          0
        }
      let sweep_l =
        if dead_l {
          sf.long_assets - sp.r_long + sf.vest_long - sp.u_long
        } else {
          0
        }
      let sweep = sweep_s + sweep_l
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 1,
        loss > 0,
        sp.written_off > 0,
        rules.short_window(lo, hi),
        hi < c0.loss_pending_until,
        threshold_met(c0.operators, c0.threshold, tx.extra_signatories),
        own_mint(tx, policy) == assets.zero,
        quantity_of(tx.mint, reserve, rules.tsra_name) == -sp.qty,
        p1 == SupplyState {
          ..p0,
          minted_supply: p0.minted_supply - sp.qty,
          attested_reserve: clamp0(p0.attested_reserve - sp.written_off),
          epoch: p0.epoch + 1,
        },
        c1 == ConfigState {
          ..c0,
          loss_pending_until: lo,
          epoch: c0.epoch + 1,
        },
        (sp.d == 0 && sweep == 0) || first_loss_moves(
          tx,
          s0.first_loss,
          balance,
          balance - sp.d + sweep,
        ),
        s1 == VaultState {
          ..sf,
          short_shares: if dead_s {
            0
          } else {
            sf.short_shares
          },
          short_assets: if dead_s {
            0
          } else {
            sf.short_assets - sp.r_short
          },
          short_gen: if dead_s {
            sf.short_gen + 1
          } else {
            sf.short_gen
          },
          vest_short: if dead_s {
            0
          } else {
            sf.vest_short - sp.u_short
          },
          long_shares: if dead_l {
            0
          } else {
            sf.long_shares
          },
          long_assets: if dead_l {
            0
          } else {
            sf.long_assets - sp.r_long
          },
          long_gen: if dead_l {
            sf.long_gen + 1
          } else {
            sf.long_gen
          },
          vest_long: if dead_l {
            0
          } else {
            sf.vest_long - sp.u_long
          },
          loss_index: sp.loss_index,
          ticket_escrow: sf.ticket_escrow - sp.r_tickets,
          epoch: s0.epoch + 1,
        },
      }
    }
  }
}

// ---------------------------------------------------------------- validator

validator vault_ops(reserve: PolicyId) {
  withdraw(redeemer: OpsRedeemer, account: Credential, tx: Transaction) {
    let policy = redeemer.vault
    let ins = own_inputs(tx.inputs, policy)
    let outs = own_outputs(tx.outputs, policy)
    and {
      // a gate, not a reward account
      pairs.get_first(tx.withdrawals, account) == Some(0),
      ops_transition(redeemer.action, tx, policy, reserve, ins, outs),
    }
  }

  // Registration is the only certificate this credential ever accepts: no
  // deregistration, no delegation, nothing else. Deregistering it would freeze
  // every transition that depends on it.
  publish(_redeemer: Data, certificate: Certificate, _tx: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests

const t_ops: PolicyId =
  #"55555555555555555555555555555555555555555555555555555555"

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

/// The first-loss reserve's script hash (its State holds the `state` token of
/// this policy).
const t_fl: PolicyId =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

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
    ticket_escrow: 0,
    short_gen: 0,
    long_gen: 0,
    vest_short: 0,
    vest_long: 0,
    vest_from: 0,
    vest_until: 0,
    long_weight_bps: 12_500,
    short_cooldown_ms: 7 * day,
    long_lock_ms: 30 * day,
    protocol_bps: 1_250,
    first_loss: t_fl,
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

fn t_reserve_state(kyc_stake: Bool, operators: List<ByteArray>) -> ConfigState {
  ConfigState {
    operators,
    threshold: 2,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake,
    eligibility_policy: t_elig,
    vault_policy: t_own,
    loss_pending_until: 0,
    epoch: 0,
  }
}

fn reserve_ref_with(rs: ConfigState, with_token: Bool) -> Input {
  Input {
    output_reference: r(9),
    output: Output {
      address: Address {
        payment_credential: Script(t_reserve),
        stake_credential: None,
      },
      value: if with_token {
        ada() |> assets.merge(config_value(t_reserve))
      } else {
        ada()
      },
      datum: InlineDatum(ConfigDatum(rs)),
      reference_script: None,
    },
  }
}

fn reserve_ref() -> Input {
  reserve_ref_with(t_reserve_state(False, [t_op1, t_op2]), True)
}

/// The reserve Supply as a reference input (the 3% cap reads `minted_supply`).
fn supply_ref_with(minted: Int, with_token: Bool) -> Input {
  Input {
    output_reference: r(8),
    output: Output {
      address: Address { payment_credential: Script(t_reserve), stake_credential: None },
      value: if with_token {
        ada() |> assets.merge(supply_value(t_reserve))
      } else {
        ada()
      },
      datum: InlineDatum(
        SupplyDatum(
          SupplyState {
            minted_supply: minted,
            attested_reserve: minted,
            mint_cap: minted,
            attestation_epoch: 1,
            attested_at: 0,
            epoch: 0,
          },
        ),
      ),
      reference_script: None,
    },
  }
}

fn supply_ref() -> Input {
  supply_ref_with(1_000_000_000, True)
}

/// The first-loss State holding `balance` TSRA (the `state` token of `t_fl`
/// unless `with_token` is off).
fn fl_out_with(balance: Int, with_token: Bool) -> Output {
  let base = ada() |> assets.merge(tsra(t_reserve, balance))
  Output {
    address: Address { payment_credential: Script(t_fl), stake_credential: None },
    value: if with_token {
      base |> assets.merge(thread_value(t_fl))
    } else {
      base
    },
    datum: InlineDatum(FirstLossState { balance, epoch: 0 }),
    reference_script: None,
  }
}

fn fl_out(balance: Int) -> Output {
  fl_out_with(balance, True)
}

fn fl_in(balance: Int) -> Input {
  Input { output_reference: r(7), output: fl_out(balance) }
}

fn fl_ref(balance: Int) -> Input {
  Input { output_reference: r(7), output: fl_out(balance) }
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

fn t_ticket(v: Int) -> Ticket {
  Ticket {
    owner: key_addr(t_alice),
    value: v,
    index_at_request: loss_index_start,
    claim_after: t_hi + 7 * day,
  }
}

// -- Claim
fn ticket_in(t: Ticket) -> Input {
  Input { output_reference: r(1), output: ticket_out(t) }
}

/// The State a Claim spends: `t.value` escrowed, the loss index at `index_now`.
fn claim_s0(t: Ticket, index_now: Int) -> VaultState {
  VaultState {
    ..t_vs(1, 1, 0, 0),
    loss_index: index_now,
    ticket_escrow: t.value,
  }
}

/// The State after the Claim: the escrow (which equals the Ticket's value
/// here) falls by the payout at `index_now`.
fn claim_s1(t: Ticket, index_now: Int) -> VaultState {
  VaultState {
    ..bump(claim_s0(t, index_now)),
    ticket_escrow: t.value - ticket_payout(t.value, index_now, t.index_at_request),
  }
}

/// A Claim: the State and the Ticket are spent, the State returns with
/// `ticket_escrow` lowered by the Ticket's value; `outputs` come after it.
fn claim_tx(t: Ticket, index_now: Int, outputs: List<Output>, mint: Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [state_in(claim_s0(t, index_now)), ticket_in(t)],
    reference_inputs: [reserve_ref()],
    outputs: [state_out(claim_s1(t, index_now)), ..outputs],
    mint: mint,
    validity_range: interval.between(t.claim_after, t.claim_after + 1_000),
  }
}

// -- UnlockLong
fn t_pos(shares: Int) -> Position {
  Position { owner: key_addr(t_alice), shares, unlock_at: 1_500_000, gen: 0 }
}

fn pos_in(p: Position) -> Input {
  Input { output_reference: r(1), output: pos_out(p) }
}

// -- ReportYield
fn yield_s0() -> VaultState {
  t_vs(100_000_000, 100_000_000, 100_000_000, 100_000_000)
}

/// gross 10 TSRA, 12.5% cut (0.625 + 0.625), net 8.75 split 1 : 1.25 by assets.
fn yield_tx(y_short: Int, y_long: Int, fl: Int, tr: Int, signers: List<ByteArray>) -> Transaction {
  let s0 = yield_s0()
  let s1 = vesting(s0, y_short, y_long)
  yield_with(s0, s1, fl, tr, signers)
}

/// `fl` TSRA go into the first-loss State (spent, from an empty balance) when
/// positive; with `fl == 0` it is only referenced.
fn yield_with(
  s0: VaultState,
  s1: VaultState,
  fl: Int,
  tr: Int,
  signers: List<ByteArray>,
) -> Transaction {
  let base = vtx([state_in(s0)], [state_out(s1), pay(tr_addr(), tr)], assets.zero, signers)
  if fl > 0 {
    Transaction {
      ..base,
      inputs: [state_in(s0), fl_in(0)],
      reference_inputs: [reserve_ref(), supply_ref()],
      outputs: [state_out(s1), fl_out(fl), pay(tr_addr(), tr)],
    }
  } else {
    Transaction { ..base, reference_inputs: [reserve_ref(), supply_ref(), fl_ref(0)] }
  }
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
  spend_state(yield_s0(), OpsReportYield { gross: 10_000_000 }, tx)
}

// -- SetBounds
fn bounds_tx(s0: VaultState, s1: VaultState, signers: List<ByteArray>) -> Transaction {
  vtx([state_in(s0)], [state_out(s1)], assets.zero, signers)
}

fn set_bounds(s0: VaultState, s1: VaultState, w: Int, c: Int, l: Int, p: Int, signers: List<ByteArray>) -> Bool {
  spend_state(
    s0,
    OpsSetBounds { long_weight_bps: w, short_cooldown_ms: c, long_lock_ms: l, protocol_bps: p },
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

// -- Mutation-pass gaps (2.4): a guard existed, no test pinned it
fn some_position() -> Input {
  Input { output_reference: r(1), output: pos_out(t_pos(40_000_000)) }
}

fn junk_vault_output() -> Output {
  Output { ..pay(vault_addr(), 0), datum: NoDatum }
}

// SetBounds
fn bounds_rd() -> OpsAction {
  OpsSetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 30 * day, protocol_bps: 1_250 }
}

fn bounds_ok_tx() -> Transaction {
  let s0 = yield_s0()
  bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2])
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

fn bounds_ok_with(tx: Transaction) -> Bool {
  spend_state(yield_s0(), bounds_rd(), tx)
}

// -- H2.1: yield vests over 7 days; stakes price at hi, exits at lo
/// Half-way and four-sevenths through a vest that started at 0.
const half: Int = 302_400_000

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

fn vesting_report(s1: VaultState, lo: Int, hi: Int) -> Bool {
  let s0 = vesting_s0()
  let tx =
    at(
      yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2]),
      lo,
      hi,
    )
  spend_state(s0, OpsReportYield { gross: 10_000_000 }, tx)
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

// -- Claim: the State branch
fn claim_state_ok(t: Ticket, index_now: Int, tx: Transaction) -> Bool {
  spend_state(claim_s0(t, index_now), OpsClaim, tx)
}

/// In the ops module only the State side of a Claim exists; the Ticket side is
/// tested beside the vault.
fn claim_both(t: Ticket, index_now: Int, tx: Transaction) -> Bool {
  claim_state_ok(t, index_now, tx)
}

fn good_claim_tx() -> Transaction {
  claim_tx(t_ticket(54_000_000), loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1))
}

// -- the freeze
fn config_until(until: Int) -> Input {
  reserve_ref_with(
    ConfigState { ..t_reserve_state(False, [t_op1, t_op2]), loss_pending_until: until },
    True,
  )
}

fn frozen_at(tx: Transaction, until: Int) -> Transaction {
  Transaction { ..tx, reference_inputs: [config_until(until)] }
}

// -- a price can fall only via ReportLoss
fn lowered(s: VaultState) -> VaultState {
  VaultState { ..s, loss_index: s.loss_index - 1 }
}

// -- funding and the 3% cap (D-10)
/// A ReportYield of 10 TSRA (cut 1_250_000, half 625_000) into `yield_s0`
/// against a Supply of `minted` and a first-loss balance of `bal`.
fn capped(minted: Int, bal: Int, to_reserve: Int, to_treasury: Int, spend_fl: Bool) -> Bool {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let base =
    vtx(
      [state_in(s0)],
      [state_out(s1), pay(tr_addr(), to_treasury)],
      assets.zero,
      [t_op1, t_op2],
    )
  let tx =
    if spend_fl {
      Transaction {
        ..base,
        inputs: [state_in(s0), fl_in(bal)],
        reference_inputs: [reserve_ref(), supply_ref_with(minted, True)],
        outputs: [state_out(s1), fl_out(bal + to_reserve), pay(tr_addr(), to_treasury)],
      }
    } else {
      Transaction {
        ..base,
        reference_inputs: [reserve_ref(), supply_ref_with(minted, True), fl_ref(bal)],
      }
    }
  report(tx)
}

fn script_addr_of(h: PolicyId) -> Address {
  Address { payment_credential: Script(h), stake_credential: None }
}

// ====================================================================
// Phase 2.5b: ReportLoss
// ====================================================================
/// Everything one ReportLoss transaction is made of, derived with the same
/// library arithmetic the validator uses, so a test can change one piece.
type RL {
  tx: Transaction,
  s0: VaultState,
  s1: VaultState,
  p0: SupplyState,
  p1: SupplyState,
  c0: ConfigState,
  c1: ConfigState,
  fl0: Int,
  fl1: Int,
  sp: LossSplit,
  sweep: Int,
  loss: Int,
  fl_spent: Bool,
}

fn rl_p0() -> SupplyState {
  SupplyState {
    minted_supply: 10_000_000_000,
    attested_reserve: 10_000_000_000,
    mint_cap: 20_000_000_000,
    attestation_epoch: 1,
    attested_at: 0,
    epoch: 3,
  }
}

fn rl_c0() -> ConfigState {
  ConfigState {
    ..t_reserve_state(False, [t_op1, t_op2]),
    loss_pending_until: 3_000_000,
    epoch: 5,
  }
}

fn reserve_addr() -> Address {
  Address { payment_credential: Script(t_reserve), stake_credential: None }
}

fn supply_utxo(p: SupplyState) -> Output {
  Output {
    address: reserve_addr(),
    value: ada() |> assets.merge(supply_value(t_reserve)),
    datum: InlineDatum(SupplyDatum(p)),
    reference_script: None,
  }
}

fn config_utxo(c: ConfigState) -> Output {
  Output {
    address: reserve_addr(),
    value: ada() |> assets.merge(config_value(t_reserve)),
    datum: InlineDatum(ConfigDatum(c)),
    reference_script: None,
  }
}

/// A State with `vs` / `vl` TSRA vesting from `t_lo` (nothing vested at the
/// transaction's lower bound) and `te` TSRA escrowed in open Tickets.
fn rl_s0(ss: Int, sa: Int, ls: Int, la: Int, vs: Int, vl: Int, te: Int) -> VaultState {
  VaultState {
    ..t_vs(ss, sa, ls, la),
    vest_short: vs,
    vest_long: vl,
    vest_from: t_lo,
    vest_until: t_lo + 7 * day,
    ticket_escrow: te,
  }
}

fn rl_split(s0: VaultState, loss: Int, fl0: Int) -> LossSplit {
  let sf = fold(s0, t_lo)
  split_loss(
    loss,
    sf.vest_short,
    sf.vest_long,
    fl0,
    sf.short_assets,
    sf.long_assets,
    sf.ticket_escrow,
    sf.loss_index,
  )
}

fn rl_world(s0: VaultState, loss: Int, fl0: Int) -> RL {
  rl_world_with(s0, loss, fl0, rl_split(s0, loss, fl0), rl_c0(), rl_p0())
}

fn rl_world_with(
  s0: VaultState,
  loss: Int,
  fl0: Int,
  sp: LossSplit,
  c0: ConfigState,
  p0: SupplyState,
) -> RL {
  let sf = fold(s0, t_lo)
  let dead_s = class_dead(sf.short_shares, sf.short_assets - sp.r_short)
  let dead_l = class_dead(sf.long_shares, sf.long_assets - sp.r_long)
  let sweep_s =
    if dead_s {
      sf.short_assets - sp.r_short + sf.vest_short - sp.u_short
    } else {
      0
    }
  let sweep_l =
    if dead_l {
      sf.long_assets - sp.r_long + sf.vest_long - sp.u_long
    } else {
      0
    }
  let sweep = sweep_s + sweep_l
  let s1 =
    VaultState {
      ..sf,
      short_shares: if dead_s {
        0
      } else {
        sf.short_shares
      },
      short_assets: if dead_s {
        0
      } else {
        sf.short_assets - sp.r_short
      },
      short_gen: if dead_s {
        sf.short_gen + 1
      } else {
        sf.short_gen
      },
      vest_short: if dead_s {
        0
      } else {
        sf.vest_short - sp.u_short
      },
      long_shares: if dead_l {
        0
      } else {
        sf.long_shares
      },
      long_assets: if dead_l {
        0
      } else {
        sf.long_assets - sp.r_long
      },
      long_gen: if dead_l {
        sf.long_gen + 1
      } else {
        sf.long_gen
      },
      vest_long: if dead_l {
        0
      } else {
        sf.vest_long - sp.u_long
      },
      loss_index: sp.loss_index,
      ticket_escrow: sf.ticket_escrow - sp.r_tickets,
      epoch: s0.epoch + 1,
    }
  let c1 = ConfigState { ..c0, loss_pending_until: t_lo, epoch: c0.epoch + 1 }
  let wo = sp.written_off
  let p1 =
    SupplyState {
      ..p0,
      minted_supply: p0.minted_supply - sp.qty,
      attested_reserve: if p0.attested_reserve - wo < 0 {
        0
      } else {
        p0.attested_reserve - wo
      },
      epoch: p0.epoch + 1,
    }
  let fl1 = fl0 - sp.d + sweep
  let fl_spent = sp.d > 0 || sweep > 0
  let supply_in = Input { output_reference: r(10), output: supply_utxo(p0) }
  let config_in = Input { output_reference: r(11), output: config_utxo(c0) }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: if fl_spent {
        [state_in(s0), supply_in, config_in, fl_in(fl0)]
      } else {
        [state_in(s0), supply_in, config_in]
      },
      reference_inputs: if fl_spent {
        []
      } else {
        [fl_ref(fl0)]
      },
      outputs: if fl_spent {
        [state_out(s1), supply_utxo(p1), config_utxo(c1), fl_out(fl1)]
      } else {
        [state_out(s1), supply_utxo(p1), config_utxo(c1)]
      },
      mint: tsra(t_reserve, -sp.qty),
      extra_signatories: [t_op1, t_op2],
      validity_range: interval.between(t_lo, t_hi),
    }
  RL { tx, s0, s1, p0, p1, c0, c1, fl0, fl1, sp, sweep, loss, fl_spent }
}

fn rl_ok(w: RL) -> Bool {
  spend_state(w.s0, OpsReportLoss { loss: w.loss }, w.tx)
}

/// 40 + 20 unvested, 100 first-loss, 600 + 400 staked, 500 in Tickets.
fn golden_s0() -> VaultState {
  rl_s0(600, 600, 400, 400, 40, 20, 500)
}

fn golden() -> RL {
  rl_world(golden_s0(), 460, 100)
}

fn rl_cases() -> List<(VaultState, Int, Int)> {
  [
    // loss below the unvested yield
    (golden_s0(), 30, 100),
    // exactly the unvested yield
    (golden_s0(), 60, 100),
    // unvested + part of the reserve
    (golden_s0(), 110, 100),
    // the reserve exactly exhausted
    (golden_s0(), 160, 100),
    // into the stakers
    (golden_s0(), 460, 100),
    // beyond everything: a residual, not a failure
    (golden_s0(), 60 + 100 + 1_500 + 77, 100),
    // no open Tickets
    (rl_s0(600, 600, 400, 400, 40, 20, 0), 460, 100),
    // no first-loss balance
    (rl_s0(600, 600, 400, 400, 40, 20, 500), 460, 0),
    // no unvested yield
    (rl_s0(600, 600, 400, 400, 0, 0, 500), 460, 100),
    // only the short class
    (rl_s0(1_000, 1_000, 0, 0, 10, 0, 100), 300, 50),
    // only the long class
    (rl_s0(0, 0, 1_000, 1_000, 0, 10, 100), 300, 50),
    // only Tickets exposed: they absorb alone, nothing is burned now
    (rl_s0(0, 0, 0, 0, 0, 0, 500), 100, 0),
    // awkward numbers, heavy rounding
    (rl_s0(7_001, 11_003, 13_007, 17_011, 101, 53, 3_001), 9_999, 17),
    (rl_s0(999_983, 1_000_003, 1_234_567, 2_345_671, 4_001, 7_919, 123_457), 999_999, 12_345),
    (rl_s0(3, 5, 7, 11, 1, 1, 13), 29, 3),
    // a loss so large it wipes both classes
    (rl_s0(1_000, 1_000, 2_000, 2_000, 5, 5, 500), 5_000_000, 100),
  ]
}

// -- a class wiped out by the loss
fn solo_short(loss: Int) -> RL {
  rl_world(rl_s0(1_000_000, 1_000_000, 0, 0, 0, 0, 0), loss, 0)
}

// -- conservation, end to end
/// ReportLoss, then every open Ticket claims: the TSRA burned in total, the
/// backing written off, and the number of Tickets.
fn conserve(s0: VaultState, loss: Int, fl0: Int, tickets: List<Int>) -> (Int, Int, Int) {
  let w = rl_world(s0, loss, fl0)
  let idx = w.s1.loss_index
  let excess =
    list.foldl(
      tickets,
      0,
      fn(v, acc) { acc + v - ticket_payout(v, idx, loss_index_start) },
    )
  (w.sp.qty + excess, w.sp.written_off, list.length(tickets))
}

fn spend_state(_s0: VaultState, act: OpsAction, tx: Transaction) -> Bool {
  vault_ops.withdraw(
    t_reserve,
    OpsRedeemer { vault: t_own, action: act },
    Script(t_ops),
    Transaction { ..tx, withdrawals: [Pair(Script(t_ops), 0)] },
  )
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
  let old = Transaction { ..yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2]), reference_inputs: [rotated, supply_ref(), fl_ref(0)] }
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
  !spend_state(s0, OpsReportYield { gross: 10_000_000 }, tx)
}

test report_yield_of_zero_is_rejected() {
  let s0 = yield_s0()
  let tx = vtx([state_in(s0)], [state_out(bump(s0))], assets.zero, [t_op1, t_op2])
  !spend_state(
    s0,
    OpsReportYield { gross: 0 },
    Transaction { ..tx, reference_inputs: [reserve_ref(), supply_ref(), fl_ref(0)] },
  )
}

test report_yield_cannot_change_shares() {
  let s0 = yield_s0()
  let s1 =
    VaultState { ..vesting(s0, 3_888_889, 4_861_111), short_shares: s0.short_shares + 1 }
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  !report(tx)
}

test report_yield_cannot_mint_stsra() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, mint: stsra(1) })
}

test report_yield_on_a_short_only_vault_credits_the_short_tier() {
  let s0 = t_vs(100_000_000, 100_000_000, 0, 0)
  let s1 = vesting(s0, 8_750_000, 0)
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  spend_state(s0, OpsReportYield { gross: 10_000_000 }, tx)
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

test report_yield_without_the_reserve_state_is_rejected() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, reference_inputs: [supply_ref(), fl_ref(0)] })
}

test report_yield_against_a_planted_reserve_state_is_rejected() {
  // an attacker's own committee in a State-shaped UTxO without the token
  let planted = reserve_ref_with(t_reserve_state(False, [t_bob, t_alice]), False)
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_bob, t_alice])
  !report(Transaction { ..tx, reference_inputs: [planted, supply_ref(), fl_ref(0)] })
}

test set_bounds_without_the_reserve_state_is_rejected() {
  let s0 = yield_s0()
  let tx = bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2])
  !spend_state(
    s0,
    OpsSetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 30 * day, protocol_bps: 1_250 },
    Transaction { ..tx, reference_inputs: [] },
  )
}

// ReportYield
test report_yield_cannot_spend_a_position() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, inputs: [state_in(yield_s0()), fl_in(0), some_position()] })
}

test report_yield_cannot_create_another_vault_output() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  !report(Transaction { ..tx, outputs: [junk_vault_output(), ..tx.outputs] })
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
  !report(Transaction { ..tx, reference_inputs: [moved, supply_ref(), fl_ref(0)] })
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

test vesting_report_rolls_the_unvested_into_a_new_week() {
  vesting_report(rolled(), half, half + 1_000)
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
      yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2]),
      half - 1_000,
      half,
    )
  spend_state(s0, OpsReportYield { gross: 10_000_000 }, tx)
}

test set_bounds_with_lock_below_twice_the_cooldown_is_rejected() {
  let s0 = yield_s0()
  !spend_state(
    s0,
    OpsSetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 14 * day - 1, protocol_bps: 1_250 },
    bounds_tx(s0, bounded(s0, 13_000, 7 * day, 14 * day - 1, 1_250), [t_op1, t_op2]),
  )
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

test report_yield_against_the_supply_utxo_in_place_of_the_config_is_rejected() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  // the genuine Supply UTxO where the Config should be: no Config at all
  !report(Transaction { ..tx, reference_inputs: [supply_ref(), fl_ref(0)] })
}

test a_claim_is_accepted_by_the_state_and_the_ticket() {
  claim_both(t_ticket(54_000_000), loss_index_start, good_claim_tx())
}

test a_claim_lowers_the_escrow_by_the_payout_not_the_escrowed_value() {
  // the escrow tracks the Tickets' CURRENT value; the 27M excess already left
  // it at the ReportLoss that wrote it off
  let t = t_ticket(54_000_000)
  let half_index = loss_index_start / 2
  let paid = [pay(key_addr(t_alice), 27_000_000)]
  let mint = marker(-1) |> assets.merge(tsra(t_reserve, -27_000_000))
  let tx = claim_tx(t, half_index, paid, mint)
  let by_value =
    map_out(
      tx,
      0,
      fn(_) { state_out(VaultState { ..claim_s1(t, half_index), ticket_escrow: 0 }) },
    )
  let by_nothing =
    map_out(
      tx,
      0,
      fn(_) { state_out(VaultState { ..claim_s1(t, half_index), ticket_escrow: 54_000_000 }) },
    )
  claim_both(t, half_index, tx) && claim_s1(t, half_index).ticket_escrow == 27_000_000 && !claim_state_ok(
    t,
    half_index,
    by_value,
  ) && !claim_state_ok(t, half_index, by_nothing)
}

test a_claim_that_leaves_the_escrow_unchanged_is_rejected() {
  let t = t_ticket(54_000_000)
  let tx =
    map_out(
      good_claim_tx(),
      0,
      fn(_) { state_out(VaultState { ..claim_s1(t, loss_index_start), ticket_escrow: 54_000_000 }) },
    )
  !claim_state_ok(t, loss_index_start, tx)
}

test a_claim_clamps_the_escrow_at_zero_and_never_below() {
  // rounding dust can leave the escrow a unit short of the last payout: the
  // Ticket must still be claimable, and the escrow stays at 0, not -1
  let t = t_ticket(54_000_000)
  let s0 = VaultState { ..claim_s0(t, loss_index_start), ticket_escrow: 53_999_999 }
  let tx =
    fn(te: Int) {
      Transaction {
        ..good_claim_tx(),
        inputs: [state_in(s0), ticket_in(t)],
        outputs: [
          state_out(VaultState { ..bump(s0), ticket_escrow: te }),
          pay(key_addr(t_alice), 54_000_000),
        ],
      }
    }
  spend_state(s0, OpsClaim, tx(0)) && !spend_state(s0, OpsClaim, tx(-1)) && !spend_state(s0, OpsClaim, tx(53_999_999))
}

test a_claim_may_take_the_escrow_to_exactly_zero() {
  let t = t_ticket(54_000_000)
  claim_state_ok(t, loss_index_start, good_claim_tx())
}

test a_claim_must_bump_the_state_epoch() {
  let t = t_ticket(54_000_000)
  let tx =
    map_out(
      good_claim_tx(),
      0,
      fn(_) { state_out(VaultState { ..claim_s1(t, loss_index_start), epoch: 0 }) },
    )
  !claim_state_ok(t, loss_index_start, tx)
}

test a_claim_cannot_touch_the_books() {
  let t = t_ticket(54_000_000)
  let s1 = claim_s1(t, loss_index_start)
  let go = fn(s: VaultState) {
    claim_state_ok(t, loss_index_start, map_out(good_claim_tx(), 0, fn(_) { state_out(s) }))
  }
  go(s1) && !go(VaultState { ..s1, short_assets: 2 }) && !go(VaultState { ..s1, short_shares: 2 }) && !go(
    VaultState { ..s1, loss_index: loss_index_start - 1 },
  ) && !go(VaultState { ..s1, vest_short: 1 }) && !go(VaultState { ..s1, protocol_bps: 1 })
}

test a_claim_spends_no_other_vault_utxo() fail {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  let extra = Input { output_reference: r(3), output: pos_out(t_pos(1)) }
  claim_state_ok(t, loss_index_start, Transaction { ..tx, inputs: list.concat(tx.inputs, [extra]) })
}

test the_state_claim_refuses_a_position_in_place_of_the_ticket() fail {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  claim_state_ok(
    t,
    loss_index_start,
    Transaction {
      ..tx,
      inputs: [state_in(claim_s0(t, loss_index_start)), pos_in(t_pos(1))],
    },
  )
}

test the_state_claim_refuses_a_ticket_without_a_marker() {
  let t = t_ticket(54_000_000)
  let bare =
    Input {
      output_reference: r(1),
      output: Output { ..ticket_out(t), value: ada() |> assets.merge(tsra(t_reserve, 54_000_000)) },
    }
  let tx = good_claim_tx()
  !claim_state_ok(
    t,
    loss_index_start,
    Transaction { ..tx, inputs: [state_in(claim_s0(t, loss_index_start)), bare] },
  )
}

test the_state_claim_refuses_a_ticket_holding_other_tokens() {
  let t = t_ticket(54_000_000)
  let fat =
    Input {
      output_reference: r(1),
      output: Output { ..ticket_out(t), value: ticket_out(t).value |> assets.add(t_op1, "junk", 1) },
    }
  let tx = good_claim_tx()
  !claim_state_ok(
    t,
    loss_index_start,
    Transaction { ..tx, inputs: [state_in(claim_s0(t, loss_index_start)), fat] },
  )
}

test the_state_claim_needs_the_marker_burn() {
  let t = t_ticket(54_000_000)
  !claim_state_ok(t, loss_index_start, Transaction { ..good_claim_tx(), mint: assets.zero })
}

test the_state_claim_cannot_mint_anything_else() {
  let t = t_ticket(54_000_000)
  !claim_state_ok(
    t,
    loss_index_start,
    Transaction { ..good_claim_tx(), mint: marker(-1) |> assets.merge(stsra(1)) },
  )
}

test the_state_claim_cannot_create_another_vault_output() {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  !claim_state_ok(t, loss_index_start, Transaction { ..tx, outputs: [junk_vault_output(), ..tx.outputs] })
}

test a_claim_at_the_index_floor_pays_a_millionth() {
  let t = t_ticket(54_000_000)
  let payout = 54
  let tx =
    claim_tx(
      t,
      rules.min_loss_index,
      [pay(key_addr(t_alice), payout)],
      marker(-1) |> assets.merge(tsra(t_reserve, -(54_000_000 - payout))),
    )
  claim_both(t, rules.min_loss_index, tx)
}

test a_ticket_requested_after_a_loss_is_not_charged() {
  // its index_at_request is the post-loss index: payout == value, excess 0
  let idx = 800_000_000_000
  let t = Ticket { ..t_ticket(54_000_000), index_at_request: idx }
  claim_both(t, idx, claim_tx(t, idx, [pay(key_addr(t_alice), 54_000_000)], marker(-1)))
}

test a_claim_is_frozen_until_the_freeze_ends() {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  and {
    claim_state_ok(t, loss_index_start, frozen_at(tx, t.claim_after)),
    !claim_state_ok(t, loss_index_start, frozen_at(tx, t.claim_after + 1)),
    !claim_state_ok(t, loss_index_start, frozen_at(tx, t.claim_after + 604_800_000)),
  }
}

test yield_and_bounds_ignore_the_freeze() {
  // only exits and stakes are frozen; the committee's own actions are not
  let far = 9_999_999_999
  let ry = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  let sb = bounds_ok_tx()
  report(Transaction { ..ry, reference_inputs: [config_until(far), supply_ref()] }) && bounds_ok_with(
    frozen_at(sb, far),
  )
}

test yield_into_an_emptied_class_credits_only_the_other_class() {
  // the short class is gone (0 shares): the whole net goes to the long class
  let s0 = VaultState { ..t_vs(0, 0, 100_000_000, 100_000_000) }
  let (_, _, ys, yl) = split_yield(10_000_000, 1_250, 0, 100_000_000, 12_500)
  let s1 = vesting(s0, ys, yl)
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  ys == 0 && yl == 8_750_000 && spend_state(s0, OpsReportYield { gross: 10_000_000 }, tx)
}

test the_reserve_gets_its_half_until_it_holds_three_percent() {
  // minted 100 TSRA: cap 3 TSRA = 3_000_000; half = 625_000 fits
  capped(100_000_000, 0, 625_000, 625_000, True)
}

test the_overflow_beyond_the_cap_goes_to_the_treasury() {
  // minted 10 TSRA: cap 300_000, so the reserve takes 300_000 and the treasury
  // the other 325_000 of the half as well as its own 625_000
  capped(10_000_000, 0, 300_000, 950_000, True)
}

test the_reserve_takes_only_the_room_left_under_the_cap() {
  // balance 200_000 of a 300_000 cap: room 100_000
  capped(10_000_000, 200_000, 100_000, 1_150_000, True)
}

test a_reserve_at_the_cap_gets_nothing_and_is_only_referenced() {
  capped(10_000_000, 300_000, 0, 1_250_000, False)
}

test a_reserve_above_the_cap_gets_nothing() {
  capped(10_000_000, 500_000, 0, 1_250_000, False)
}

test the_cap_is_three_percent_of_the_minted_supply() {
  // 3% of 10_000_001 floors to 300_000: room for 300_000, not 300_001
  capped(10_000_001, 0, 300_000, 950_000, True) && !capped(10_000_001, 0, 300_001, 949_999, True) && capped(
    10_000_034,
    0,
    300_001,
    949_999,
    True,
  )
}

test an_over_funded_reserve_is_rejected() {
  // the vault may not pour more into first-loss than the cap allows
  !capped(10_000_000, 0, 625_000, 625_000, True)
}

test an_under_funded_reserve_is_rejected() {
  // room for 625_000 but only 600_000 deposited (the treasury paid the rest)
  !capped(100_000_000, 0, 600_000, 650_000, True)
}

test a_reserve_with_room_cannot_be_skipped() {
  // room but the first-loss State only referenced: the cut would go to the
  // treasury and the reserve would never fill
  !capped(100_000_000, 0, 0, 1_250_000, False)
}

test the_treasury_must_be_paid_the_rest_of_the_cut() {
  // conservation: to_reserve + treasury == cut (1_250_000)
  !capped(10_000_000, 0, 300_000, 949_999, True) && capped(10_000_000, 0, 300_000, 950_000, True)
}

test a_funded_reserve_must_be_returned_with_the_deposit_exactly() {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let ok = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  let skim = map_out(ok, 1, fn(_) { fl_out(624_999) })
  report(ok) && !report(skim)
}

test a_funded_reserve_must_be_spent_not_just_paid() {
  // TSRA paid to the first-loss address beside its State is not a deposit
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let beside =
    Transaction {
      ..yield_with(s0, s1, 0, 625_000, [t_op1, t_op2]),
      outputs: [state_out(s1), pay(script_addr_of(t_fl), 625_000), pay(tr_addr(), 625_000)],
    }
  !report(beside)
}

test the_funding_needs_the_genuine_first_loss_state() fail {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 0, 1_250_000, [t_op1, t_op2])
  report(Transaction { ..tx, reference_inputs: [reserve_ref(), supply_ref(), Input { ..fl_ref(0), output: fl_out_with(0, False) }] })
}

test the_funding_needs_the_first_loss_state_of_this_vault() fail {
  // a State under another first-loss policy is not this vault's
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 0, 1_250_000, [t_op1, t_op2])
  let other =
    Input {
      ..fl_ref(0),
      output: Output {
        ..fl_out(0),
        address: script_addr_of(#"abababababababababababababababababababababababababababab"),
        value: ada() |> assets.add(#"abababababababababababababababababababababababababababab", "state", 1),
      },
    }
  report(Transaction { ..tx, reference_inputs: [reserve_ref(), supply_ref(), other] })
}

test the_funding_needs_the_genuine_supply() fail {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 0, 1_250_000, [t_op1, t_op2])
  report(Transaction { ..tx, reference_inputs: [reserve_ref(), supply_ref_with(1_000_000_000, False), fl_ref(0)] })
}

test the_cap_reads_the_supply_not_the_config() fail {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 0, 1_250_000, [t_op1, t_op2])
  report(Transaction { ..tx, reference_inputs: [reserve_ref(), fl_ref(0)] })
}

test the_funding_is_not_open_to_a_planted_first_loss_input() fail {
  // a token-less lookalike spent in place of the genuine State
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  report(
    Transaction {
      ..tx,
      inputs: [state_in(s0), Input { output_reference: r(7), output: fl_out_with(0, False) }],
    },
  )
}

test the_cut_of_a_zero_protocol_share_needs_no_deposit() {
  let s0 = VaultState { ..yield_s0(), protocol_bps: 0 }
  let (a, b, ys, yl) = split_yield(10_000_000, 0, 100_000_000, 100_000_000, 12_500)
  let s1 = vesting(s0, ys, yl)
  let base = yield_with(s0, s1, 0, 0, [t_op1, t_op2])
  a == 0 && b == 0 && spend_state(s0, OpsReportYield { gross: 10_000_000 }, base)
}

test report_loss_matches_the_hand_computed_waterfall() {
  let w = golden()
  and {
    // unvested 60, first-loss 100, then 300 over 1000 + 500: stakers 200
    // (short 120, long 80), tickets 100, index down by a fifth
    w.sp.u == 60,
    w.sp.d == 100,
    w.sp.r_stakers == 200,
    w.sp.r_tickets == 100,
    w.sp.qty == 360,
    w.sp.written_off == 460,
    w.s1 == VaultState {
      ..golden_s0(),
      short_assets: 480,
      long_assets: 320,
      vest_short: 0,
      vest_long: 0,
      loss_index: 800_000_000_000,
      ticket_escrow: 400,
      epoch: 1,
    },
    w.p1.minted_supply == 10_000_000_000 - 360,
    w.p1.attested_reserve == 10_000_000_000 - 460,
    w.c1.loss_pending_until == t_lo,
    w.fl1 == 0,
    rl_ok(w),
  }
}

test report_loss_is_accepted_over_a_table_of_losses() {
  list.all(
    rl_cases(),
    fn(c) {
      let (s0, loss, fl0) = c
      rl_ok(rl_world(s0, loss, fl0))
    },
  )
}

test report_loss_conserves_the_state_tsra_and_the_burn() {
  // State + first-loss TSRA before = after + the burn, in every case
  list.all(
    rl_cases(),
    fn(c) {
      let (s0, loss, fl0) = c
      let w = rl_world(s0, loss, fl0)
      let before = s0.short_assets + s0.long_assets + s0.vest_short + s0.vest_long + fl0
      let after =
        w.s1.short_assets + w.s1.long_assets + w.s1.vest_short + w.s1.vest_long + w.fl1
      before == after + w.sp.qty
    },
  )
}

test report_loss_applies_the_vested_part_before_it_drains_the_rest() {
  // half the week has vested by lo: that yield belongs to the stakers
  let s0 = VaultState { ..golden_s0(), vest_from: 0, vest_until: 2 * t_lo, vest_short: 40, vest_long: 20 }
  let sf = fold(s0, t_lo)
  let w = rl_world(s0, 30, 100)
  and {
    sf.vest_short == 20,
    sf.vest_long == 10,
    sf.short_assets == 620,
    w.sp.u == 30,
    w.sp.u_short == 20,
    w.s1.vest_short == 0,
    w.s1.vest_long == 0,
    w.s1.short_assets == 620,
    rl_ok(w),
  }
}

test report_loss_cannot_drain_the_unvested_yield_of_the_raw_book() {
  // draining the unfolded vest fields (60) instead of the folded ones (30)
  let s0 = VaultState { ..golden_s0(), vest_from: 0, vest_until: 2 * t_lo, vest_short: 40, vest_long: 20 }
  let raw = split_loss(45, 40, 20, 100, 600, 400, 500, loss_index_start)
  let w = rl_world_with(s0, 45, 100, raw, rl_c0(), rl_p0())
  !rl_ok(w) && rl_ok(rl_world(s0, 45, 100))
}

test report_loss_with_nothing_exposed_is_rejected() {
  // no unvested yield, no reserve, no stakers, no tickets: only a residual
  !rl_ok(rl_world(rl_s0(0, 0, 0, 0, 0, 0, 0), 100, 0))
}

test report_loss_of_zero_or_less_is_rejected() {
  let s0 = golden_s0()
  let w = rl_world(s0, 460, 100)
  !spend_state(s0, OpsReportLoss { loss: 0 }, w.tx) && !spend_state(s0, OpsReportLoss { loss: -5 }, w.tx)
}

// -- the committee, the freeze and the reserve's side
test report_loss_needs_the_committee() {
  let w = golden()
  !rl_ok(RL { ..w, tx: Transaction { ..w.tx, extra_signatories: [t_op1] } })
}

test report_loss_takes_the_committee_from_the_spent_config() {
  let rotated = ConfigState { ..rl_c0(), operators: [t_op2, t_op3] }
  let w = rl_world_with(golden_s0(), 460, 100, rl_split(golden_s0(), 460, 100), rotated, rl_p0())
  !rl_ok(w) && rl_ok(RL { ..w, tx: Transaction { ..w.tx, extra_signatories: [t_op2, t_op3] } })
}

test report_loss_needs_an_active_freeze() {
  let none = ConfigState { ..rl_c0(), loss_pending_until: 0 }
  !rl_ok(rl_world_with(golden_s0(), 460, 100, rl_split(golden_s0(), 460, 100), none, rl_p0()))
}

test report_loss_needs_the_freeze_to_outlast_the_upper_bound() {
  let at_hi = ConfigState { ..rl_c0(), loss_pending_until: t_hi }
  let after = ConfigState { ..rl_c0(), loss_pending_until: t_hi + 1 }
  let sp = rl_split(golden_s0(), 460, 100)
  !rl_ok(rl_world_with(golden_s0(), 460, 100, sp, at_hi, rl_p0())) && rl_ok(
    rl_world_with(golden_s0(), 460, 100, sp, after, rl_p0()),
  )
}

test report_loss_closes_the_freeze_at_the_lower_bound() {
  let w = golden()
  let late = ConfigState { ..w.c1, loss_pending_until: t_hi }
  let early = ConfigState { ..w.c1, loss_pending_until: 0 }
  !rl_ok(RL { ..w, tx: map_out(w.tx, 2, fn(_) { config_utxo(late) }) }) && !rl_ok(
    RL { ..w, tx: map_out(w.tx, 2, fn(_) { config_utxo(early) }) },
  ) && !rl_ok(
    RL { ..w, tx: map_out(w.tx, 2, fn(_) { config_utxo(ConfigState { ..w.c1, loss_pending_until: w.c0.loss_pending_until }) }) },
  )
}

test report_loss_cannot_touch_the_rest_of_the_config() {
  let w = golden()
  let go = fn(c: ConfigState) { rl_ok(RL { ..w, tx: map_out(w.tx, 2, fn(_) { config_utxo(c) }) }) }
  go(w.c1) && !go(ConfigState { ..w.c1, paused: True }) && !go(ConfigState { ..w.c1, operators: [t_op1, t_op3] }) && !go(
    ConfigState { ..w.c1, vault_policy: #"" },
  ) && !go(ConfigState { ..w.c1, kyc_stake: True }) && !go(ConfigState { ..w.c1, epoch: w.c0.epoch })
}

test report_loss_window_is_at_most_a_day() {
  let w = golden()
  let long_freeze = ConfigState { ..rl_c0(), loss_pending_until: 1_000_000_000 }
  let sp = rl_split(golden_s0(), 460, 100)
  let wl = rl_world_with(golden_s0(), 460, 100, sp, long_freeze, rl_p0())
  rl_ok(RL { ..wl, tx: Transaction { ..wl.tx, validity_range: interval.between(t_lo, t_lo + 86_400_000) } }) && !rl_ok(
    RL { ..wl, tx: Transaction { ..wl.tx, validity_range: interval.between(t_lo, t_lo + 86_400_001) } },
  ) && w.loss == 460
}

test report_loss_with_unbounded_validity_is_rejected() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, validity_range: interval.after(t_lo) } })
}

test report_loss_burn_must_equal_the_waterfall() {
  let w = golden()
  let go = fn(b: Int) { rl_ok(RL { ..w, tx: Transaction { ..w.tx, mint: tsra(t_reserve, b) } }) }
  go(-360) && !go(-361) && !go(-359) && !go(0) && !go(360) && !go(-460)
}

test report_loss_cannot_mint_stsra() {
  let w = golden()
  !rl_ok(RL { ..w, tx: Transaction { ..w.tx, mint: w.tx.mint |> assets.merge(stsra(1)) } })
}

test report_loss_supply_moves_by_qty_and_written_off() {
  let w = golden()
  let go = fn(p: SupplyState) { rl_ok(RL { ..w, tx: map_out(w.tx, 1, fn(_) { supply_utxo(p) }) }) }
  and {
    go(w.p1),
    // minted_supply falls by qty, exactly
    !go(SupplyState { ..w.p1, minted_supply: w.p1.minted_supply + 1 }),
    !go(SupplyState { ..w.p1, minted_supply: w.p1.minted_supply - 1 }),
    // the attestation falls by written_off (460), not qty (360)
    !go(SupplyState { ..w.p1, attested_reserve: w.p0.attested_reserve - 360 }),
    !go(SupplyState { ..w.p1, attested_reserve: w.p1.attested_reserve + 1 }),
    !go(SupplyState { ..w.p1, attested_reserve: w.p1.attested_reserve - 1 }),
    !go(SupplyState { ..w.p1, epoch: w.p0.epoch }),
    !go(SupplyState { ..w.p1, mint_cap: 1 }),
    !go(SupplyState { ..w.p1, attested_at: 9 }),
  }
}

test report_loss_written_off_is_the_loss_minus_the_residual() {
  // the Tickets' share is written off now even though it is burned later
  let w = golden()
  let s = w.sp
  s.written_off == s.qty + s.r_tickets && s.written_off == w.loss - s.residual
}

test report_loss_clamps_the_attestation_at_zero() {
  let low = SupplyState { ..rl_p0(), attested_reserve: 400 }
  let w = rl_world_with(golden_s0(), 460, 100, rl_split(golden_s0(), 460, 100), rl_c0(), low)
  w.p1.attested_reserve == 0 && rl_ok(w) && !rl_ok(
    RL { ..w, tx: map_out(w.tx, 1, fn(_) { supply_utxo(SupplyState { ..w.p1, attested_reserve: -60 }) }) },
  )
}

// -- the State's new books
test report_loss_state_books_must_match() {
  let w = golden()
  let go = fn(s: VaultState) { rl_ok(RL { ..w, tx: map_out(w.tx, 0, fn(_) { state_out(s) }) }) }
  and {
    go(w.s1),
    !go(VaultState { ..w.s1, short_assets: w.s1.short_assets + 1 }),
    !go(VaultState { ..w.s1, short_assets: w.s1.short_assets - 1 }),
    !go(VaultState { ..w.s1, long_assets: w.s1.long_assets + 1 }),
    !go(VaultState { ..w.s1, long_assets: w.s1.long_assets - 1 }),
    !go(VaultState { ..w.s1, short_shares: w.s1.short_shares - 1 }),
    !go(VaultState { ..w.s1, long_shares: w.s1.long_shares + 1 }),
    !go(VaultState { ..w.s1, vest_short: 1 }),
    !go(VaultState { ..w.s1, vest_long: 1 }),
    !go(VaultState { ..w.s1, loss_index: w.s1.loss_index + 1 }),
    !go(VaultState { ..w.s1, loss_index: w.s1.loss_index - 1 }),
    !go(VaultState { ..w.s1, loss_index: loss_index_start }),
    !go(VaultState { ..w.s1, ticket_escrow: w.s0.ticket_escrow }),
    !go(VaultState { ..w.s1, ticket_escrow: w.s1.ticket_escrow + 1 }),
    !go(VaultState { ..w.s1, ticket_escrow: w.s1.ticket_escrow - 1 }),
    !go(VaultState { ..w.s1, epoch: 0 }),
    !go(VaultState { ..w.s1, short_gen: 1 }),
    !go(VaultState { ..w.s1, long_gen: 1 }),
    !go(VaultState { ..w.s1, long_weight_bps: 15_000 }),
    !go(VaultState { ..w.s1, short_cooldown_ms: 8 * day }),
    !go(VaultState { ..w.s1, long_lock_ms: 31 * day }),
    !go(VaultState { ..w.s1, protocol_bps: 1_000 }),
    !go(VaultState { ..w.s1, first_loss: t_own }),
  }
}

test report_loss_state_value_must_match_the_books() {
  let w = golden()
  let thin = Output { ..state_out(w.s1), value: state_out(w.s1).value |> assets.merge(tsra(t_reserve, -1)) }
  let fat = Output { ..state_out(w.s1), value: state_out(w.s1).value |> assets.merge(tsra(t_reserve, 1)) }
  !rl_ok(RL { ..w, tx: map_out(w.tx, 0, fn(_) { thin }) }) && !rl_ok(RL { ..w, tx: map_out(w.tx, 0, fn(_) { fat }) })
}

test report_loss_spends_no_other_vault_utxo() {
  let w = golden()
  let extra = Input { output_reference: r(3), output: pos_out(t_pos(1)) }
  !rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: list.concat(w.tx.inputs, [extra]) } })
}

test report_loss_creates_no_other_vault_output() {
  let w = golden()
  !rl_ok(RL { ..w, tx: Transaction { ..w.tx, outputs: list.concat(w.tx.outputs, [junk_vault_output()]) } })
}

// -- the order of the waterfall
test report_loss_cannot_skip_the_unvested_yield() {
  // pretend nothing was vesting: the reserve and stakers pay instead
  let s0 = golden_s0()
  let alt = split_loss(460, 0, 0, 100, 600, 400, 500, loss_index_start)
  !rl_ok(rl_world_with(s0, 460, 100, alt, rl_c0(), rl_p0()))
}

test report_loss_cannot_skip_the_first_loss_reserve() {
  // touch the stakers while the reserve still holds TSRA
  let s0 = golden_s0()
  let alt = split_loss(460, 40, 20, 0, 600, 400, 500, loss_index_start)
  !rl_ok(rl_world_with(s0, 460, 100, alt, rl_c0(), rl_p0()))
}

test report_loss_cannot_touch_the_reserve_before_the_unvested_yield() {
  // draw the reserve first, then the unvested yield
  let s0 = golden_s0()
  let alt = split_loss(100, 0, 0, 100, 600, 400, 500, loss_index_start)
  !rl_ok(rl_world_with(s0, 100, 100, alt, rl_c0(), rl_p0()))
}

test report_loss_does_not_charge_the_stakers_the_whole_remainder() {
  // the double charge: stakers cut by all 300 while the Tickets also lose
  let s0 = golden_s0()
  let alt = split_loss(460, 40, 20, 100, 600, 400, 0, loss_index_start)
  !rl_ok(rl_world_with(s0, 460, 100, alt, rl_c0(), rl_p0()))
}

test report_loss_spreads_the_remainder_over_stakers_and_tickets() {
  let with_t = rl_split(golden_s0(), 460, 100)
  let no_t = rl_split(rl_s0(600, 600, 400, 400, 40, 20, 0), 460, 100)
  with_t.r_stakers == 200 && no_t.r_stakers == 300 && with_t.r_tickets == 100 && no_t.r_tickets == 0
}

test report_loss_leaves_the_tickets_escrow_at_their_current_value() {
  // T falls by the Tickets' share, so a second loss sees what they are worth
  let w = golden()
  w.s1.ticket_escrow == 500 - 100 && w.s1.ticket_escrow == w.s0.ticket_escrow - w.sp.r_tickets
}

// -- the first-loss reserve's side
test report_loss_draws_the_reserve_through_its_state() {
  let w = golden()
  w.fl_spent && w.fl1 == 0 && rl_ok(w)
}

test report_loss_must_spend_the_first_loss_state_when_it_draws() {
  // the reserve is only referenced: nothing is drawn, so the books are off
  let w = golden()
  let refd =
    Transaction {
      ..w.tx,
      inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, Input { output_reference: r(11), output: config_utxo(w.c0) }],
      reference_inputs: [fl_ref(w.fl0)],
      outputs: [state_out(w.s1), supply_utxo(w.p1), config_utxo(w.c1)],
    }
  !rl_ok(RL { ..w, tx: refd })
}

test report_loss_first_loss_balance_must_fall_by_the_draw() {
  let w = golden()
  let go = fn(b: Int) { rl_ok(RL { ..w, tx: map_out(w.tx, 3, fn(_) { fl_out(b) }) }) }
  go(0) && !go(1) && !go(100) && !go(-1)
}

test report_loss_needs_no_first_loss_input_when_nothing_is_drawn() {
  // loss within the unvested yield, nothing swept: the reserve is only read
  let w = rl_world(golden_s0(), 30, 100)
  !w.fl_spent && list.length(w.tx.inputs) == 3 && rl_ok(w)
}

test report_loss_needs_to_see_the_first_loss_state() fail {
  let w = rl_world(golden_s0(), 30, 100)
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, reference_inputs: [] } })
}

test report_loss_rejects_a_planted_first_loss_state() fail {
  let w = golden()
  let planted = Input { output_reference: r(7), output: fl_out_with(100, False) }
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, Input { output_reference: r(11), output: config_utxo(w.c0) }, planted] } })
}

// -- genuine Supply and Config
test report_loss_needs_the_supply_spent() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [state_in(w.s0), Input { output_reference: r(11), output: config_utxo(w.c0) }, fl_in(w.fl0)] } })
}

test report_loss_needs_the_config_spent() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, fl_in(w.fl0)] } })
}

test report_loss_with_the_config_only_referenced_is_rejected() fail {
  let w = golden()
  rl_ok(
    RL {
      ..w,
      tx: Transaction {
        ..w.tx,
        inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, fl_in(w.fl0)],
        reference_inputs: [Input { output_reference: r(11), output: config_utxo(w.c0) }],
      },
    },
  )
}

test report_loss_rejects_a_planted_supply() fail {
  let w = golden()
  let planted = Output { ..supply_utxo(w.p0), value: ada() }
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [state_in(w.s0), Input { output_reference: r(10), output: planted }, Input { output_reference: r(11), output: config_utxo(w.c0) }, fl_in(w.fl0)] } })
}

test report_loss_rejects_a_planted_config() fail {
  let w = golden()
  let planted = Output { ..config_utxo(w.c0), value: ada() }
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, Input { output_reference: r(11), output: planted }, fl_in(w.fl0)] } })
}

test report_loss_must_return_the_supply() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, outputs: [state_out(w.s1), config_utxo(w.c1), fl_out(w.fl1)] } })
}

test report_loss_must_return_the_config() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, outputs: [state_out(w.s1), supply_utxo(w.p1), fl_out(w.fl1)] } })
}

test report_loss_rejects_a_planted_state() fail {
  let w = golden()
  rl_ok(RL { ..w, tx: Transaction { ..w.tx, inputs: [Input { output_reference: r(0), output: state_out_with(w.s0, False) }, Input { output_reference: r(10), output: supply_utxo(w.p0) }, Input { output_reference: r(11), output: config_utxo(w.c0) }, fl_in(w.fl0)] } })
}

test a_class_priced_at_a_thousandth_survives() {
  // 1000 TSRA units left for 1,000,000 shares: exactly 1/1000, alive
  let w = solo_short(999_000)
  and {
    w.s1.short_shares == 1_000_000,
    w.s1.short_assets == 1_000,
    w.s1.short_gen == 0,
    w.sweep == 0,
    !w.fl_spent,
    rl_ok(w),
  }
}

test a_class_priced_below_a_thousandth_is_wiped_out() {
  // 999 left: dead. Shares and assets reset, a new generation, 999 swept
  let w = solo_short(999_001)
  and {
    w.s1.short_shares == 0,
    w.s1.short_assets == 0,
    w.s1.short_gen == 1,
    w.sweep == 999,
    w.fl_spent,
    w.fl1 == 999,
    rl_ok(w),
  }
}

test a_class_whose_assets_reach_zero_is_wiped_out() {
  let w = solo_short(1_000_000)
  w.s1.short_shares == 0 && w.s1.short_gen == 1 && w.sweep == 0 && !w.fl_spent && rl_ok(w)
}

test a_dead_class_cannot_keep_its_shares() {
  let w = solo_short(999_001)
  let alive = VaultState { ..w.s1, short_shares: 1_000_000, short_assets: 999, short_gen: 0 }
  !rl_ok(RL { ..w, tx: map_out(w.tx, 0, fn(_) { state_out(alive) }) })
}

test a_live_class_cannot_be_reset() {
  let w = solo_short(999_000)
  let reset = VaultState { ..w.s1, short_shares: 0, short_assets: 0, short_gen: 1 }
  let w2 = RL { ..w, tx: map_out(w.tx, 0, fn(_) { state_out(reset) }) }
  !rl_ok(w2)
}

test a_dead_class_needs_a_new_generation() {
  let w = solo_short(999_001)
  let same_gen = VaultState { ..w.s1, short_gen: 0 }
  let jump = VaultState { ..w.s1, short_gen: 2 }
  !rl_ok(RL { ..w, tx: map_out(w.tx, 0, fn(_) { state_out(same_gen) }) }) && !rl_ok(
    RL { ..w, tx: map_out(w.tx, 0, fn(_) { state_out(jump) }) },
  )
}

test the_dead_classs_remainder_is_swept_not_burned() {
  // burning it instead of depositing it is refused
  let w = solo_short(999_001)
  let burned = RL { ..w, tx: Transaction { ..w.tx, mint: tsra(t_reserve, -(w.sp.qty + 999)) } }
  w.sp.qty == 999_001 && !rl_ok(burned)
}

test the_dead_classs_sweep_must_reach_first_loss() {
  let w = solo_short(999_001)
  let lost = RL { ..w, tx: map_out(w.tx, 3, fn(_) { fl_out(0) }) }
  let thin = RL { ..w, tx: map_out(w.tx, 3, fn(_) { fl_out(998) }) }
  !rl_ok(lost) && !rl_ok(thin)
}

test the_dead_classs_sweep_needs_the_first_loss_state_spent() {
  let w = solo_short(999_001)
  let refd =
    Transaction {
      ..w.tx,
      inputs: [state_in(w.s0), Input { output_reference: r(10), output: supply_utxo(w.p0) }, Input { output_reference: r(11), output: config_utxo(w.c0) }],
      reference_inputs: [fl_ref(0)],
      outputs: [state_out(w.s1), supply_utxo(w.p1), config_utxo(w.c1)],
    }
  !rl_ok(RL { ..w, tx: refd })
}

test a_dead_long_class_is_wiped_out_too() {
  let w = rl_world(rl_s0(0, 0, 1_000_000, 1_000_000, 0, 0, 0), 999_001, 0)
  w.s1.long_shares == 0 && w.s1.long_assets == 0 && w.s1.long_gen == 1 && w.sweep == 999 && rl_ok(w)
}

test the_classes_die_independently() {
  // both lose the same fraction (99.95%); the long class (1 TSRA per share
  // before) falls under a thousandth, the short class (a million per share)
  // does not
  let s0 = rl_s0(1_000, 1_000_000_000, 1_000_000, 1_000_000, 0, 0, 0)
  let w = rl_world(s0, 1_000_500_000, 0)
  and { w.s1.long_gen == 1, w.s1.long_shares == 0, w.s1.short_gen == 0, w.s1.short_shares == 1_000, rl_ok(w) }
}

test a_wiped_class_with_unvested_yield_sweeps_that_too() {
  // an invalid prior state (a class already under the floor) with yield still
  // vesting: the sweep carries the vesting part as well
  let s0 = rl_s0(1_000_000, 500, 0, 0, 90, 0, 0)
  let w = rl_world(s0, 5, 0)
  w.s1.short_gen == 1 && w.s1.vest_short == 0 && w.sweep == 500 - w.sp.r_short + 90 - w.sp.u_short && rl_ok(w)
}

test no_transition_leaves_shares_without_assets() {
  // after every ReportLoss in the table, a class has shares only if it holds
  // at least a thousandth of a TSRA per share
  list.all(
    rl_cases(),
    fn(c) {
      let (s0, loss, fl0) = c
      let w = rl_world(s0, loss, fl0)
      (w.s1.short_shares == 0 || w.s1.short_assets * 1_000 >= w.s1.short_shares) && (w.s1.long_shares == 0 || w.s1.long_assets * 1_000 >= w.s1.long_shares) && (w.s1.short_shares > 0 || (w.s1.short_assets == 0 && w.s1.vest_short == 0)) && (w.s1.long_shares > 0 || (w.s1.long_assets == 0 && w.s1.vest_long == 0))
    },
  )
}

test mint_shares_never_sees_zero_assets_with_live_shares() {
  list.all(
    rl_cases(),
    fn(c) {
      let (s0, loss, fl0) = c
      let w = rl_world(s0, loss, fl0)
      (w.s1.short_shares == 0 || w.s1.short_assets > 0) && (w.s1.long_shares == 0 || w.s1.long_assets > 0)
    },
  )
}

test round_numbers_burn_exactly_the_loss() {
  let (burned, wo, _) = conserve(golden_s0(), 460, 100, [500])
  burned == 460 && wo == 460
}

test awkward_numbers_burn_the_loss_within_the_rounding_bound() {
  let cases =
    [
      (rl_s0(7_001_003, 11_003_001, 13_007_009, 17_011_013, 101_001, 53_003, 3_001_007), 9_999_999, 17_001, [1_000_000, 1_000_003, 1_001_004]),
      (rl_s0(999_983_000, 1_000_003_007, 1_234_567_891, 2_345_671_233, 4_001_003, 7_919_011, 123_457_891), 999_999_937, 12_345_671, [100_000_001, 23_457_890]),
      (rl_s0(3_000_000, 5_000_000, 7_000_000, 11_000_000, 1_000, 1_000, 13_000_001), 29_000_003, 3_000_001, [7_000_000, 3_000_000, 3_000_001]),
      (rl_s0(10_000_000, 10_000_000, 0, 0, 0, 0, 1_000_000), 333_333, 0, [333_333, 333_333, 333_334]),
    ]
  list.all(
    cases,
    fn(c) {
      let (s0, loss, fl0, tickets) = c
      let (burned, wo, n) = conserve(s0, loss, fl0, tickets)
      let diff = burned - wo
      // never below the written-off backing; above it by dust of at most 2 per Ticket
      diff >= 0 && diff <= 2 * n
    },
  )
}

test the_burn_covers_the_whole_loss_when_everything_is_wiped_out() {
  // a loss beyond everything: every unit exposed is burned, the rest residual
  let s0 = rl_s0(1_000, 1_000, 2_000, 2_000, 5, 5, 500)
  let w = rl_world(s0, 5_000_000, 100)
  let idx = w.s1.loss_index
  let excess = 500 - ticket_payout(500, idx, loss_index_start)
  and {
    w.sp.qty + excess == w.sp.written_off,
    w.sp.written_off == 5 + 5 + 100 + 3_000 + 500,
    w.sp.residual == 5_000_000 - w.sp.written_off,
    idx == rules.min_loss_index,
  }
}

test attested_reserve_minus_minted_supply_is_unchanged_by_a_loss_and_its_claims() {
  // the invariant: the loss lowers the attestation by what it destroyed and
  // the supply by what is burned, so the backing ratio only moves by dust
  let cases =
    [
      (golden_s0(), 460, 100, [500]),
      (rl_s0(7_001_003, 11_003_001, 13_007_009, 17_011_013, 101_001, 53_003, 3_001_007), 9_999_999, 17_001, [1_000_000, 1_000_003, 1_001_004]),
      (rl_s0(10_000_000, 10_000_000, 0, 0, 0, 0, 1_000_000), 333_333, 0, [333_333, 333_333, 333_334]),
      (rl_s0(0, 0, 0, 0, 0, 0, 500), 100, 0, [500]),
    ]
  list.all(
    cases,
    fn(c) {
      let (s0, loss, fl0, tickets) = c
      let w = rl_world(s0, loss, fl0)
      let idx = w.s1.loss_index
      let excess =
        list.foldl(tickets, 0, fn(v, acc) { acc + v - ticket_payout(v, idx, loss_index_start) })
      let before = w.p0.attested_reserve - w.p0.minted_supply
      let after = w.p1.attested_reserve - (w.p1.minted_supply - excess)
      let n = list.length(tickets)
      after - before >= 0 && after - before <= 2 * n
    },
  )
}

test the_invariant_holds_when_the_attestation_is_clamped() {
  // the attestation is below the write-off: clamped at 0, nothing to compare
  let low = SupplyState { ..rl_p0(), attested_reserve: 400 }
  let w = rl_world_with(golden_s0(), 460, 100, rl_split(golden_s0(), 460, 100), rl_c0(), low)
  w.p1.attested_reserve == 0
}

test the_committee_cannot_mint_the_tickets_share_after_a_loss() {
  // headroom (attested - minted) falls by the Tickets' share the moment the
  // loss lands, before they claim: minting the old headroom is refused
  let roomy = SupplyState { ..rl_p0(), attested_reserve: 10_000_001_000 }
  let w = rl_world_with(golden_s0(), 460, 100, rl_split(golden_s0(), 460, 100), rl_c0(), roomy)
  let before = w.p0.attested_reserve - w.p0.minted_supply
  let after = w.p1.attested_reserve - w.p1.minted_supply
  and {
    before == 1_000,
    after == before - w.sp.r_tickets,
    after == 900,
    !rules.mint_allowed(w.p1.minted_supply, before, w.p1.attested_reserve, w.p0.mint_cap),
    rules.mint_allowed(w.p1.minted_supply, after, w.p1.attested_reserve, w.p0.mint_cap),
  }
}

test a_second_loss_sees_what_the_tickets_are_now_worth() {
  // two losses back to back on one Ticket: it bears the SECOND loss on what is
  // left of it, and the total burned still equals the total written off
  let s0 = rl_s0(600_000, 600_000, 400_000, 400_000, 0, 0, 500_000)
  let w1 = rl_world(s0, 300_000, 0)
  let w2 = rl_world(VaultState { ..w1.s1, epoch: 0 }, 300_000, 0)
  let idx2 = w2.s1.loss_index
  let payout = ticket_payout(500_000, idx2, loss_index_start)
  let excess = 500_000 - payout
  let burned = w1.sp.qty + w2.sp.qty + excess
  let written = w1.sp.written_off + w2.sp.written_off
  burned - written >= 0 && burned - written <= 4
}

test a_wiped_long_class_with_unvested_yield_sweeps_that_too() {
  let s0 = rl_s0(0, 0, 1_000_000, 500, 0, 90, 0)
  let w = rl_world(s0, 5, 0)
  w.s1.long_gen == 1 && w.s1.vest_long == 0 && w.sweep == 500 - w.sp.r_long + 90 - w.sp.u_long && rl_ok(w)
}

test report_yield_reads_the_spent_first_loss_balance_not_a_stale_reference() {
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  let stale = Input { output_reference: r(12), output: fl_out(999_999_999) }
  report(Transaction { ..tx, reference_inputs: list.concat(tx.reference_inputs, [stale]) })
}

test report_yield_against_a_first_loss_state_off_its_address_is_rejected() fail {
  // the reserve is full (balance at the 3% cap), so a correctly read State
  // needs no deposit and this transaction would pass; read from the wrong
  // address it must not be found
  let s0 = yield_s0()
  let s1 = vesting(s0, 3_888_889, 4_861_111)
  let tx = yield_with(s0, s1, 0, 1_250_000, [t_op1, t_op2])
  let moved = Input { ..fl_ref(300_000), output: Output { ..fl_out(300_000), address: key_addr(t_bob) } }
  report(Transaction { ..tx, reference_inputs: [reserve_ref(), supply_ref_with(10_000_000, True), moved] })
}

test f6_bounds_fixture_is_accepted() {
  bounds_ok_with(bounds_ok_tx())
}

test lock_of_exactly_twice_the_cooldown_is_accepted_by_set_bounds() {
  let s0 = yield_s0()
  spend_state(
    s0,
    OpsSetBounds { long_weight_bps: 13_000, short_cooldown_ms: 7 * day, long_lock_ms: 14 * day, protocol_bps: 1_250 },
    bounds_tx(s0, bounded(s0, 13_000, 7 * day, 14 * day, 1_250), [t_op1, t_op2]),
  )
}

test a_claim_without_the_config_is_rejected() {
  !claim_state_ok(t_ticket(54_000_000), loss_index_start, Transaction { ..good_claim_tx(), reference_inputs: [] })
}

test a_claim_against_a_planted_config_is_rejected() {
  let planted = reserve_ref_with(t_reserve_state(False, [t_bob, t_alice]), False)
  !claim_state_ok(t_ticket(54_000_000), loss_index_start, Transaction { ..good_claim_tx(), reference_inputs: [planted] })
}

test a_claim_against_the_supply_in_place_of_the_config_is_rejected() {
  !claim_state_ok(t_ticket(54_000_000), loss_index_start, Transaction { ..good_claim_tx(), reference_inputs: [supply_ref()] })
}

test no_other_ops_action_can_lower_the_loss_index() {
  let t = t_ticket(54_000_000)
  and {
    !claim_state_ok(t, loss_index_start, map_out(good_claim_tx(), 0, fn(_) { state_out(lowered(claim_s1(t, loss_index_start))) })),
    !bounds_ok_with(map_out(bounds_ok_tx(), 0, fn(o) { state_out(lowered(bounded(yield_s0(), 13_000, 7 * day, 30 * day, 1_250))) })),
  }
}

test the_claim_fixture_is_accepted_by_vault_ops() {
  let f = loss_fixture.claim_fixture()
  vault_ops.withdraw(
    loss_fixture.reserve_policy,
    OpsRedeemer { vault: loss_fixture.vault_policy, action: OpsClaim },
    Script(loss_fixture.vault_ops_policy),
    Transaction { ..f.tx, withdrawals: [Pair(Script(loss_fixture.vault_ops_policy), 0)] },
  )
}

test the_worst_case_fixture_is_accepted_by_vault_ops() {
  let f = loss_fixture.fixture()
  vault_ops.withdraw(
    loss_fixture.reserve_policy,
    OpsRedeemer { vault: loss_fixture.vault_policy, action: OpsReportLoss { loss: f.loss } },
    Script(loss_fixture.vault_ops_policy),
    Transaction { ..f.tx, withdrawals: [Pair(Script(loss_fixture.vault_ops_policy), 0)] },
  )
}

// -- The withdrawal is a gate (Phase 2.5b, SPEC.md 3a.15)

fn ops_run(tx: Transaction, vault: PolicyId, action: OpsAction, w: List<Pair<Credential, Int>>) -> Bool {
  vault_ops.withdraw(
    t_reserve,
    OpsRedeemer { vault, action },
    Script(t_ops),
    Transaction { ..tx, withdrawals: w },
  )
}

fn bounds_action() -> OpsAction {
  OpsSetBounds {
    long_weight_bps: 13_000,
    short_cooldown_ms: 7 * day,
    long_lock_ms: 30 * day,
    protocol_bps: 1_250,
  }
}

test an_ops_run_with_a_zero_withdrawal_is_accepted() {
  ops_run(bounds_ok_tx(), t_own, bounds_action(), [Pair(Script(t_ops), 0)])
}

test an_ops_run_with_a_non_zero_withdrawal_is_rejected() {
  !ops_run(bounds_ok_tx(), t_own, bounds_action(), [Pair(Script(t_ops), 1)]) && !ops_run(
    bounds_ok_tx(),
    t_own,
    bounds_action(),
    [Pair(Script(t_ops), 1_000_000)],
  )
}

test an_ops_run_without_its_withdrawal_entry_is_rejected() {
  !ops_run(bounds_ok_tx(), t_own, bounds_action(), []) && !ops_run(
    bounds_ok_tx(),
    t_own,
    bounds_action(),
    [Pair(Script(t_reserve), 0)],
  )
}

test an_ops_run_naming_another_vault_finds_no_state() fail {
  ops_run(bounds_ok_tx(), t_fl, bounds_action(), [Pair(Script(t_ops), 0)])
}

test an_ops_run_for_a_different_action_than_the_transaction_is_rejected() fail {
  // a SetBounds transaction judged as a ReportYield (the State's next datum
  // is not what a yield produces)
  ops_run(bounds_ok_tx(), t_own, OpsReportYield { gross: 10_000_000 }, [Pair(Script(t_ops), 0)])
}

test an_ops_run_for_a_loss_on_a_bounds_transaction_is_rejected() fail {
  ops_run(bounds_ok_tx(), t_own, OpsReportLoss { loss: 10 }, [Pair(Script(t_ops), 0)])
}

test an_ops_run_for_a_claim_on_a_bounds_transaction_is_rejected() fail {
  ops_run(bounds_ok_tx(), t_own, OpsClaim, [Pair(Script(t_ops), 0)])
}

// -- The publish handler: registration only

type DelegateM {
  DelegateBlockM { stake_pool: ByteArray }
  DelegateVoteM { drep: DrepM }
}

type DrepM {
  RegisteredM(Credential)
  AlwaysAbstainM
}

type CertMirror {
  RegisterM { credential: Credential, deposit: Option<Int> }
  UnregisterM { credential: Credential, refund: Option<Int> }
  DelegateM { credential: Credential, delegate: DelegateM }
  RegisterDelegateM { credential: Credential, delegate: DelegateM, deposit: Int }
  RegisterDrepM { credential: Credential, deposit: Int }
  UpdateDrepM { credential: Credential }
  UnregisterDrepM { credential: Credential, refund: Int }
}

fn cert(m: CertMirror) -> Certificate {
  let d: Data = m
  expect c: Certificate = d
  c
}

fn published(m: CertMirror) -> Bool {
  vault_ops.publish(t_reserve, Void, cert(m), transaction.placeholder)
}

test registering_the_ops_credential_is_accepted() {
  published(RegisterM { credential: Script(t_ops), deposit: None })
}

test unregistering_the_ops_credential_is_rejected() {
  !published(UnregisterM { credential: Script(t_ops), refund: None })
}

test delegating_the_ops_credential_is_rejected() {
  !published(DelegateM { credential: Script(t_ops), delegate: DelegateBlockM { stake_pool: #"abababababababababababababababababababababababababababab" } })
}

test registering_and_delegating_the_ops_credential_is_rejected() {
  !published(RegisterDelegateM { credential: Script(t_ops), delegate: DelegateBlockM { stake_pool: #"abababababababababababababababababababababababababababab" }, deposit: 2_000_000 })
}

test no_other_certificate_is_accepted() {
  !published(RegisterDrepM { credential: Script(t_ops), deposit: 500_000_000 }) && !published(
    UpdateDrepM { credential: Script(t_ops) },
  ) && !published(UnregisterDrepM { credential: Script(t_ops), refund: 500_000_000 })
}

test delegating_the_ops_credential_to_a_drep_is_rejected() {
  !published(DelegateM { credential: Script(t_ops), delegate: DelegateVoteM { drep: AlwaysAbstainM } })
}

test a_zero_yield_that_is_otherwise_correct_is_rejected() {
  let s0 = yield_s0()
  let s1 = vesting(s0, 0, 0)
  let tx = yield_with(s0, s1, 0, 0, [t_op1, t_op2])
  !spend_state(s0, OpsReportYield { gross: 0 }, tx)
}

test set_bounds_keeps_the_state_pinned() {
  let s0 = yield_s0()
  let ok = bounds_tx(s0, bounded(s0, 13_000, 7 * day, 30 * day, 1_250), [t_op1, t_op2])
  and {
    bounds_ok_with(ok),
    !bounds_ok_with(map_out(ok, 0, staked)),
    !bounds_ok_with(map_out(ok, 0, with_ref_script)),
    !bounds_ok_with(map_out(ok, 0, fn(o) { lovelace_delta(o, -1) })),
    !bounds_ok_with(map_out(ok, 0, fn(o) { Output { ..o, value: o.value |> assets.add(t_op1, "junk", 1) } })),
    !bounds_ok_with(map_out(ok, 0, fn(o) { Output { ..o, value: o.value |> assets.merge(tsra(t_reserve, 1)) } })),
  }
}

test a_claim_keeps_the_state_pinned() {
  let t = t_ticket(54_000_000)
  let ok = good_claim_tx()
  and {
    claim_state_ok(t, loss_index_start, ok),
    !claim_state_ok(t, loss_index_start, map_out(ok, 0, staked)),
    !claim_state_ok(t, loss_index_start, map_out(ok, 0, with_ref_script)),
    !claim_state_ok(t, loss_index_start, map_out(ok, 0, fn(o) { lovelace_delta(o, -1) })),
    !claim_state_ok(t, loss_index_start, map_out(ok, 0, fn(o) { Output { ..o, value: o.value |> assets.add(t_op1, "junk", 1) } })),
  }
}
