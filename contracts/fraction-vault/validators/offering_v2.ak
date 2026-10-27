//// fraction_vault v2 — the offering State (SPEC-v2.md §3, §5.2).
////
//// One UTxO per offering, identified only by its one-shot thread token
//// (AUDIT.md F-1). It holds the counters and every deposit unit the offering
//// owns. Investors never touch it directly: they pledge into their own
//// `pledge` UTxOs, and `Settle` moves batches of pledges in.
////
//// Every spend checks, whatever the redeemer:
////
////   1. exactly one State in and one out, both carrying the thread token, the
////      output first in the transaction and at the spent State's exact
////      address with no reference script (F-6);
////   2. the State holds only lovelace, the deposit unit and its thread token;
////   3. fractions minted (or burned) under the offering's fraction policy
////      equal the change in `outstanding`, and nothing else moves under it;
////   4. the State holds exactly `escrowed - released + pool` deposit units;
////   5. `released <= net_proceeds - retained` (via `Release`, the only branch
////      that moves `released`), and the counters stay in order (`book_ok`);
////   6. the terms are unchanged;
////   7. pledges are spent only by `Settle`.
////
//// Each redeemer then states the ONE next datum it allows, as a record update
//// of the old one, so any field it does not name must be unchanged.

use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Credential, Script, VerificationKey}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction}
use stellaris/fv2.{
  Book, Closed, OfferingV2, Operating, PledgeDatum, Raising, Refunding, Terms,
  WindingDown, accounted, book_ok, bps_of, committee_ok, fee_bps_ok, key_of,
  pledge_marker, pro_rata, release_room, rider_of, terms_ok, threshold_met,
  units_in,
}
use stellaris/outputs.{continuing_ok, genesis_out_ok, keeps_lovelace}
use stellaris/thread.{holds_thread, one_shot_mint, thread_name}
use stellaris/units.{is_ada, rider_ok, unit_of, value_clean}

pub type OfferingAction {
  /// Move the pledges spent in this transaction into the State and mint each
  /// owner their fractions. Keeper or committee.
  Settle
  /// Raise succeeded: `Raising` -> `Operating`. Committee.
  CloseRaise
  /// Raise failed after the settle window: `Raising` -> `Refunding`. Anyone.
  FailRaise
  /// Stop a raise early: `Raising` -> `Refunding`. Committee.
  CancelRaise
  /// Burn `qty` fractions for `qty * price` units. Any holder, `Refunding`.
  RefundFraction { qty: Int }
  /// Pay `amount` to the SPV against reviewed evidence. Committee.
  Release { amount: Int, evidence_hash: ByteArray }
  /// Record a distribution period's manifest root. Committee.
  CommitPeriod { period: Int, manifest_root: ByteArray }
  /// Change the settlement fee while raising. Committee.
  SetFees { fee_bps: Int }
  /// Pay accrued fees to the treasury. Committee.
  ClaimFee { amount: Int }
  /// Replace the committee. Current committee.
  Rotate { committee: List<ByteArray>, threshold: Int }
  /// Pay final sale proceeds in: `Operating` -> `WindingDown`. Committee.
  BeginWindDown { final_pool: Int }
  /// Burn `qty` fractions for a pro-rata slice of the pool. Any holder.
  Redeem { qty: Int }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

fn at(o: Output, hash: ByteArray) -> Bool {
  o.address.payment_credential == Script(hash)
}

fn state_of(o: Output) -> OfferingV2 {
  expect InlineDatum(raw) = o.datum
  expect d: OfferingV2 = raw
  d
}

/// The validity range ends no later than `t`.
fn ends_by(tx: Transaction, t: Int) -> Bool {
  when tx.validity_range.upper_bound.bound_type is {
    Finite(hi) -> hi <= t
    _ -> False
  }
}

/// The validity range starts strictly after `t`.
fn starts_after(tx: Transaction, t: Int) -> Bool {
  when tx.validity_range.lower_bound.bound_type is {
    Finite(lo) -> lo > t
    _ -> False
  }
}

/// The State carries exactly one thread token and, beside it, only lovelace
/// and the deposit unit, with a min-ADA rider.
fn state_value_ok(o: Output, own: PolicyId, t: Terms) -> Bool {
  let rest = assets.add(o.value, own, thread_name, -1)
  holds_thread(o.value, own) && value_clean(rest, t.unit_policy, t.unit_name) && rider_ok(
    rest,
  )
}

/// Units of the deposit unit paid to outputs whose payment credential is `c`.
fn paid_to(tx: Transaction, c: Credential, t: Terms) -> Int {
  list.foldr(
    tx.outputs,
    0,
    fn(o: Output, acc) {
      if o.address.payment_credential == c {
        acc + unit_of(o.value, t.unit_policy, t.unit_name)
      } else {
        acc
      }
    },
  )
}

/// Under the fraction policy, exactly `delta` of the fraction token moves and
/// nothing else (invariant 3).
fn fractions_move(tx: Transaction, t: Terms, asset_id: ByteArray, delta: Int) -> Bool {
  let moved = assets.tokens(tx.mint, t.fraction_policy)
  if delta == 0 {
    dict.is_empty(moved)
  } else {
    dict.to_pairs(moved) == [Pair(asset_id, delta)]
  }
}

/// If the offering has an eligibility policy, `owner` must hold its token
/// (named by the owner's key hash) in a reference input.
fn eligible(tx: Transaction, policy: Option<PolicyId>, owner: address.Address) -> Bool {
  when policy is {
    None -> True
    Some(p) -> {
      expect Some(k) = key_of(owner)
      list.any(
        tx.reference_inputs,
        fn(i) { assets.quantity_of(i.output.value, p, k) == 1 },
      )
    }
  }
}

/// Walk the pledge inputs (in ledger order) beside the outputs that follow
/// the State, one owner output per pledge. Returns the fractions settled.
/// Any malformed pledge or payout fails the whole transaction.
fn settle_walk(
  pledges: List<Input>,
  outs: List<Output>,
  own: PolicyId,
  pledge_hash: ByteArray,
  asset_id: ByteArray,
  t: Terms,
  tx: Transaction,
  acc: Int,
) -> Int {
  when pledges is {
    [] -> acc
    [p, ..more] -> {
      expect [o, ..outs_more] = outs
      expect InlineDatum(raw) = p.output.datum
      expect pd: PledgeDatum = raw
      let v = p.output.value
      expect and {
          assets.quantity_of(v, pledge_hash, pledge_marker) == 1,
          pd.offering == own,
          pd.qty > 0,
          pd.created <= t.deadline,
          units_in(v, t.unit_policy, t.unit_name) == pd.qty * t.price,
          o.address == pd.owner,
          assets.quantity_of(o.value, t.fraction_policy, asset_id) == pd.qty,
          assets.lovelace_of(o.value) >= rider_of(v, t.unit_policy),
          eligible(tx, t.eligibility_policy, pd.owner),
        }
      settle_walk(more, outs_more, own, pledge_hash, asset_id, t, tx, acc + pd.qty)
    }
  }
}

// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator offering_v2(
  _version: Int,
  asset_id: ByteArray,
  unit_policy: PolicyId,
  unit_name: ByteArray,
  pledge_hash: ByteArray,
  seed: OutputReference,
) {
  /// `Open`: mint the one-shot thread token into a fresh `Raising` State.
  mint(_redeemer: Data, own: PolicyId, tx: Transaction) {
    expect [boot] = list.filter(tx.outputs, fn(o) { at(o, own) })
    let d = state_of(boot)
    let t = d.terms
    and {
      one_shot_mint(tx, own, seed),
      !list.any(tx.inputs, fn(i) { at(i.output, own) }),
      genesis_out_ok(boot, own),
      state_value_ok(boot, own, t),
      units_in(boot.value, unit_policy, unit_name) == 0,
      d.status == Raising,
      d.book == Book(0, 0, 0, 0, 0, 0, 0),
      fee_bps_ok(d.fee_bps),
      d.period == 0,
      d.manifest_root == #"",
      committee_ok(d.committee, d.threshold),
      terms_ok(t),
      t.unit_policy == unit_policy,
      t.unit_name == unit_name,
      list.has(tx.extra_signatories, t.issuer),
      threshold_met(d.committee, d.threshold, tx.extra_signatories),
      ends_by(tx, t.deadline),
    }
  }

  spend(
    datum: Option<OfferingV2>,
    action: OfferingAction,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(me) = list.find(tx.inputs, fn(i) { i.output_reference == own_ref })
    expect Script(own) = me.output.address.payment_credential
    // (1) the genuine State, alone, and its successor first among outputs.
    expect [_] = list.filter(tx.inputs, fn(i) { at(i.output, own) })
    expect [out, ..rest] = tx.outputs
    let n = state_of(out)
    let t = d.terms
    let b = d.book
    let pledges = list.filter(tx.inputs, fn(i) { at(i.output, pledge_hash) })
    let committee = fn() { threshold_met(d.committee, d.threshold, tx.extra_signatories) }

    let common =
      and {
        holds_thread(me.output.value, own),
        at(out, own),
        !list.any(rest, fn(o) { at(o, own) }),
        continuing_ok(out, me.output),
        state_value_ok(out, own, t),
        is_ada(unit_policy) || keeps_lovelace(out, me.output),
        // (6)
        n.terms == t,
        // (4)
        units_in(out.value, t.unit_policy, t.unit_name) == accounted(n.book),
        // (5)
        book_ok(n.book, t),
        // (3)
        fractions_move(tx, t, asset_id, n.book.outstanding - b.outstanding),
      }

    let step =
      when action is {
        Settle -> {
          let q =
            settle_walk(pledges, rest, own, pledge_hash, asset_id, t, tx, 0)
          let cost = q * t.price
          and {
            d.status == Raising,
            q > 0,
            ends_by(tx, t.deadline + t.settle_window),
            list.has(tx.extra_signatories, t.keeper) || committee(),
            n == OfferingV2 {
              ..d,
              book: Book {
                ..b,
                settled: b.settled + q,
                outstanding: b.outstanding + q,
                escrowed: b.escrowed + cost,
                fees: b.fees + bps_of(cost, d.fee_bps),
              },
            },
          }
        }

        CloseRaise ->
          and {
            committee(),
            d.status == Raising,
            b.settled >= t.soft_cap,
            n == OfferingV2 {
              ..d,
              status: Operating,
              book: Book { ..b, net_proceeds: b.escrowed - b.fees },
            },
          }

        FailRaise ->
          and {
            d.status == Raising,
            b.settled < t.soft_cap,
            starts_after(tx, t.deadline + t.settle_window),
            n == OfferingV2 { ..d, status: Refunding, book: Book { ..b, fees: 0 } },
          }

        CancelRaise ->
          and {
            committee(),
            d.status == Raising,
            n == OfferingV2 { ..d, status: Refunding, book: Book { ..b, fees: 0 } },
          }

        RefundFraction { qty } -> {
          let left = b.outstanding - qty
          and {
            d.status == Refunding,
            qty > 0,
            n == OfferingV2 {
              ..d,
              status: if left == 0 {
                Closed
              } else {
                Refunding
              },
              book: Book {
                ..b,
                outstanding: left,
                escrowed: b.escrowed - qty * t.price,
              },
            },
          }
        }

        Release { amount, evidence_hash } ->
          and {
            committee(),
            d.status == Operating,
            amount > 0,
            amount <= release_room(b, t),
            bytearray.length(evidence_hash) == 32,
            paid_to(tx, t.spv_payout, t) >= amount,
            n == OfferingV2 { ..d, book: Book { ..b, released: b.released + amount } },
          }

        CommitPeriod { period, manifest_root } ->
          and {
            committee(),
            d.status == Operating || d.status == WindingDown,
            period == d.period + 1,
            bytearray.length(manifest_root) == 32,
            n == OfferingV2 { ..d, period: period, manifest_root: manifest_root },
          }

        SetFees { fee_bps } ->
          and {
            committee(),
            d.status == Raising,
            fee_bps_ok(fee_bps),
            n == OfferingV2 { ..d, fee_bps: fee_bps },
          }

        ClaimFee { amount } ->
          and {
            committee(),
            d.status == Operating || d.status == WindingDown || d.status == Closed,
            amount > 0,
            amount <= b.fees,
            paid_to(tx, VerificationKey(t.treasury), t) >= amount,
            n == OfferingV2 {
              ..d,
              book: Book { ..b, fees: b.fees - amount, escrowed: b.escrowed - amount },
            },
          }

        Rotate { committee: c, threshold: th } ->
          and {
            committee(),
            committee_ok(c, th),
            n == OfferingV2 { ..d, committee: c, threshold: th },
          }

        BeginWindDown { final_pool } ->
          and {
            committee(),
            d.status == Operating,
            final_pool >= 0,
            n == OfferingV2 {
              ..d,
              status: WindingDown,
              book: Book {
                ..b,
                escrowed: b.released + b.fees,
                pool: b.pool + final_pool + b.escrowed - b.released - b.fees,
              },
            },
          }

        Redeem { qty } -> {
          let left = b.outstanding - qty
          and {
            d.status == WindingDown,
            qty > 0,
            n == OfferingV2 {
              ..d,
              status: if left == 0 {
                Closed
              } else {
                WindingDown
              },
              book: Book {
                ..b,
                outstanding: left,
                pool: b.pool - pro_rata(b.pool, qty, b.outstanding),
              },
            },
          }
        }
      }

    // (7) pledges move only with `Settle`.
    let pledges_ok =
      when action is {
        Settle -> True
        _ -> pledges == []
      }

    common && step && pledges_ok
  }

  else(_) {
    fail
  }
}
