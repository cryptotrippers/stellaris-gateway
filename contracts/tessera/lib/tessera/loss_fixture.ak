//// A worst-case `ReportLoss` transaction, shared by the validators' execution
//// budget tests (Phase 2.5b, SPEC.md §3a.14). Nothing here is used by a
//// validator; it only builds a transaction every script accepts.
////
//// Worst case on purpose: both share classes live and then both wiped out
//// (generation bump + sweep to first-loss), unvested yield in both classes,
//// open Tickets (so `ticket_escrow > 0`), the first-loss reserve drawn, a 3-of-5
//// committee, extra wallet inputs and a change output. Scripts it runs: the
//// vault State (`ReportLoss`), the reserve Supply and Config (`LossBurn`, two
//// executions), the reserve mint handler (the TSRA burn) and the first-loss
//// State (`Draw`).

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Spend, Transaction,
  placeholder,
}
use stellaris/thread.{thread_value}
use tessera/first_loss_state.{FirstLossState}
use tessera/loss.{LossSplit, class_dead, split_loss}
use tessera/reserve_state.{
  ConfigDatum, ConfigState, SupplyDatum, SupplyState,
}
use tessera/reserve_threads.{config_value, supply_value}
use tessera/rules
use tessera/vault_state.{
  Claim, StateDatum, Ticket, TicketDatum, VaultState, fold, ticket_payout,
}

pub const reserve_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

pub const vault_policy: PolicyId =
  #"31313131313131313131313131313131313131313131313131313131"

pub const vault_ops_policy: PolicyId =
  #"55555555555555555555555555555555555555555555555555555555"

pub const fl_policy: PolicyId =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

pub const elig_policy: PolicyId =
  #"77777777777777777777777777777777777777777777777777777777"

const day: Int = 86_400_000

pub const lo: Int = 2_000_000

pub const hi: Int = 3_000_000

pub fn op(i: Int) -> ByteArray {
  bytearray_of(i)
}

fn bytearray_of(i: Int) -> ByteArray {
  when i is {
    1 -> #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
    2 -> #"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
    3 -> #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
    4 -> #"d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"
    _ -> #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"
  }
}

fn script_addr(h: PolicyId) -> Address {
  Address { payment_credential: Script(h), stake_credential: None }
}

pub fn treasury() -> Address {
  Address {
    payment_credential: VerificationKey(
      #"f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2",
    ),
    stake_credential: None,
  }
}

pub fn ref(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0505050505050505050505050505050505050505050505050505050505050505",
    output_index: i,
  }
}

fn ada() -> Value {
  assets.from_lovelace(2_000_000)
}

fn tsra(qty: Int) -> Value {
  assets.from_asset(reserve_policy, rules.tsra_name, qty)
}

pub type Fixture {
  tx: Transaction,
  supply0: SupplyState,
  config0: ConfigState,
  fl0: FirstLossState,
  state0: VaultState,
  split: LossSplit,
  sweep: Int,
  loss: Int,
  qty: Int,
  written_off: Int,
}

pub fn state0() -> VaultState {
  VaultState {
    short_shares: 1_000_000_000,
    short_assets: 1_000_000_000,
    long_shares: 2_000_000_000,
    long_assets: 2_000_000_000,
    loss_index: 1_000_000_000_000,
    ticket_escrow: 500_000_000,
    short_gen: 0,
    long_gen: 0,
    vest_short: 40_000_000,
    vest_long: 20_000_000,
    vest_from: 1_000_000,
    vest_until: 1_000_000 + 7 * day,
    long_weight_bps: 12_500,
    short_cooldown_ms: 7 * day,
    long_lock_ms: 30 * day,
    protocol_bps: 1_250,
    first_loss: fl_policy,
    treasury_addr: treasury(),
    epoch: 4,
  }
}

pub fn config0() -> ConfigState {
  ConfigState {
    operators: [op(1), op(2), op(3), op(4), op(5)],
    threshold: 3,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: elig_policy,
    vault_policy,
    loss_pending_until: hi + 1_000,
    epoch: 7,
  }
}

pub fn supply0() -> SupplyState {
  SupplyState {
    minted_supply: 10_000_000_000,
    attested_reserve: 10_000_000_000,
    mint_cap: 20_000_000_000,
    attestation_epoch: 3,
    attested_at: 500_000,
    epoch: 9,
  }
}

/// Everything wiped out except 3,000,000 units (a dead class with a sweep).
pub fn fixture() -> Fixture {
  let s0 = state0()
  let sf = fold(s0, lo)
  let fl0 = FirstLossState { balance: 100_000_000, epoch: 2 }
  let e = sf.short_assets + sf.long_assets + sf.ticket_escrow
  let loss = sf.vest_short + sf.vest_long + fl0.balance + e - 3_000_000
  let sp =
    split_loss(
      loss,
      sf.vest_short,
      sf.vest_long,
      fl0.balance,
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
  let c0 = config0()
  let p0 = supply0()
  let c1 = ConfigState { ..c0, loss_pending_until: lo, epoch: c0.epoch + 1 }
  let p1 =
    SupplyState {
      ..p0,
      minted_supply: p0.minted_supply - sp.qty,
      attested_reserve: p0.attested_reserve - sp.written_off,
      epoch: p0.epoch + 1,
    }
  let fl1 =
    FirstLossState { balance: fl0.balance - sp.d + sweep, epoch: fl0.epoch + 1 }
  let state_out = fn(s: VaultState) -> Output {
    Output {
      address: script_addr(vault_policy),
      value: ada()
        |> assets.merge(thread_value(vault_policy))
        |> assets.merge(
            tsra(s.short_assets + s.long_assets + s.vest_short + s.vest_long),
          ),
      datum: InlineDatum(StateDatum(s)),
      reference_script: None,
    }
  }
  let supply_out = fn(s: SupplyState) -> Output {
    Output {
      address: script_addr(reserve_policy),
      value: ada() |> assets.merge(supply_value(reserve_policy)),
      datum: InlineDatum(SupplyDatum(s)),
      reference_script: None,
    }
  }
  let config_out = fn(c: ConfigState) -> Output {
    Output {
      address: script_addr(reserve_policy),
      value: ada() |> assets.merge(config_value(reserve_policy)),
      datum: InlineDatum(ConfigDatum(c)),
      reference_script: None,
    }
  }
  let fl_out = fn(f: FirstLossState) -> Output {
    Output {
      address: script_addr(fl_policy),
      value: ada()
        |> assets.merge(thread_value(fl_policy))
        |> assets.merge(tsra(f.balance)),
      datum: InlineDatum(f),
      reference_script: None,
    }
  }
  let wallet = fn(i: Int) -> Input {
    Input {
      output_reference: ref(i),
      output: Output {
        address: Address {
          payment_credential: VerificationKey(op(1)),
          stake_credential: None,
        },
        value: assets.from_lovelace(50_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }
  }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        Input { output_reference: ref(0), output: state_out(s0) },
        Input { output_reference: ref(1), output: supply_out(p0) },
        Input { output_reference: ref(2), output: config_out(c0) },
        Input { output_reference: ref(3), output: fl_out(fl0) },
        wallet(4),
        wallet(5),
      ],
      outputs: [
        state_out(s1),
        supply_out(p1),
        config_out(c1),
        fl_out(fl1),
        Output {
          address: Address {
            payment_credential: VerificationKey(op(1)),
            stake_credential: None,
          },
          value: assets.from_lovelace(90_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      mint: tsra(-sp.qty),
      extra_signatories: [op(1), op(2), op(3)],
      validity_range: interval.between(lo, hi),
    }
  Fixture {
    tx,
    supply0: p0,
    config0: c0,
    fl0,
    state0: s0,
    split: sp,
    sweep,
    loss,
    qty: sp.qty,
    written_off: sp.written_off,
  }
}

test the_worst_case_fixture_wipes_out_both_classes_and_draws_the_reserve() {
  let f = fixture()
  and {
    f.split.d == 100_000_000,
    f.split.u > 0,
    f.split.r_tickets > 0,
    f.sweep > 0,
    list.length(f.tx.inputs) == 6,
  }
}

// ---------------------------------------------------------------- Claim

/// A Claim with a loss excess: the vault State and the Ticket are spent with
/// `Claim`, the Supply with `VaultClaimBurn` (the Config is referenced for the
/// freeze and `vault_policy`), and the excess is burned.
pub type ClaimFixture {
  tx: Transaction,
  state0: VaultState,
  ticket: Ticket,
  supply0: SupplyState,
  config0: ConfigState,
  excess: Int,
}

pub fn claim_fixture() -> ClaimFixture {
  let s0 =
    VaultState {
      ..state0(),
      vest_short: 0,
      vest_long: 0,
      loss_index: 800_000_000_000,
    }
  let ticket =
    Ticket {
      owner: Address {
        payment_credential: VerificationKey(op(2)),
        stake_credential: None,
      },
      value: 100_000_000,
      index_at_request: 1_000_000_000_000,
      claim_after: 1_000_000,
    }
  let payout = 80_000_000
  let excess = 20_000_000
  let c0 = ConfigState { ..config0(), loss_pending_until: lo }
  let p0 = supply0()
  let s1 =
    VaultState {
      ..s0,
      ticket_escrow: s0.ticket_escrow - payout,
      epoch: s0.epoch + 1,
    }
  let p1 =
    SupplyState {
      ..p0,
      minted_supply: p0.minted_supply - excess,
      epoch: p0.epoch + 1,
    }
  let state_out = fn(s: VaultState) -> Output {
    Output {
      address: script_addr(vault_policy),
      value: ada()
        |> assets.merge(thread_value(vault_policy))
        |> assets.merge(
            tsra(s.short_assets + s.long_assets + s.vest_short + s.vest_long),
          ),
      datum: InlineDatum(StateDatum(s)),
      reference_script: None,
    }
  }
  let ticket_out =
    Output {
      address: script_addr(vault_policy),
      value: ada()
        |> assets.add(vault_policy, "position", 1)
        |> assets.merge(tsra(ticket.value)),
      datum: InlineDatum(TicketDatum(ticket)),
      reference_script: None,
    }
  let supply_out = fn(s: SupplyState) -> Output {
    Output {
      address: script_addr(reserve_policy),
      value: ada() |> assets.merge(supply_value(reserve_policy)),
      datum: InlineDatum(SupplyDatum(s)),
      reference_script: None,
    }
  }
  let config_ref =
    Input {
      output_reference: ref(9),
      output: Output {
        address: script_addr(reserve_policy),
        value: ada() |> assets.merge(config_value(reserve_policy)),
        datum: InlineDatum(ConfigDatum(c0)),
        reference_script: None,
      },
    }
  let claim_redeemer: Data = Claim
  let tx =
    Transaction {
      ..placeholder,
      inputs: [
        Input { output_reference: ref(0), output: state_out(s0) },
        Input { output_reference: ref(1), output: ticket_out },
        Input { output_reference: ref(2), output: supply_out(p0) },
        Input {
          output_reference: ref(4),
          output: Output {
            address: Address {
              payment_credential: VerificationKey(op(1)),
              stake_credential: None,
            },
            value: assets.from_lovelace(50_000_000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      reference_inputs: [config_ref],
      outputs: [
        state_out(s1),
        supply_out(p1),
        Output {
          address: ticket.owner,
          value: assets.from_lovelace(4_000_000) |> assets.merge(tsra(payout)),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      mint: tsra(-excess)
        |> assets.add(vault_policy, "position", -1),
      redeemers: [Pair(Spend(ref(1)), claim_redeemer)],
      validity_range: interval.between(lo, hi),
    }
  ClaimFixture { tx, state0: s0, ticket, supply0: p0, config0: c0, excess }
}

test the_claim_fixture_has_an_excess() {
  let f = claim_fixture()
  f.excess == f.ticket.value - ticket_payout(f.ticket.value, f.state0.loss_index, f.ticket.index_at_request)
}
