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
////   instance. A Sink additionally allows only `queue_flow` (I-Q1, D-35).
//// * mint: the one-shot threads (`queue`, `short`, `shard<i>`) at Genesis,
////   Request markers, Grace tokens. Any mint or burn needs one of the three
////   scripts, bound to this policy, and the Config thread needs the seed.

use aiken/collection/dict
use aiken/collection/list
use aiken/collection/pairs
use cardano/address.{Script}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{OutputReference, Spend, Transaction, Withdraw}
use stellaris/thread.{seed_spent}
use tessera/queue_state.{
  Cancel, QueueDatum, QueueEnvelope, QueueSpend, Request, RequestState, Run,
  Sink, config_name, request_name,
}

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

/// At least one of the three scripts runs, and every one that runs is bound to
/// this queue.
fn gate_bound(
  tx: Transaction,
  me: PolicyId,
  flow: PolicyId,
  admin: PolicyId,
  short: PolicyId,
) -> Bool {
  (present(tx, flow) || present(tx, admin) || present(tx, short)) && bound(
    tx,
    me,
    flow,
  ) && bound(tx, me, admin) && bound(tx, me, short)
}

validator redeem_queue(
  seed: OutputReference,
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
    datum: Option<QueueDatum>,
    redeemer: QueueSpend,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(own) =
      list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
    expect Script(me) = own.output.address.payment_credential
    when redeemer is {
      Cancel -> {
        expect Request(RequestState { owner, reg_episode, .. }) = d
        let marked =
          list.count(
            tx.inputs,
            fn(i) { quantity_of(i.output.value, me, request_name) == 1 },
          )
        and {
          reg_episode == 0,
          list.has(tx.extra_signatories, owner),
          quantity_of(tx.mint, me, request_name) == -marked,
        }
      }
      Run ->
        and {
          present(tx, flow) || present(tx, admin) || present(tx, short),
          // a Sink goes only to queue_flow (whose Sweep requires the burn)
          d != Sink || (present(tx, flow) && !present(tx, admin) && !present(
            tx,
            short,
          )),
          // the first queue input checks the bindings for the whole tx
          when list.find(tx.inputs, fn(i) { i.output.address == own.output.address }) is {
            Some(first) ->
              first.output_reference != own_ref || gate_bound(
                tx,
                me,
                flow,
                admin,
                short,
              )
            None -> False
          },
        }
    }
  }

  else(_) {
    fail
  }
}
