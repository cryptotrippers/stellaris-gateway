//// fraction_vault v2 — investor pledges (SPEC-v2.md §3, §4.2, §5.1).
////
//// One UTxO per commitment, so investors never contend for the offering's
//// State. The pledge script is shared by every offering (its datum names the
//// offering by the State's thread-token policy) and doubles as the policy of
//// a pledge marker:
////
////   * `MintPledge` mints one marker into one new pledge, and only while the
////     named offering is `Raising` and the transaction ends by the deadline.
////     It checks the deposit (exactly `qty * price` units), the owner (a key
////     address) and records `created` as the transaction's lower bound — so a
////     marked pledge is always well formed and on time;
////   * every marked pledge that is spent burns its marker (`BurnPledges`).
////
//// A UTxO at this address without a marker is not a pledge: anyone may send
//// it back to the owner its datum names, at any time.
////
//// Spending a marked pledge:
////
////   * `SettlePledge` — only beside the genuine State; the State's own
////     `Settle` does the accounting and refuses any pledge outside `Settle`;
////   * `CancelPledge` — the owner, while `Raising` and before the deadline;
////   * `RefundPledge` — anyone, once the raise is no longer `Raising` or the
////     settle window has passed. No committee step can block it.
////
//// Cancel and refund pay the whole UTxO (less its marker) to the owner, in an
//// output tagged with this pledge's own output reference, so one payout can
//// never satisfy two pledges.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{Script}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use stellaris/fv2.{OfferingV2, PledgeDatum, Raising, key_of, pledge_marker, units_in}
use stellaris/outputs.{genesis_out_ok}
use stellaris/thread.{thread_name}
use stellaris/units.{rider_ok, value_clean}

pub type PledgeMint {
  MintPledge
  BurnPledges
}

pub type PledgeAction {
  SettlePledge
  CancelPledge { out_ix: Int }
  RefundPledge { out_ix: Int }
}

fn at(o: Output, hash: ByteArray) -> Bool {
  o.address.payment_credential == Script(hash)
}

fn holds_marker(v: Value, own: PolicyId) -> Bool {
  assets.quantity_of(v, own, pledge_marker) == 1
}

/// The genuine State of `offering` among `inputs`: the UTxO at the offering
/// script carrying its thread token.
fn state_in(inputs: List<Input>, offering: PolicyId) -> OfferingV2 {
  expect Some(i) =
    list.find(
      inputs,
      fn(i) {
        at(i.output, offering) && assets.quantity_of(
          i.output.value,
          offering,
          thread_name,
        ) == 1
      },
    )
  expect InlineDatum(raw) = i.output.datum
  expect s: OfferingV2 = raw
  s
}

/// Output `ix` pays the owner, tagged with this pledge's reference, at least
/// every asset the pledge held other than its marker.
fn returned(
  tx: Transaction,
  ix: Int,
  own_ref: OutputReference,
  owner: address.Address,
  held: Value,
  own: PolicyId,
) -> Bool {
  expect Some(o) = list.at(tx.outputs, ix)
  o.address == owner && o.datum == InlineDatum(own_ref) && list.all(
    assets.flatten(held),
    fn(a) {
      let (p, n, q) = a
      ( p == own && n == pledge_marker ) || assets.quantity_of(o.value, p, n) >= q
    },
  )
}

/// This transaction burns pledge markers (`BurnPledges` then checks the count).
fn burns(tx: Transaction, own: PolicyId) -> Bool {
  assets.quantity_of(tx.mint, own, pledge_marker) < 0
}

validator pledge(_version: Int) {
  mint(action: PledgeMint, own: PolicyId, tx: Transaction) {
    let moved = dict.to_pairs(assets.tokens(tx.mint, own))
    when action is {
      MintPledge -> {
        expect [out] = list.filter(tx.outputs, fn(o) { at(o, own) })
        expect InlineDatum(raw) = out.datum
        expect pd: PledgeDatum = raw
        let s = state_in(tx.reference_inputs, pd.offering)
        let t = s.terms
        expect Finite(lo) = tx.validity_range.lower_bound.bound_type
        expect Finite(hi) = tx.validity_range.upper_bound.bound_type
        let rest = assets.add(out.value, own, pledge_marker, -1)
        and {
          moved == [Pair(pledge_marker, 1)],
          genesis_out_ok(out, own),
          holds_marker(out.value, own),
          value_clean(rest, t.unit_policy, t.unit_name),
          rider_ok(rest),
          pd.qty > 0,
          units_in(rest, t.unit_policy, t.unit_name) == pd.qty * t.price,
          key_of(pd.owner) != None,
          s.status == Raising,
          pd.created == lo,
          hi <= t.deadline,
        }
      }
      BurnPledges -> {
        let marked =
          list.length(
            list.filter(
              tx.inputs,
              fn(i) { at(i.output, own) && holds_marker(i.output.value, own) },
            ),
          )
        and {
          marked > 0,
          moved == [Pair(pledge_marker, -marked)],
        }
      }
    }
  }

  spend(
    datum: Option<PledgeDatum>,
    action: PledgeAction,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(pd) = datum
    expect Some(me) = list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
    expect Script(own) = me.output.address.payment_credential
    let held = me.output.value
    let marked = holds_marker(held, own)
    when action is {
      SettlePledge -> {
        // The genuine State is spent here; its `Settle` checks this pledge,
        // and the State refuses pledges in any other action.
        marked && burns(tx, own) && list.any(
          tx.inputs,
          fn(i) {
            at(i.output, pd.offering) && assets.quantity_of(
              i.output.value,
              pd.offering,
              thread_name,
            ) == 1
          },
        )
      }
      CancelPledge { out_ix } -> {
        expect Some(k) = key_of(pd.owner)
        let s = state_in(tx.reference_inputs, pd.offering)
        and {
          marked,
          burns(tx, own),
          list.has(tx.extra_signatories, k),
          s.status == Raising,
          when tx.validity_range.upper_bound.bound_type is {
            Finite(hi) -> hi <= s.terms.deadline
            _ -> False
          },
          returned(tx, out_ix, own_ref, pd.owner, held, own),
        }
      }
      RefundPledge { out_ix } ->
        returned(tx, out_ix, own_ref, pd.owner, held, own) && if marked {
          let s = state_in(tx.reference_inputs, pd.offering)
          burns(tx, own) && (
            s.status != Raising || when
              tx.validity_range.lower_bound.bound_type
            is {
              Finite(lo) -> lo > s.terms.deadline + s.terms.settle_window
              _ -> False
            }
          )
        } else {
          True
        }
    }
  }

  else(_) {
    fail
  }
}
