//// Redemption queue: the address that holds every queue UTxO, and the policy
//// of its tokens (Phase 2.6, SPEC.md §4.1).
////
//// UTxOs here are told apart by their datum constructor (`QueueDatum`):
//// Config, Request, Sink, Shard, ShortState, Grace. The expensive rules run
//// once per transaction in one of three withdraw-zero scripts (`queue_flow`,
//// `queue_admin`, `queue_short`); this script is only the cheap per-UTxO gate:
////
//// * `Cancel`: the owner takes an unregistered Request back. Never blocked by
////   a suspension, a loss freeze, a revoked token, the pause or an empty
////   Buffer, because nothing here reads any of them.
//// * `Run`: spending under one of the three scripts, which must be withdrawn
////   from with amount 0 in the same transaction. One input per transaction
////   (the first queue input) also checks that each such script's redeemer
////   names THIS queue, so a run cannot be borrowed from another queue
////   instance. A Sink is not special here: that it moves only in a `Sweep`
////   (I-Q1, D-35) is enforced where the inputs are classified, because every
////   other action requires an exact set of queue inputs (SPEC.md §4.17).
//// * mint: the one-shot threads (`queue`, `short`, `shard<i>`) at Genesis,
////   Request markers, Grace tokens. Any mint or burn needs one of the three
////   scripts, bound to this policy, and the Config thread needs the seed.

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  Input, Output, OutputReference, Spend, Transaction, Withdraw,
}
use stellaris/thread.{seed_spent}
use tessera/rules
use tessera/queue_state.{
  Cancel, QueueDatum, QueueEnvelope, QueueSpend, Request, RequestState, Run,
  Sink, config_name, request_name,
}
// <hoisted test imports>
use tessera/queue_fixture.{
  alice, bob, cfg0, config_out, grace_out, inp, qout, keeper, now, q, qtok, rcfg0, ref,
  req, req_out, reserve_config_out, shard0, shard_out, short0, short_out,
  sink_out, t_admin, t_flow, t_reserve, t_short, tsra, tx0, wallet,
}
use tessera/queue_state.{
  AdminRedeemer, Config, Shard, EnterShort, FlowRedeemer, FlowSettle, Genesis,
  QueueConfig, ShortRedeemer, ShortState,
}
use tessera/reserve_state.{ConfigState}
// </hoisted test imports>

/// `h` is not withdrawn from (`None`), or withdrawn with amount 0 and its
/// redeemer names `me`. A non-zero withdrawal is never acceptable.
fn bound(tx: Transaction, me: PolicyId, h: PolicyId) -> Bool {
  when pairs.get_first(tx.withdrawals, Script(h)) is {
    None -> True
    Some(0) ->
      when pairs.get_first(tx.redeemers, Withdraw(Script(h))) is {
        Some(d) -> {
          expect e: QueueEnvelope = d
          e.queue == me
        }
        None -> False
      }
    Some(_) -> False
  }
}

fn present(tx: Transaction, h: PolicyId) -> Bool {
  pairs.get_first(tx.withdrawals, Script(h)) == Some(0)
}

/// Every script that runs names this queue (none need run: a plain Cancel).
fn bound_all(
  tx: Transaction,
  me: PolicyId,
  flow: PolicyId,
  admin: PolicyId,
  short: PolicyId,
) -> Bool {
  bound(tx, me, flow) && bound(tx, me, admin) && bound(tx, me, short)
}

/// At least one of the three scripts runs, and every one that runs is bound to
/// this queue.
fn gate_bound(
  tx: Transaction,
  me: PolicyId,
  flow: PolicyId,
  admin: PolicyId,
  short: PolicyId,
) -> Bool {
  (present(tx, flow) || present(tx, admin) || present(tx, short)) && bound_all(
    tx,
    me,
    flow,
    admin,
    short,
  )
}

/// The output of the input `r` (a plain loop: it runs once per queue input, so
/// the closure-free form matters in a large batch).
fn output_of(ins: List<Input>, r: OutputReference) -> Output {
  when ins is {
    [i, ..rest] ->
      if i.output_reference == r {
        i.output
      } else {
        output_of(rest, r)
      }
    [] -> fail @"own input not found"
  }
}

/// The reference of the first input at `c`.
fn first_at(ins: List<Input>, c: Credential) -> OutputReference {
  when ins is {
    [i, ..rest] ->
      if i.output.address.payment_credential == c {
        i.output_reference
      } else {
        first_at(rest, c)
      }
    [] -> fail @"no input at the credential"
  }
}

validator redeem_queue(
  seed: OutputReference,
  reserve: PolicyId,
  flow: PolicyId,
  admin: PolicyId,
  short: PolicyId,
) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    and {
      gate_bound(tx, policy_id, flow, admin, short),
      // the Config thread (and with it the whole set minted at Genesis) needs
      // the seed, so it exists once, ever
      !dict.has_key(assets.tokens(tx.mint, policy_id), config_name) || seed_spent(
        tx.inputs,
        seed,
      ),
    }
  }

  spend(
    datum: Option<Data>,
    redeemer: QueueSpend,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    when redeemer is {
      Cancel -> {
        expect qd: QueueDatum = d
        expect Request(RequestState { owner, reg_episode, qty, .. }) = qd
        expect Script(me) = output_of(tx.inputs, own_ref).address.payment_credential
        let marked =
          list.count(
            tx.inputs,
            fn(i) { quantity_of(i.output.value, me, request_name) == 1 },
          )
        and {
          // A Cancel can be the first queue input of a transaction whose other
          // inputs run under a script: the first input checks the bindings
          // whichever way it is spent, or a spent-first Cancel would let an
          // unbound script validate the rest.
          first_at(tx.inputs, Script(me)) != own_ref || bound_all(
            tx,
            me,
            flow,
            admin,
            short,
          ),
          reg_episode == 0,
          list.has(tx.extra_signatories, owner),
          quantity_of(tx.mint, me, request_name) == -marked,
          // the TSRA goes back to the owner's side, not into the queue
          list.foldl(
            tx.outputs,
            0,
            fn(o, acc) {
              if o.address.payment_credential == Script(me) {
                acc
              } else {
                acc + quantity_of(o.value, reserve, rules.tsra_name)
              }
            },
          ) >= qty,
        }
      }
      Run -> {
        let pf = present(tx, flow)
        let pa = present(tx, admin)
        let ps = present(tx, short)
        // the first queue input checks the bindings for the whole tx
        let c = output_of(tx.inputs, own_ref).address.payment_credential
        and {
          pf || pa || ps,
          first_at(tx.inputs, c) != own_ref || when c is {
            Script(me) -> gate_bound(tx, me, flow, admin, short)
            _ -> False
          },
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------ tests


fn t_seed() -> OutputReference {
  OutputReference {
    transaction_id: #"0808080808080808080808080808080808080808080808080808080808080808",
    output_index: 0,
  }
}

fn flow_rd(queue: PolicyId) -> Data {
  let d: Data = FlowRedeemer { queue, action: FlowSettle }
  d
}

fn admin_rd(queue: PolicyId) -> Data {
  let d: Data = AdminRedeemer { queue, action: Genesis }
  d
}

fn short_rd(queue: PolicyId) -> Data {
  let d: Data = ShortRedeemer { queue, action: EnterShort }
  d
}

const other_q: PolicyId =
  #"72727272727272727272727272727272727272727272727272727272"

/// `h` is withdrawn from with amount `amt` and its redeemer names `queue`.
fn with_gate(tx: Transaction, h: PolicyId, amt: Int, rd: Data) -> Transaction {
  Transaction {
    ..tx,
    withdrawals: [Pair(Script(h), amt), ..tx.withdrawals],
    redeemers: [Pair(Withdraw(Script(h)), rd), ..tx.redeemers],
  }
}

fn spend_as(d: QueueDatum, r: QueueSpend, i: Int, tx: Transaction) -> Bool {
  let dd: Data = d
  redeem_queue.spend(t_seed(), t_reserve, t_flow, t_admin, t_short, Some(dd), r, ref(i), tx)
}

fn mint_as(tx: Transaction) -> Bool {
  redeem_queue.mint(t_seed(), t_reserve, t_flow, t_admin, t_short, Void, q, tx)
}

fn request_in() -> Input {
  inp(1, req_out(req(alice, 1_000_000_000, 20)))
}

fn rdatum() -> QueueDatum {
  Request(req(alice, 1_000_000_000, 20))
}

fn cancel_tx() -> Transaction {
  Transaction {
    ..tx0(),
    inputs: [request_in()],
    outputs: [wallet(alice, tsra(1_000_000_000))],
    extra_signatories: [alice],
    mint: qtok(request_name, -1),
  }
}

fn run_tx() -> Transaction {
  Transaction { ..tx0(), inputs: [request_in()] }
    |> with_gate(t_flow, 0, flow_rd(q))
}

// -- Cancel

test the_owner_can_cancel_a_request() {
  spend_as(rdatum(), Cancel, 1, cancel_tx())
}

test only_the_owner_can_cancel() {
  !spend_as(rdatum(), Cancel, 1, Transaction { ..cancel_tx(), extra_signatories: [bob] }) && !spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..cancel_tx(), extra_signatories: [] },
  )
}

test a_cancel_must_burn_the_marker() {
  !spend_as(rdatum(), Cancel, 1, Transaction { ..cancel_tx(), mint: assets.zero }) && !spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..cancel_tx(), mint: qtok(request_name, -2) },
  ) && !spend_as(rdatum(), Cancel, 1, Transaction { ..cancel_tx(), mint: qtok(request_name, 1) })
}

test cancelling_two_requests_burns_two_markers() {
  let two =
    Transaction {
      ..cancel_tx(),
      inputs: [request_in(), inp(2, req_out(req(alice, 2_000_000_000, 20)))],
      mint: qtok(request_name, -2),
    }
  spend_as(rdatum(), Cancel, 1, two) && !spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..two, mint: qtok(request_name, -1) },
  )
}

test a_cancel_must_return_the_tsra_to_the_owners_side() {
  !spend_as(rdatum(), Cancel, 1, Transaction { ..cancel_tx(), outputs: [wallet(alice, tsra(999_999_999))] }) && !spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..cancel_tx(), outputs: [wallet(alice, assets.zero)] },
  ) && !spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..cancel_tx(), outputs: [sink_out(1_000_000_000)] },
  ) && spend_as(
    rdatum(),
    Cancel,
    1,
    Transaction { ..cancel_tx(), outputs: [wallet(bob, tsra(1_000_000_000))] },
  )
}

test a_registered_request_cannot_use_the_plain_cancel() {
  let reg = Request(RequestState { ..req(alice, 1_000_000_000, 20), reg_episode: 1 })
  !spend_as(reg, Cancel, 1, cancel_tx())
}

test cancel_is_not_blocked_by_anything_the_queue_could_read() {
  // a suspension, a loss freeze, the pause, a revoked token, short mode, an
  // empty Buffer: the plain cancel reads none of them, so none can close it
  let c = QueueConfig { ..cfg0(), suspended_until: now + 100 * 86_400_000 }
  let rc =
    ConfigState {
      ..rcfg0(),
      loss_pending_until: now + 100 * 86_400_000,
      paused: True,
      kyc_redeem: True,
    }
  let tx =
    Transaction {
      ..cancel_tx(),
      reference_inputs: [
        inp(90, config_out(c)),
        inp(91, reserve_config_out(rc)),
        inp(92, short_out(ShortState { ..short0(), active: True, episode: 1 })),
        inp(93, shard_out(0, shard0(), 0)),
      ],
    }
  spend_as(rdatum(), Cancel, 1, tx)
}

test cancel_needs_a_request_datum() fail {
  spend_as(Sink, Cancel, 1, Transaction { ..cancel_tx(), inputs: [inp(1, sink_out(1_000_000_000))] })
}

test cancel_of_a_config_is_refused() fail {
  spend_as(Config(cfg0()), Cancel, 1, Transaction { ..cancel_tx(), inputs: [inp(1, config_out(cfg0()))] })
}

// -- a Cancel that is the first queue input still checks the bindings

fn planted_request_in() -> Input {
  // a Request lookalike of the attacker's own: no marker, so nothing to burn
  inp(1, qout(tsra(1_000_000_000), Request(req(alice, 1_000_000_000, 20))))
}

fn mixed_tx(flow_names: PolicyId) -> Transaction {
  Transaction {
    ..tx0(),
    inputs: [planted_request_in(), inp(2, shard_out(0, shard0(), 5_000_000_000))],
    outputs: [wallet(alice, tsra(1_000_000_000))],
    extra_signatories: [alice],
  }
    |> with_gate(t_flow, 0, flow_rd(flow_names))
}

test a_cancel_first_cannot_hide_an_unbound_script_that_runs_the_other_inputs() {
  // the shard is spent under a flow run naming ANOTHER queue; the first queue
  // input is a Cancel, which must still refuse the unbound script
  let planted = Request(req(alice, 1_000_000_000, 20))
  !spend_as(planted, Cancel, 1, mixed_tx(other_q)) && spend_as(planted, Cancel, 1, mixed_tx(q))
}

test the_shard_in_that_mixed_transaction_passes_only_when_bound() {
  // the second input (non-first) relies on the first input's check
  spend_as(Shard(shard0()), Run, 2, mixed_tx(q))
}

// -- Run: the gate

test running_under_the_flow_script_is_accepted() {
  spend_as(rdatum(), Run, 1, run_tx())
}

test running_under_the_admin_or_short_script_is_accepted_by_the_gate() {
  let a = Transaction { ..tx0(), inputs: [request_in()] } |> with_gate(t_admin, 0, admin_rd(q))
  let s = Transaction { ..tx0(), inputs: [request_in()] } |> with_gate(t_short, 0, short_rd(q))
  spend_as(rdatum(), Run, 1, a) && spend_as(rdatum(), Run, 1, s)
}

test running_with_no_script_withdrawn_is_refused() {
  !spend_as(rdatum(), Run, 1, Transaction { ..tx0(), inputs: [request_in()] })
}

test a_non_zero_withdrawal_is_refused() {
  !spend_as(
    rdatum(),
    Run,
    1,
    Transaction { ..tx0(), inputs: [request_in()] } |> with_gate(t_flow, 1, flow_rd(q)),
  )
}

test a_flow_run_naming_another_queue_is_refused() {
  !spend_as(
    rdatum(),
    Run,
    1,
    Transaction { ..tx0(), inputs: [request_in()] } |> with_gate(t_flow, 0, flow_rd(other_q)),
  )
}

test every_script_that_runs_must_name_this_queue() {
  let tx =
    Transaction { ..tx0(), inputs: [request_in()] }
      |> with_gate(t_flow, 0, flow_rd(q))
      |> with_gate(t_short, 0, short_rd(other_q))
  !spend_as(rdatum(), Run, 1, tx)
}

test a_run_without_its_redeemer_entry_is_refused() {
  !spend_as(
    rdatum(),
    Run,
    1,
    Transaction { ..tx0(), inputs: [request_in()], withdrawals: [Pair(Script(t_flow), 0)] },
  )
}

test only_the_first_queue_input_pays_for_the_binding_check() {
  // the second input of a batch passes on the withdrawal alone
  let tx =
    Transaction { ..tx0(), inputs: [request_in(), inp(2, req_out(req(bob, 1_000_000_000, 20)))] }
      |> with_gate(t_flow, 0, flow_rd(other_q))
  !spend_as(rdatum(), Run, 1, tx) && spend_as(Request(req(bob, 1_000_000_000, 20)), Run, 2, tx)
}

test a_wallet_input_before_the_queue_inputs_does_not_move_the_first() {
  let tx =
    Transaction { ..tx0(), inputs: [inp(0, wallet(alice, assets.zero)), request_in()] }
      |> with_gate(t_flow, 0, flow_rd(q))
  spend_as(rdatum(), Run, 1, tx)
}

// -- Run: a Sink is only ever swept (I-Q1.1)

fn sink_run(h: PolicyId, rd: Data) -> Transaction {
  Transaction { ..tx0(), inputs: [inp(1, sink_out(1_000_000_000))] }
    |> with_gate(h, 0, rd)
}

test a_sink_runs_under_the_flow_script() {
  spend_as(Sink, Run, 1, sink_run(t_flow, flow_rd(q)))
}

test a_sink_runs_under_the_gate_of_any_script_but_every_other_script_refuses_it() {
  // The spend handler reads a Sink like any queue input (a withdrawal from one
  // of the three scripts must run); the rule that a Sink moves only in a Sweep
  // is enforced where the real work is done: every `queue_flow` action other
  // than `Sweep`, every `queue_admin` and every `queue_short` action require an
  // exact set of queue inputs and refuse a Sink among them (tests in those
  // modules: `*_refuses_a_sink_input`, `*_may_not_carry_another_queue_input`).
  spend_as(Sink, Run, 1, sink_run(t_admin, admin_rd(q))) && spend_as(Sink, Run, 1, sink_run(t_short, short_rd(q)))
}





test a_sink_has_no_cancel() fail {
  spend_as(Sink, Cancel, 1, Transaction { ..cancel_tx(), inputs: [inp(1, sink_out(1_000_000_000))] })
}

// -- mint

test minting_needs_one_of_the_three_scripts() {
  let m = Transaction { ..tx0(), mint: qtok(request_name, 1) }
  !mint_as(m) && mint_as(m |> with_gate(t_flow, 0, flow_rd(q))) && mint_as(
    m |> with_gate(t_admin, 0, admin_rd(q)),
  ) && mint_as(m |> with_gate(t_short, 0, short_rd(q)))
}

test minting_under_a_script_naming_another_queue_is_refused() {
  let m = Transaction { ..tx0(), mint: qtok(request_name, 1) }
  !mint_as(m |> with_gate(t_flow, 0, flow_rd(other_q)))
}

test the_config_thread_needs_the_seed() {
  let m = Transaction { ..tx0(), mint: qtok(config_name, 1) } |> with_gate(t_admin, 0, admin_rd(q))
  let seeded =
    Transaction {
      ..m,
      inputs: [Input { output_reference: t_seed(), output: wallet(alice, assets.zero) }],
    }
  !mint_as(m) && mint_as(seeded)
}

test burning_markers_needs_the_gate_but_not_the_seed() {
  let b = Transaction { ..tx0(), mint: qtok(request_name, -1) }
  !mint_as(b) && mint_as(b |> with_gate(t_flow, 0, flow_rd(q)))
}

// -- execution budget (SPEC §4.13): the per-input gate of a 20-input batch.
// The `_build` tests only build the transaction; the difference to the `_run`
// tests is the gate's cost. A batch pays the first input's cost (it checks the
// bindings) once and the other inputs' cost 19 times.

fn batch_in(i: Int) -> Input {
  inp(10 + i, req_out(req(alice, 400_000_000, 20)))
}

fn batch_tx() -> Transaction {
  Transaction { ..tx0(), inputs: list.map(list.range(0, 19), batch_in) }
    |> with_gate(t_flow, 0, flow_rd(q))
}

fn forced(tx: Transaction) -> Bool {
  list.length(tx.inputs) > 0
}

test budget_gate_20_build() {
  forced(batch_tx())
}

test budget_gate_first_of_20_run() {
  let tx = batch_tx()
  forced(tx) && spend_as(rdatum(), Run, 10, tx)
}

test budget_gate_last_of_20_run() {
  let tx = batch_tx()
  forced(tx) && spend_as(rdatum(), Run, 29, tx)
}

test budget_gate_middle_of_20_run() {
  let tx = batch_tx()
  forced(tx) && spend_as(rdatum(), Run, 20, tx)
}

test budget_cancel_build() {
  forced(cancel_tx())
}

test budget_cancel_run() {
  let tx = cancel_tx()
  forced(tx) && spend_as(rdatum(), Cancel, 1, tx)
}

test budget_gate_harness_only() {
  let tx = batch_tx()
  let dd: Data = rdatum()
  forced(tx) && Some(dd) != None && ref(20) != ref(21) && t_seed() != ref(1)
}

test a_run_beside_a_cancel_first_still_needs_a_script_to_run() {
  // the first queue input is a Cancel (no script needed); the second runs
  // under nothing at all: it must be refused on its own account
  let no_script =
    Transaction {
      ..tx0(),
      inputs: [planted_request_in(), inp(2, shard_out(0, shard0(), 5_000_000_000))],
      outputs: [wallet(alice, tsra(1_000_000_000))],
      extra_signatories: [alice],
    }
  !spend_as(Shard(shard0()), Run, 2, no_script)
}
