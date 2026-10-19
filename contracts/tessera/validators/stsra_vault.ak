//// sTSRA vault (Phase 2.4, SPEC.md §3; loss path in Phase 2.5b, §3a).
////
//// One script, parameterised by `(seed, reserve)`, is the spending validator
//// for the vault State, long-tier Positions and cooldown Tickets, and the
//// minting policy for `state` (one-shot thread token), `sTSRA` (fungible
//// short-tier shares) and `position` (the marker in every Position and
//// Ticket, the Phase 1 F-4 lesson).
////
//// * Two share classes in one State: short (sTSRA) and long (Positions).
//// * ReportYield splits net yield by weighted assets (`vault_state.split_yield`);
////   the protocol cut is paid out in TSRA: the first-loss reserve's half goes
////   into the first-loss State (stopping at 3% of the minted supply, the
////   overflow to the treasury), the rest to the treasury.
//// * Unstaking escrows the request-time value in a Ticket (`ticket_escrow`
////   tracks the Tickets' current value); a Claim pays `value * loss_index_now / index_at_request`,
////   never more than `value`, and burns the excess.
//// * Committee, `kyc_stake` and the "loss pending" freeze are read live from
////   the genuine Reserve Config (reference input). The datum is PROVISIONAL.
//// * Only ReportLoss may ever lower a price (`lib/tessera/loss.ak`): unvested
////   yield first, then the first-loss reserve, then stakers and open Tickets
////   pro rata. A class wiped out by it restarts as a new generation.
//// * Hardening (Phase 2-H, SPEC.md §3.15): reported yield vests into the
////   prices over 7 days, booked at the validity lower bound; stakes price at
////   the upper bound, exits at the lower bound. Long lock >= 2x cooldown.
////   UnlockLong needs the owner. Claim and UnlockLong pay the spent UTxO's
////   ADA to the owner. Every continuing or new vault output keeps the
////   State's address and carries no reference script (AUDIT.md F-6).

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
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
  Claim, Position, PositionDatum, ReportLoss, ReportYield, RequestUnstake,
  SetBounds, StakeLong, StakeShort, StateDatum, Ticket, TicketDatum,
  UnlockLong, VaultDatum, VaultRedeemer, VaultState, bounds_ok, fold,
  long_assets_at, loss_index_start, short_assets_at, split_yield, stsra_name,
  stsra_name_of, ticket_payout, vest_period_ms,
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

/// Staking gate: no freeze in force; with the Config's `kyc_stake` switch on,
/// `holder` must pass the one eligibility check.
fn kyc_stake_ok(tx: Transaction, reserve: PolicyId, holder: ByteArray, lo: Int) -> Bool {
  when open_config(tx, reserve, lo) is {
    Some(r) -> !r.kyc_stake || eligible(tx, r.eligibility_policy, holder)
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

/// `amount` TSRA leave the State into the first-loss State in this
/// transaction: it is spent and returned with the balance raised by `amount`
/// (the first-loss validator checks the TSRA really arrived). `amount == 0`
/// needs nothing.
fn sweep_ok(tx: Transaction, first_loss: PolicyId, amount: Int) -> Bool {
  amount == 0 || when first_loss_spent(tx, first_loss) is {
    Some(a) -> first_loss_moves(tx, first_loss, a.balance, a.balance + amount)
    None -> False
  }
}

/// A valid genesis State: empty books, the starting loss index, bounds within
/// their hard limits, a first-loss policy id and a treasury address that are
/// not the vault.
fn genesis_ok(s: VaultState, policy: PolicyId) -> Bool {
  and {
    s.short_shares == 0,
    s.short_assets == 0,
    s.long_shares == 0,
    s.long_assets == 0,
    s.loss_index == loss_index_start,
    s.ticket_escrow == 0,
    s.short_gen == 0,
    s.long_gen == 0,
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
    bytearray.length(s.first_loss) == 28,
    s.first_loss != policy,
    s.treasury_addr.payment_credential != Script(policy),
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

fn clamp0(x: Int) -> Int {
  if x < 0 {
    0
  } else {
    x
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
        kyc_stake_ok(tx, reserve, holder, lo),
        own_mint(tx, policy) == assets.from_asset(
          policy,
          stsra_name_of(sf.short_gen),
          minted,
        ),
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
        kyc_stake_ok(tx, reserve, holder, lo),
        // a Position owned by the vault itself could never be paid out
        owner.payment_credential != Script(policy),
        vault_datum(pos) == Some(
          PositionDatum(
            Position {
              owner,
              shares: minted,
              unlock_at: hi + s0.long_lock_ms,
              gen: sf.long_gen,
            },
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

    // Exits price at `lo`: only yield vested by then is paid out. The last
    // share out also sweeps the class's still-vesting yield to the first-loss
    // reserve (D-19), so the next first staker cannot capture it.
    RequestUnstake { shares, owner } -> {
      expect Some(ticket) = other_output(outs, next_out)
      let v = exchange.redeem_value(shares, sf.short_shares, sf.short_assets)
      let sweep =
        if shares >= sf.short_shares {
          sf.vest_short
        } else {
          0
        }
      and {
        common,
        list.length(ins) == 1,
        list.length(outs) == 2,
        shares > 0,
        shares <= sf.short_shares,
        v >= exchange.min_position_value,
        exits_open(tx, reserve, lo),
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
          assets.from_asset(policy, stsra_name_of(sf.short_gen), -shares),
        ),
        sweep_ok(tx, s0.first_loss, sweep),
        s1 == VaultState {
          ..sf,
          short_shares: sf.short_shares - shares,
          short_assets: sf.short_assets - v,
          vest_short: sf.vest_short - sweep,
          ticket_escrow: s0.ticket_escrow + v,
          epoch: s0.epoch + 1,
        },
      }
    }

    // A Position of an older generation (its class was wiped out by a loss)
    // pays 0 TSRA, but still returns its lovelace to the owner and burns its
    // marker.
    UnlockLong -> {
      expect [pos] = list.filter(ins, fn(o) { o != state_in })
      expect Some(PositionDatum(p)) = vault_datum(pos)
      let live = p.gen == sf.long_gen
      let payout =
        if live {
          exchange.redeem_value(p.shares, sf.long_shares, sf.long_assets)
        } else {
          0
        }
      let sweep =
        if live && p.shares >= sf.long_shares {
          sf.vest_long
        } else {
          0
        }
      and {
        common,
        list.length(ins) == 2,
        list.length(outs) == 1,
        exits_open(tx, reserve, lo),
        position_value_ok(pos, policy),
        lo >= p.unlock_at,
        // H2.3: a Position keeps earning after `unlock_at`, so only its
        // owner may end it.
        owner_authorised(tx, p.owner),
        own_mint(tx, policy) == assets.from_asset(policy, marker_name, -1),
        owner_paid(tx, p.owner, reserve, payout, pos),
        sweep_ok(tx, s0.first_loss, sweep),
        s1 == VaultState {
          ..sf,
          long_shares: if live {
            sf.long_shares - p.shares
          } else {
            sf.long_shares
          },
          long_assets: sf.long_assets - payout,
          vest_long: sf.vest_long - sweep,
          epoch: s0.epoch + 1,
        },
      }
    }

    // The yield is weighted by each class's whole TSRA (booked + vesting),
    // and vests from max(lo, vest_from) over `vest_period_ms`, together with
    // whatever had not vested yet. The committee window is at most one day,
    // so `lo` cannot be backdated to vest the yield early. Half the protocol
    // cut goes to the first-loss State until it holds 3% of the minted supply
    // (D-10); what it cannot take goes to the treasury.
    ReportYield { gross } -> {
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

    // A Claim spends the State (to lower `ticket_escrow`) and the one Ticket,
    // and nothing else. The Ticket's own validator pays the owner and checks
    // the excess burn. No fold: nothing is priced. `ticket_escrow` tracks the
    // Tickets' CURRENT value (what a Claim would pay), so it falls by the
    // payout: the excess was written off by an earlier ReportLoss, which
    // already took it out of the escrow. Rounding dust can leave the escrow a
    // few units short of the last payout, hence the clamp at zero.
    Claim -> {
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
    ReportLoss { loss } -> {
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

// ---------------------------------------------------------------- Ticket

/// Claim: after the cooldown, pay `owner` the escrowed value scaled by the
/// loss index (never more than the escrow), burn the marker, and burn EXACTLY
/// the excess (through the reserve's `VaultClaimBurn`, which the reserve's
/// mint handler lets through only with the genuine Supply spent). Spends the
/// genuine State (whose `Claim` branch lowers `ticket_escrow`) and this Ticket,
/// and nothing else. Permissionless (a Ticket earns nothing, so an early Claim
/// costs its owner nothing); the owner also gets the Ticket's ADA (H2.3).
fn claim(
  t: Ticket,
  own: Output,
  tx: Transaction,
  policy: PolicyId,
  reserve: PolicyId,
  ins: List<Output>,
) -> Bool {
  expect Some((lo, _hi)) = finite_bounds(tx)
  expect Some((_, s)) = sole_state(ins, policy)
  let payout = ticket_payout(t.value, s.loss_index, t.index_at_request)
  let excess = t.value - payout
  and {
    list.length(ins) == 2,
    list.length(own_outputs(tx.outputs, policy)) == 1,
    ticket_value_ok(own, policy, reserve, t.value),
    lo >= t.claim_after,
    own_mint(tx, policy) == assets.from_asset(policy, marker_name, -1),
    owner_paid(tx, t.owner, reserve, payout, own),
    quantity_of(tx.mint, reserve, rules.tsra_name) == -excess,
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

test genesis_with_the_first_loss_policy_equal_to_the_vault_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), first_loss: t_own })
}

test genesis_with_a_short_first_loss_policy_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), first_loss: #"f1f1" })
}

test genesis_with_the_treasury_at_the_vault_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), treasury_addr: vault_addr() })
}

test genesis_with_a_long_first_loss_policy_is_rejected() {
  !boot(
    VaultState {
      ..t_vs(0, 0, 0, 0),
      first_loss: #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1",
    },
  )
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
    genesis_tx([state_out(t_vs(0, 0, 0, 0)), pos_out(Position(key_addr(t_alice), 1, 0, 0))]),
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
  let extra = pos_out(Position(key_addr(t_alice), 1, 0, 0))
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
    [state_out(s1), pos_out(Position(key_addr(t_alice), minted, unlock_at, 0))],
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
      ticket_escrow: s0.ticket_escrow + v,
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
  // replay: the claim may not leave anything behind at the vault but the State
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
      inputs: [state_in(claim_s0(t, loss_index_start)), planted],
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
      inputs: [state_in(claim_s0(t, loss_index_start)), ticket_in(t), second],
    }
  !claim_ok(t, tx)
}

test claim_against_a_planted_vault_state_is_rejected() fail {
  let t = t_ticket(54_000_000)
  let planted =
    Input {
      output_reference: r(0),
      output: state_out_with(claim_s0(t, loss_index_start * 2), False),
    }
  let tx =
    Transaction {
      ..claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1)),
      inputs: [planted, ticket_in(t)],
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
  Position { owner: key_addr(t_alice), shares, unlock_at: 1_500_000, gen: 0 }
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
  !spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

test report_yield_of_zero_is_rejected() {
  let s0 = yield_s0()
  let tx = vtx([state_in(s0)], [state_out(bump(s0))], assets.zero, [t_op1, t_op2])
  !spend_state(
    s0,
    ReportYield { gross: 0 },
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

test the_state_branch_refuses_a_claim_without_a_ticket() fail {
  let s0 = t_vs(0, 0, 0, 0)
  spend_state(s0, Claim, stake_short(s0, 10_000_000, 10_000_000))
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
  !report(Transaction { ..tx, inputs: [state_in(yield_s0()), fl_in(0), some_position()] })
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
  !report(Transaction { ..tx, reference_inputs: [moved, supply_ref(), fl_ref(0)] })
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
      ticket_escrow: v,
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
      yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2]),
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
      yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2]),
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
  let p = Position { owner, shares: 40_000_000, unlock_at: 1_500_000, gen: 0 }
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
  let p = Position(vault_addr(), 10_000_000, t_hi + 30 * day, 0)
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
  let p = Position(key_addr(t_alice), minted, four_sevenths + 30 * day, 0)
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

// -- Phase 2.5a: the vault reads the Config, never the Supply

test short_stake_against_a_supply_datum_under_the_config_token_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let wrong_kind =
    Input {
      ..reserve_ref(),
      output: Output {
        ..reserve_ref().output,
        datum: InlineDatum(
          SupplyDatum(
            SupplyState {
              minted_supply: 0,
              attested_reserve: 0,
              mint_cap: 0,
              attestation_epoch: 0,
              attested_at: 0,
              epoch: 0,
            },
          ),
        ),
      },
    }
  let tx = Transaction { ..stake_short(s0, 10_000_000, 10_000_000), reference_inputs: [wrong_kind] }
  !short(s0, 10_000_000, tx)
}

test short_stake_against_the_supply_utxo_in_place_of_the_config_is_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let supply_token =
    Input {
      ..reserve_ref(),
      output: Output {
        ..reserve_ref().output,
        value: ada() |> assets.merge(supply_value(t_reserve)),
      },
    }
  let tx = Transaction { ..stake_short(s0, 10_000_000, 10_000_000), reference_inputs: [supply_token] }
  !short(s0, 10_000_000, tx)
}

test report_yield_against_the_supply_utxo_in_place_of_the_config_is_rejected() {
  let tx = yield_tx(3_888_889, 4_861_111, 625_000, 625_000, [t_op1, t_op2])
  // the genuine Supply UTxO where the Config should be: no Config at all
  !report(Transaction { ..tx, reference_inputs: [supply_ref(), fl_ref(0)] })
}

// ====================================================================
// Phase 2.5b: ticket_escrow, Claim as a State transition, the freeze,
// generations, the last-exit sweep, the 3% funding cap
// ====================================================================

// -- ticket_escrow on RequestUnstake

test unstake_raises_the_escrow_by_exactly_the_value() {
  let s0 = unstake_ok_s0()
  let ok = unstake_ok_tx()
  let go = fn(te: Int) {
    unstake_ok(map_out(ok, 0, fn(o) { state_out(VaultState { ..bump(s0), short_shares: 50_000_000, short_assets: 108_000_000 - 54_000_000, ticket_escrow: te }) }))
  }
  go(54_000_000) && !go(54_000_001) && !go(53_999_999) && !go(0)
}

test an_unstake_that_leaves_the_escrow_alone_is_rejected() {
  let s0 = unstake_ok_s0()
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 50_000_000,
      short_assets: 54_000_000,
    }
  !unstake_ok(map_out(unstake_ok_tx(), 0, fn(_) { state_out(s1) }))
}

test unstake_adds_to_an_existing_escrow() {
  let s0 = VaultState { ..unstake_ok_s0(), ticket_escrow: 7_000_000 }
  let tx = unstake_tx(s0, 50_000_000, 54_000_000, t_ticket(54_000_000))
  unstake(s0, 50_000_000, tx) && !unstake(
    s0,
    50_000_000,
    map_out(
      tx,
      0,
      fn(_) {
        state_out(
          VaultState {
            ..bump(s0),
            short_shares: 50_000_000,
            short_assets: 54_000_000,
            ticket_escrow: 54_000_000,
          },
        )
      },
    ),
  )
}

// -- Claim: the State branch

fn claim_state_ok(t: Ticket, index_now: Int, tx: Transaction) -> Bool {
  spend_state(claim_s0(t, index_now), Claim, tx)
}

/// Both script runs of a real Claim transaction.
fn claim_both(t: Ticket, index_now: Int, tx: Transaction) -> Bool {
  claim_ok(t, tx) && claim_state_ok(t, index_now, tx)
}

fn good_claim_tx() -> Transaction {
  claim_tx(t_ticket(54_000_000), loss_index_start, [pay(key_addr(t_alice), 54_000_000)], marker(-1))
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
  spend_state(s0, Claim, tx(0)) && !spend_state(s0, Claim, tx(-1)) && !spend_state(s0, Claim, tx(53_999_999))
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

test the_ticket_claim_needs_the_state_spent() fail {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  claim_ok(t, Transaction { ..tx, inputs: [ticket_in(t)], outputs: [pay(key_addr(t_alice), 54_000_000)] })
}

test the_ticket_claim_rejects_a_planted_state() fail {
  let t = t_ticket(54_000_000)
  let tx = good_claim_tx()
  let planted = Input { output_reference: r(0), output: state_out_with(claim_s0(t, loss_index_start), False) }
  claim_ok(t, Transaction { ..tx, inputs: [planted, ticket_in(t)] })
}

test a_claim_reads_the_loss_index_from_the_spent_state() {
  // the same Ticket against a State at half the index pays half and burns half
  let t = t_ticket(54_000_000)
  let at_half = claim_tx(t, loss_index_start / 2, [pay(key_addr(t_alice), 27_000_000)], marker(-1) |> assets.merge(tsra(t_reserve, -27_000_000)))
  let at_par = claim_tx(t, loss_index_start, [pay(key_addr(t_alice), 27_000_000)], marker(-1) |> assets.merge(tsra(t_reserve, -27_000_000)))
  claim_ok(t, at_half) && !claim_ok(t, at_par)
}

test a_claim_must_burn_exactly_the_excess() {
  let t = t_ticket(54_000_000)
  let half_index = loss_index_start / 2
  let go = fn(burn: Int) {
    claim_ok(
      t,
      claim_tx(
        t,
        half_index,
        [pay(key_addr(t_alice), 27_000_000)],
        marker(-1) |> assets.merge(tsra(t_reserve, burn)),
      ),
    )
  }
  go(-27_000_000) && !go(-27_000_001) && !go(-26_999_999) && !go(0) && !go(27_000_000)
}

test a_claim_without_an_excess_burns_nothing() {
  let t = t_ticket(54_000_000)
  let go = fn(burn: Int) {
    claim_ok(
      t,
      claim_tx(
        t,
        loss_index_start,
        [pay(key_addr(t_alice), 54_000_000)],
        marker(-1) |> assets.merge(tsra(t_reserve, burn)),
      ),
    )
  }
  go(0) && !go(-1) && !go(1)
}

test the_excess_and_the_payout_add_up_to_the_escrow() {
  let cases =
    [
      (54_000_000, 1_000_000_000_000, 500_000_000_000),
      (54_000_001, 1_000_000_000_000, 333_333_333_333),
      (123_456_789, 999_999_999_999, 777_777_777_777),
      (2_000_000, 1_000_000_000_000, rules.min_loss_index),
      (5, 3, 1),
    ]
  list.all(
    cases,
    fn(c) {
      let (v, req, now) = c
      let payout = ticket_payout(v, now, req)
      payout >= 0 && payout <= v && v - payout >= 0
    },
  )
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

test a_claim_ticket_cannot_be_charged_more_than_the_index_ratio() {
  // 54M at 4/5 of the index owes 43.2M: 43_200_001 is too much to demand burned
  let t = Ticket { ..t_ticket(54_000_000), index_at_request: 1_000_000_000_000 }
  let idx = 800_000_000_000
  let burn = fn(b: Int) {
    claim_ok(
      t,
      claim_tx(
        t,
        idx,
        [pay(key_addr(t_alice), 54_000_000 + b)],
        marker(-1) |> assets.merge(tsra(t_reserve, b)),
      ),
    )
  }
  burn(-10_800_000) && !burn(-10_800_001) && !burn(-10_799_999)
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

test a_short_stake_is_frozen_until_the_freeze_ends() {
  let s0 = t_vs(0, 0, 0, 0)
  let tx = stake_short(s0, 10_000_000, 10_000_000)
  and {
    short(s0, 10_000_000, frozen_at(tx, 0)),
    short(s0, 10_000_000, frozen_at(tx, t_lo)),
    !short(s0, 10_000_000, frozen_at(tx, t_lo + 1)),
    !short(s0, 10_000_000, frozen_at(tx, t_hi)),
    !short(s0, 10_000_000, frozen_at(tx, t_hi + 1_000_000)),
  }
}

test a_long_stake_is_frozen_until_the_freeze_ends() {
  and {
    long_ok(frozen_at(long_ok_tx(), t_lo)),
    !long_ok(frozen_at(long_ok_tx(), t_lo + 1)),
    !long_ok(frozen_at(long_ok_tx(), t_hi)),
  }
}

test an_unstake_request_is_frozen_until_the_freeze_ends() {
  and {
    unstake_ok(frozen_at(unstake_ok_tx(), 0)),
    unstake_ok(frozen_at(unstake_ok_tx(), t_lo)),
    !unstake_ok(frozen_at(unstake_ok_tx(), t_lo + 1)),
    !unstake_ok(frozen_at(unstake_ok_tx(), t_hi)),
  }
}

test an_unlock_is_frozen_until_the_freeze_ends() {
  // the unlock fixture's lower bound is the position's unlock_at, 1_500_000
  and {
    unlock_ok(frozen_at(unlock_ok_tx(), 1_500_000)),
    !unlock_ok(frozen_at(unlock_ok_tx(), 1_500_001)),
    !unlock_ok(frozen_at(unlock_ok_tx(), 9_999_999_999)),
  }
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

test a_lapsed_freeze_unfreezes_everything_with_no_committee_action() {
  // `until` in the past: nothing to cancel, every action is open
  let s0 = t_vs(0, 0, 0, 0)
  let old = t_lo - 1
  and {
    short(s0, 10_000_000, frozen_at(stake_short(s0, 10_000_000, 10_000_000), old)),
    unstake_ok(frozen_at(unstake_ok_tx(), old)),
    long_ok(frozen_at(long_ok_tx(), old)),
  }
}

test exits_and_stakes_without_the_config_are_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let none = fn(tx: Transaction) { Transaction { ..tx, reference_inputs: [] } }
  and {
    !short(s0, 10_000_000, none(stake_short(s0, 10_000_000, 10_000_000))),
    !long_ok(none(long_ok_tx())),
    !unstake_ok(none(unstake_ok_tx())),
    !unlock_ok(none(unlock_ok_tx())),
    !claim_state_ok(t_ticket(54_000_000), loss_index_start, none(good_claim_tx())),
  }
}

test exits_and_stakes_against_a_planted_config_are_rejected() {
  let s0 = t_vs(0, 0, 0, 0)
  let planted = reserve_ref_with(t_reserve_state(False, [t_bob, t_alice]), False)
  let swap = fn(tx: Transaction) { Transaction { ..tx, reference_inputs: [planted] } }
  and {
    !short(s0, 10_000_000, swap(stake_short(s0, 10_000_000, 10_000_000))),
    !long_ok(swap(long_ok_tx())),
    !unstake_ok(swap(unstake_ok_tx())),
    !unlock_ok(swap(unlock_ok_tx())),
    !claim_state_ok(t_ticket(54_000_000), loss_index_start, swap(good_claim_tx())),
  }
}

test exits_against_the_supply_in_place_of_the_config_are_rejected() {
  let tx_in = fn(tx: Transaction) { Transaction { ..tx, reference_inputs: [supply_ref()] } }
  and {
    !unstake_ok(tx_in(unstake_ok_tx())),
    !unlock_ok(tx_in(unlock_ok_tx())),
    !claim_state_ok(t_ticket(54_000_000), loss_index_start, tx_in(good_claim_tx())),
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

test a_stake_priced_below_the_freeze_is_still_checked_for_kyc() {
  // the freeze is open, KYC is on, nobody is eligible
  let s0 = t_vs(0, 0, 0, 0)
  let on =
    reserve_ref_with(
      ConfigState { ..t_reserve_state(True, [t_op1, t_op2]), loss_pending_until: t_lo },
      True,
    )
  !short(s0, 10_000_000, Transaction { ..stake_short(s0, 10_000_000, 10_000_000), reference_inputs: [on] })
}

// -- a price can fall only via ReportLoss

fn lowered(s: VaultState) -> VaultState {
  VaultState { ..s, loss_index: s.loss_index - 1 }
}

test no_other_redeemer_can_lower_the_loss_index() {
  let sh = t_vs(0, 0, 0, 0)
  let t = t_ticket(54_000_000)
  and {
    !short(
      sh,
      10_000_000,
      map_out(
        stake_short(sh, 10_000_000, 10_000_000),
        0,
        fn(_) { state_out(lowered(VaultState { ..bump(sh), short_shares: 10_000_000, short_assets: 10_000_000 })) },
      ),
    ),
    !unstake_ok(
      map_out(
        unstake_ok_tx(),
        0,
        fn(_) {
          state_out(
            lowered(
              VaultState {
                ..bump(unstake_ok_s0()),
                short_shares: 50_000_000,
                short_assets: 54_000_000,
                ticket_escrow: 54_000_000,
              },
            ),
          )
        },
      ),
    ),
    !claim_state_ok(t, loss_index_start, map_out(good_claim_tx(), 0, fn(_) { state_out(lowered(claim_s1(t, loss_index_start))) })),
    !bounds_ok_with(map_out(bounds_ok_tx(), 0, fn(o) { state_out(lowered(bounded(yield_s0(), 13_000, 7 * day, 30 * day, 1_250))) })),
  }
}

test no_other_redeemer_can_lower_a_class_price() {
  // one unit less booked for the same shares on every other redeemer
  let go = fn(tx: Transaction, s0: VaultState, rd: VaultRedeemer) { spend_state(s0, rd, tx) }
  let sh = t_vs(10_000_000, 10_000_000, 0, 0)
  let stake_tx = stake_short(sh, 10_000_000, 10_000_000)
  let cheat =
    map_out(
      stake_tx,
      0,
      fn(_) {
        state_out(
          VaultState {
            ..bump(sh),
            short_shares: 20_000_000,
            short_assets: 19_999_999,
          },
        )
      },
    )
  !go(cheat, sh, StakeShort { amount: 10_000_000, holder: t_alice })
}

// -- generations

fn gen1_name() -> ByteArray {
  stsra_name_of(1)
}

fn stsra_gen(gen: Int, q: Int) -> Value {
  assets.from_asset(t_own, stsra_name_of(gen), q)
}

test generation_zero_is_plain_stsra_and_later_ones_are_distinct() {
  and {
    stsra_name_of(0) == "sTSRA",
    stsra_name_of(1) != "sTSRA",
    stsra_name_of(1) != stsra_name_of(2),
    bytearray.length(stsra_name_of(1)) == 9,
  }
}

test a_short_stake_after_a_wipe_mints_the_new_generation() {
  let s0 = VaultState { ..t_vs(0, 0, 0, 0), short_gen: 1 }
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 10_000_000,
      short_assets: 10_000_000,
    }
  let tx = vtx([state_in(s0)], [state_out(s1)], stsra_gen(1, 10_000_000), [])
  let old_name = vtx([state_in(s0)], [state_out(s1)], stsra(10_000_000), [])
  short(s0, 10_000_000, tx) && !short(s0, 10_000_000, old_name)
}

test an_unstake_after_a_wipe_burns_the_new_generation_only() {
  let s0 = VaultState { ..t_vs(100_000_000, 108_000_000, 0, 0), short_gen: 1 }
  let t = t_ticket(54_000_000)
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 50_000_000,
      short_assets: 54_000_000,
      ticket_escrow: 54_000_000,
    }
  let new_gen =
    vtx([state_in(s0)], [state_out(s1), ticket_out(t)], marker(1) |> assets.merge(stsra_gen(1, -50_000_000)), [])
  let old_gen =
    vtx([state_in(s0)], [state_out(s1), ticket_out(t)], marker(1) |> assets.merge(stsra(-50_000_000)), [])
  unstake(s0, 50_000_000, new_gen) && !unstake(s0, 50_000_000, old_gen)
}

test old_generation_shares_cannot_be_unstaked_into_the_new_class() {
  // generation 0 shares against the generation 1 class
  let s0 = VaultState { ..t_vs(20_000_000, 20_000_000, 0, 0), short_gen: 1 }
  let t = t_ticket(10_000_000)
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 10_000_000,
      short_assets: 10_000_000,
      ticket_escrow: 10_000_000,
    }
  let tx =
    vtx([state_in(s0)], [state_out(s1), ticket_out(t)], marker(1) |> assets.merge(stsra(-10_000_000)), [])
  !unstake(s0, 10_000_000, tx)
}

test a_long_stake_records_the_live_generation() {
  let s0 = VaultState { ..t_vs(0, 0, 0, 0), long_gen: 2 }
  let s1 = VaultState { ..bump(s0), long_shares: 10_000_000, long_assets: 10_000_000 }
  let good = Position(key_addr(t_alice), 10_000_000, t_hi + 30 * day, 2)
  let stale = Position(key_addr(t_alice), 10_000_000, t_hi + 30 * day, 0)
  let tx = fn(p: Position) { vtx([state_in(s0)], [state_out(s1), pos_out(p)], marker(1), []) }
  long(s0, 10_000_000, tx(good)) && !long(s0, 10_000_000, tx(stale))
}

fn old_gen_unlock(payout: Int, p: Position) -> Bool {
  // class L was wiped out: generation 1 now holds 50 shares / 60 TSRA
  let s0 = VaultState { ..t_vs(0, 0, 50_000_000, 60_000_000), long_gen: 1 }
  let s1 =
    VaultState {
      ..bump(s0),
      long_assets: s0.long_assets - payout,
    }
  let tx =
    Transaction {
      ..vtx([state_in(s0), pos_in(p)], [state_out(s1), pay(key_addr(t_alice), payout)], marker(-1), [t_alice]),
      validity_range: interval.between(p.unlock_at, p.unlock_at + 1_000),
    }
  spend_state(s0, UnlockLong, tx)
}

test an_old_generation_position_unlocks_for_nothing() {
  let old = Position { ..t_pos(40_000_000), gen: 0 }
  old_gen_unlock(0, old)
}

test an_old_generation_position_cannot_take_tsra() {
  let old = Position { ..t_pos(40_000_000), gen: 0 }
  !old_gen_unlock(1, old) && !old_gen_unlock(48_000_000, old)
}

test an_old_generation_position_returns_its_lovelace_to_the_owner() {
  let old = Position { ..t_pos(40_000_000), gen: 0 }
  let s0 = VaultState { ..t_vs(0, 0, 50_000_000, 60_000_000), long_gen: 1 }
  let s1 = bump(s0)
  let keep = lovelace_delta(pay(key_addr(t_alice), 0), -1)
  let tx =
    Transaction {
      ..vtx([state_in(s0), pos_in(old)], [state_out(s1), keep], marker(-1), [t_alice]),
      validity_range: interval.between(old.unlock_at, old.unlock_at + 1_000),
    }
  !spend_state(s0, UnlockLong, tx) && old_gen_unlock(0, old)
}

test an_old_generation_position_does_not_touch_the_live_books() {
  let old = Position { ..t_pos(40_000_000), gen: 0 }
  let s0 = VaultState { ..t_vs(0, 0, 50_000_000, 60_000_000), long_gen: 1 }
  let s1 = VaultState { ..bump(s0), long_shares: 10_000_000 }
  let tx =
    Transaction {
      ..vtx([state_in(s0), pos_in(old)], [state_out(s1), pay(key_addr(t_alice), 0)], marker(-1), [t_alice]),
      validity_range: interval.between(old.unlock_at, old.unlock_at + 1_000),
    }
  !spend_state(s0, UnlockLong, tx)
}

test the_live_generation_unlock_is_unchanged() {
  let live = Position { ..t_pos(40_000_000), gen: 1 }
  let s0 = VaultState { ..t_vs(0, 0, 100_000_000, 125_000_000), long_gen: 1 }
  spend_state(s0, UnlockLong, unlock_tx(s0, live, 50_000_000, key_addr(t_alice)))
}

test the_first_stake_after_a_wipe_is_one_to_one_and_needs_ten_tsra() {
  let s0 = VaultState { ..t_vs(0, 0, 0, 0), short_gen: 3 }
  let s1 = VaultState { ..bump(s0), short_shares: 10_000_000, short_assets: 10_000_000 }
  let ok = vtx([state_in(s0)], [state_out(s1)], stsra_gen(3, 10_000_000), [])
  let small = VaultState { ..bump(s0), short_shares: 9_999_999, short_assets: 9_999_999 }
  short(s0, 10_000_000, ok) && !short(
    s0,
    9_999_999,
    vtx([state_in(s0)], [state_out(small)], stsra_gen(3, 9_999_999), []),
  )
}

// -- the last share out sweeps the still-vesting yield (D-19)

/// A short class with `vs` TSRA still vesting from `t_lo`, one holder.
fn last_s0(vs: Int) -> VaultState {
  VaultState {
    ..t_vs(100_000_000, 100_000_000, 0, 0),
    vest_short: vs,
    vest_from: t_lo,
    vest_until: t_lo + 7 * day,
  }
}

fn last_unstake(
  s0: VaultState,
  shares: Int,
  s1: VaultState,
  fl_before: Int,
  fl_after: Int,
  spend_fl: Bool,
) -> Bool {
  let sf = fold(s0, t_lo)
  let v = exchange.redeem_value(shares, sf.short_shares, sf.short_assets)
  let t = t_ticket(v)
  let base =
    vtx(
      [state_in(s0)],
      [state_out(s1), ticket_out(t)],
      marker(1) |> assets.merge(stsra(-shares)),
      [],
    )
  let tx =
    if spend_fl {
      Transaction {
        ..base,
        inputs: [state_in(s0), fl_in(fl_before)],
        outputs: [state_out(s1), ticket_out(t), fl_out(fl_after)],
      }
    } else {
      base
    }
  unstake(s0, shares, tx)
}

fn last_out(s0: VaultState, vest_after: Int) -> VaultState {
  VaultState {
    ..bump(s0),
    short_shares: 0,
    short_assets: 0,
    vest_short: vest_after,
    ticket_escrow: s0.short_assets,
  }
}

test the_last_unstake_sweeps_the_unvested_yield_to_first_loss() {
  let s0 = last_s0(5_000_000)
  last_unstake(s0, 100_000_000, last_out(s0, 0), 0, 5_000_000, True)
}

test the_last_unstake_without_the_first_loss_deposit_is_rejected() {
  let s0 = last_s0(5_000_000)
  !last_unstake(s0, 100_000_000, last_out(s0, 0), 0, 0, False)
}

test the_last_unstake_cannot_leave_the_yield_vesting() {
  let s0 = last_s0(5_000_000)
  !last_unstake(s0, 100_000_000, last_out(s0, 5_000_000), 0, 0, False)
}

test the_last_unstake_must_sweep_all_of_it() {
  let s0 = last_s0(5_000_000)
  !last_unstake(s0, 100_000_000, last_out(s0, 0), 0, 4_999_999, True) && !last_unstake(
    s0,
    100_000_000,
    last_out(s0, 0),
    0,
    5_000_001,
    True,
  )
}

test the_last_unstake_adds_to_the_first_loss_balance() {
  let s0 = last_s0(5_000_000)
  last_unstake(s0, 100_000_000, last_out(s0, 0), 7_000_000, 12_000_000, True)
}

test an_ordinary_unstake_needs_no_first_loss_input() {
  let s0 = last_s0(5_000_000)
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 50_000_000,
      short_assets: 50_000_000,
      ticket_escrow: 50_000_000,
    }
  last_unstake(s0, 50_000_000, s1, 0, 0, False)
}

test an_ordinary_unstake_cannot_drain_the_vesting_yield() {
  let s0 = last_s0(5_000_000)
  let s1 =
    VaultState {
      ..bump(s0),
      short_shares: 50_000_000,
      short_assets: 50_000_000,
      vest_short: 0,
      ticket_escrow: 50_000_000,
    }
  !last_unstake(s0, 50_000_000, s1, 0, 5_000_000, True)
}

test a_last_unstake_with_nothing_vesting_needs_no_sweep() {
  let s0 = last_s0(0)
  last_unstake(s0, 100_000_000, last_out(s0, 0), 0, 0, False)
}

test the_last_unstake_sweeps_only_what_is_still_unvested() {
  // half the week has vested by lo: the booked part is the staker's
  let s0 = VaultState { ..last_s0(8_000_000), vest_from: 0, vest_until: 2 * t_lo }
  let sf = fold(s0, t_lo)
  let v = sf.short_assets
  let s1 = VaultState { ..bump(sf), short_shares: 0, short_assets: 0, vest_short: 0, ticket_escrow: v }
  last_unstake(s0, 100_000_000, s1, 0, sf.vest_short, True)
}

fn last_unlock(vl: Int, deposit: Int, vest_after: Int, spend_fl: Bool) -> Bool {
  let s0 =
    VaultState {
      ..t_vs(0, 0, 40_000_000, 50_000_000),
      vest_long: vl,
      vest_from: 1_500_000,
      vest_until: 1_500_000 + 7 * day,
    }
  let p = t_pos(40_000_000)
  let s1 =
    VaultState {
      ..bump(s0),
      long_shares: 0,
      long_assets: 0,
      vest_long: vest_after,
    }
  let base =
    Transaction {
      ..vtx([state_in(s0), pos_in(p)], [state_out(s1), pay(key_addr(t_alice), 50_000_000)], marker(-1), [t_alice]),
      validity_range: interval.between(p.unlock_at, p.unlock_at + 1_000),
    }
  let tx =
    if spend_fl {
      Transaction {
        ..base,
        inputs: [state_in(s0), pos_in(p), fl_in(0)],
        outputs: [state_out(s1), pay(key_addr(t_alice), 50_000_000), fl_out(deposit)],
      }
    } else {
      base
    }
  spend_state(s0, UnlockLong, tx)
}

test the_last_unlock_sweeps_the_unvested_yield_to_first_loss() {
  last_unlock(3_000_000, 3_000_000, 0, True)
}

test the_last_unlock_without_the_deposit_is_rejected() {
  !last_unlock(3_000_000, 0, 0, False) && !last_unlock(3_000_000, 0, 3_000_000, False) && !last_unlock(
    3_000_000,
    2_999_999,
    0,
    True,
  )
}

test an_unlock_that_leaves_shares_behind_needs_no_sweep() {
  let s0 =
    VaultState {
      ..t_vs(0, 0, 100_000_000, 125_000_000),
      vest_long: 3_000_000,
      vest_from: 1_500_000,
      vest_until: 1_500_000 + 7 * day,
    }
  spend_state(s0, UnlockLong, unlock_tx(s0, t_pos(40_000_000), 50_000_000, key_addr(t_alice)))
}

test yield_into_an_emptied_class_credits_only_the_other_class() {
  // the short class is gone (0 shares): the whole net goes to the long class
  let s0 = VaultState { ..t_vs(0, 0, 100_000_000, 100_000_000) }
  let (_, _, ys, yl) = split_yield(10_000_000, 1_250, 0, 100_000_000, 12_500)
  let s1 = vesting(s0, ys, yl)
  let tx = yield_with(s0, s1, 625_000, 625_000, [t_op1, t_op2])
  ys == 0 && yl == 8_750_000 && spend_state(s0, ReportYield { gross: 10_000_000 }, tx)
}

test a_new_staker_in_an_emptied_class_gets_no_windfall() {
  // after the last exit the class holds nothing and vests nothing
  let s0 = last_s0(5_000_000)
  let gone = last_out(s0, 0)
  let s2 = VaultState { ..bump(gone), short_shares: 10_000_000, short_assets: 10_000_000 }
  gone.vest_short == 0 && gone.short_assets == 0 && short(
    gone,
    10_000_000,
    vtx([state_in(gone)], [state_out(s2)], stsra(10_000_000), []),
  )
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

fn script_addr_of(h: PolicyId) -> Address {
  Address { payment_credential: Script(h), stake_credential: None }
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
  a == 0 && b == 0 && spend_state(s0, ReportYield { gross: 10_000_000 }, base)
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
  spend_state(w.s0, ReportLoss { loss: w.loss }, w.tx)
}

/// 40 + 20 unvested, 100 first-loss, 600 + 400 staked, 500 in Tickets.
fn golden_s0() -> VaultState {
  rl_s0(600, 600, 400, 400, 40, 20, 500)
}

fn golden() -> RL {
  rl_world(golden_s0(), 460, 100)
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
  !spend_state(s0, ReportLoss { loss: 0 }, w.tx) && !spend_state(s0, ReportLoss { loss: -5 }, w.tx)
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

// -- a class wiped out by the loss

fn solo_short(loss: Int) -> RL {
  rl_world(rl_s0(1_000_000, 1_000_000, 0, 0, 0, 0, 0), loss, 0)
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
  let short = RL { ..w, tx: map_out(w.tx, 3, fn(_) { fl_out(998) }) }
  !rl_ok(lost) && !rl_ok(short)
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

test the_worst_case_fixture_is_accepted_by_the_vault() {
  let f = loss_fixture.fixture()
  stsra_vault.spend(
    loss_fixture.ref(99),
    loss_fixture.reserve_policy,
    Some(StateDatum(f.state0)),
    ReportLoss { loss: f.loss },
    loss_fixture.ref(0),
    f.tx,
  )
}

test the_claim_fixture_is_accepted_by_the_vault() {
  let f = loss_fixture.claim_fixture()
  stsra_vault.spend(
    loss_fixture.ref(99),
    loss_fixture.reserve_policy,
    Some(StateDatum(f.state0)),
    Claim,
    loss_fixture.ref(0),
    f.tx,
  ) && stsra_vault.spend(
    loss_fixture.ref(99),
    loss_fixture.reserve_policy,
    Some(TicketDatum(f.ticket)),
    Claim,
    loss_fixture.ref(1),
    f.tx,
  )
}

// -- Genesis: the Phase 2.5b fields

test genesis_with_escrowed_tickets_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), ticket_escrow: 1 })
}

test genesis_with_a_short_generation_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), short_gen: 1 })
}

test genesis_with_a_long_generation_is_rejected() {
  !boot(VaultState { ..t_vs(0, 0, 0, 0), long_gen: 1 })
}

test genesis_accepts_a_28_byte_first_loss_policy_other_than_the_vault() {
  boot(VaultState { ..t_vs(0, 0, 0, 0), first_loss: t_fl })
}

test a_wiped_long_class_with_unvested_yield_sweeps_that_too() {
  let s0 = rl_s0(0, 0, 1_000_000, 500, 0, 90, 0)
  let w = rl_world(s0, 5, 0)
  w.s1.long_gen == 1 && w.s1.vest_long == 0 && w.sweep == 500 - w.sp.r_long + 90 - w.sp.u_long && rl_ok(w)
}

test an_old_generation_position_never_sweeps_the_live_classs_yield() {
  // 60M old shares against 50M live ones: not "the last share" of the live
  // class, so nothing is swept and the vesting yield stays put
  let old = Position { ..t_pos(60_000_000), gen: 0 }
  let s0 =
    VaultState {
      ..t_vs(0, 0, 50_000_000, 60_000_000),
      long_gen: 1,
      vest_long: 3_000_000,
      vest_from: 1_500_000,
      vest_until: 1_500_000 + 7 * day,
    }
  let tx =
    Transaction {
      ..vtx([state_in(s0), pos_in(old)], [state_out(bump(s0)), pay(key_addr(t_alice), 0)], marker(-1), [t_alice]),
      validity_range: interval.between(old.unlock_at, old.unlock_at + 1_000),
    }
  spend_state(s0, UnlockLong, tx)
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
