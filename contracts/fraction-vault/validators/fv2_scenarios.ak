//// fraction_vault v2 — whole-transaction tests (SPEC-v2.md §5, §8).
////
//// `accepts` plays the ledger's part for scripts: it runs every script the
//// transaction would trigger — `offering_v2` for each State input, `pledge`
//// for each pledge input, and each minting policy present in `mint` — and
//// accepts only if all of them do. Attacks are tested against that whole
//// set, so a rule enforced by any one script counts.
////
//// Each attack is a small change to an accepted base transaction; the base is
//// tested too, so a rejection can only come from the change.

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, Transaction, placeholder}
use fraction_v2
use offering_v2.{
  BeginWindDown, CancelRaise, ClaimFee, CloseRaise, CommitPeriod, FailRaise,
  OfferingAction, Redeem, RefundFraction, Release, Rotate, SetFees, Settle,
}
use pledge.{
  BurnPledges, CancelPledge, MintPledge, PledgeAction, PledgeMint, RefundPledge,
  SettlePledge,
}
use stellaris/fv2.{
  Book, Closed, OfferingV2, Operating, PledgeDatum, Raising, Refunding,
  WindingDown, pledge_marker,
}
use stellaris/fv2_fixture.{
  alice, asset, between, bob, book, c1, c2, c3, carol, dl, elig, empty_book, fp,
  fractions, input, issuer, keeper, key_out, mallory, oh, p_ref, ph,
  pledge_datum, pledge_out, price, raised, seed, settle_tx, settled,
  spv, state, state_in, state_out, t0, terms, treas, tsra, un, up, wallet_in,
  win,
}
use stellaris/thread.{thread_name}

// ------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------

fn run(
  tx: Transaction,
  act: Option<OfferingAction>,
  pact: fn(Input) -> PledgeAction,
  pmint: Option<PledgeMint>,
) -> Bool {
  let spends =
    list.all(
      tx.inputs,
      fn(i) {
        when i.output.address.payment_credential is {
          Script(h) ->
            if h == oh {
              expect Some(a) = act
              expect InlineDatum(raw) = i.output.datum
              expect d: OfferingV2 = raw
              offering_v2.offering_v2.spend(
                0,
                asset,
                up,
                un,
                ph,
                seed,
                Some(d),
                a,
                i.output_reference,
                tx,
              )
            } else if h == ph {
              expect InlineDatum(raw) = i.output.datum
              expect d: PledgeDatum = raw
              pledge.pledge.spend(0, Some(d), pact(i), i.output_reference, tx)
            } else {
              True
            }
          _ -> True
        }
      },
    )
  let mints =
    list.all(
      assets.policies(tx.mint),
      fn(p) {
        if p == oh {
          offering_v2.offering_v2.mint(0, asset, up, un, ph, seed, Void, oh, tx)
        } else if p == ph {
          expect Some(m) = pmint
          pledge.pledge.mint(0, m, ph, tx)
        } else if p == fp {
          fraction_v2.fraction_v2.mint(oh, asset, Void, fp, tx)
        } else {
          True
        }
      },
    )
  spends && mints
}

/// A State action with no pledges involved.
fn act(tx: Transaction, a: OfferingAction) -> Bool {
  run(tx, Some(a), fn(_) { fail }, None)
}

fn settle(tx: Transaction) -> Bool {
  run(tx, Some(Settle), fn(_) { SettlePledge }, Some(BurnPledges))
}

/// A State transition `d -> n` signed by `signers`, outputs after the State.
fn step(
  d: OfferingV2,
  n: OfferingV2,
  extra_outs: List<Output>,
  mint: assets.Value,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [state_in(d)],
    outputs: [state_out(n), ..extra_outs],
    mint: mint,
    extra_signatories: signers,
    validity_range: between(t0, dl),
  }
}

const board: List<ByteArray> = [c1, c2]

fn with_book(d: OfferingV2, b: Book) -> OfferingV2 {
  OfferingV2 { ..d, book: b }
}

fn with_status(d: OfferingV2, s: fv2.Status) -> OfferingV2 {
  OfferingV2 { ..d, status: s }
}

fn swap_out(tx: Transaction, ix: Int, o: Output) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.indexed_map(
      tx.outputs,
      fn(i, x) {
        if i == ix {
          o
        } else {
          x
        }
      },
    ),
  }
}

// ==================================================================
// Open (thread token)
// ==================================================================

fn open_tx(d: OfferingV2, signers: List<ByteArray>) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [
      Input {
        output_reference: seed,
        output: key_out(issuer, assets.from_lovelace(50_000_000)),
      },
    ],
    outputs: [state_out(d)],
    mint: assets.from_asset(oh, thread_name, 1),
    extra_signatories: signers,
    validity_range: between(t0, dl),
  }
}

fn open_ok(d: OfferingV2, signers: List<ByteArray>) -> Bool {
  run(open_tx(d, signers), None, fn(_) { fail }, None)
}

test open_accepts_a_fresh_raise() {
  open_ok(state(Raising, empty_book()), [issuer, c1, c2])
}

test open_needs_the_seed() fail {
  let tx = open_tx(state(Raising, empty_book()), [issuer, c1, c2])
  run(
    Transaction { ..tx, inputs: [wallet_in(issuer)] },
    None,
    fn(_) { fail },
    None,
  )
}

test open_needs_the_issuer() fail {
  open_ok(state(Raising, empty_book()), [c1, c2])
}

test open_needs_the_committee_threshold() fail {
  open_ok(state(Raising, empty_book()), [issuer, c1])
}

test open_cannot_start_with_fractions_settled() fail {
  open_ok(raised(10), [issuer, c1, c2])
}

test open_cannot_start_operating() fail {
  open_ok(state(Operating, empty_book()), [issuer, c1, c2])
}

test open_rejects_a_fee_over_the_cap() fail {
  open_ok(OfferingV2 { ..state(Raising, empty_book()), fee_bps: 501 }, [issuer, c1, c2])
}

test open_rejects_a_soft_cap_above_the_hard_cap() fail {
  let d = state(Raising, empty_book())
  open_ok(
    OfferingV2 { ..d, terms: fv2.Terms { ..terms(), soft_cap: 1_001 } },
    [issuer, c1, c2],
  )
}

test open_rejects_a_unit_other_than_the_parameter() fail {
  let d = state(Raising, empty_book())
  open_ok(
    OfferingV2 { ..d, terms: fv2.Terms { ..terms(), unit_name: "USDM" } },
    [issuer, c1, c2],
  )
}

test open_rejects_a_bad_committee() fail {
  open_ok(
    OfferingV2 { ..state(Raising, empty_book()), committee: [c1, c1], threshold: 2 },
    [issuer, c1, c2],
  )
}

test open_after_the_deadline_is_rejected() fail {
  let tx = open_tx(state(Raising, empty_book()), [issuer, c1, c2])
  run(
    Transaction { ..tx, validity_range: between(t0, dl + 1) },
    None,
    fn(_) { fail },
    None,
  )
}

test open_with_units_already_inside_is_rejected() fail {
  let d = state(Raising, empty_book())
  let o = state_out(d)
  run(
    swap_out(
      open_tx(d, [issuer, c1, c2]),
      0,
      Output { ..o, value: assets.add(o.value, up, un, 5) },
    ),
    None,
    fn(_) { fail },
    None,
  )
}

test open_under_a_stake_credential_is_rejected() fail {
  let d = state(Raising, empty_book())
  let o = state_out(d)
  let staked =
    Output {
      ..o,
      address: Address {
        ..o.address,
        stake_credential: Some(address.Inline(VerificationKey(mallory))),
      },
    }
  run(swap_out(open_tx(d, [issuer, c1, c2]), 0, staked), None, fn(_) { fail }, None)
}

test open_cannot_mint_two_thread_tokens() fail {
  let tx = open_tx(state(Raising, empty_book()), [issuer, c1, c2])
  run(
    Transaction { ..tx, mint: assets.from_asset(oh, thread_name, 2) },
    None,
    fn(_) { fail },
    None,
  )
}

test open_rejects_a_book_claiming_fractions_without_units() fail {
  open_ok(state(Raising, book(10, 10, 0, 0, 0, 0, 0)), [issuer, c1, c2])
}

test open_cannot_happen_while_a_state_is_spent() fail {
  let d = state(Raising, empty_book())
  let tx = open_tx(d, [issuer, c1, c2])
  run(
    Transaction { ..tx, inputs: [state_in(raised(10)), ..tx.inputs] },
    Some(Settle),
    fn(_) { fail },
    None,
  )
}

test open_must_start_at_period_zero() fail {
  open_ok(OfferingV2 { ..state(Raising, empty_book()), period: 1 }, [issuer, c1, c2])
}

test open_must_start_without_a_manifest_root() fail {
  open_ok(
    OfferingV2 {
      ..state(Raising, empty_book()),
      manifest_root: #"abababababababababababababababababababababababababababababababab",
    },
    [issuer, c1, c2],
  )
}

test open_rejects_a_duplicate_committee_member() fail {
  open_ok(
    OfferingV2 { ..state(Raising, empty_book()), committee: [c1, c2, c2], threshold: 2 },
    [issuer, c1, c2],
  )
}

test open_rejects_another_unit_policy() fail {
  let d = state(Raising, empty_book())
  open_ok(
    OfferingV2 { ..d, terms: fv2.Terms { ..terms(), unit_policy: mallory } },
    [issuer, c1, c2],
  )
}

test open_rejects_junk_beside_the_thread_token() fail {
  let d = state(Raising, empty_book())
  let o = state_out(d)
  run(
    swap_out(
      open_tx(d, [issuer, c1, c2]),
      0,
      Output { ..o, value: assets.add(o.value, mallory, "junk", 1) },
    ),
    None,
    fn(_) { fail },
    None,
  )
}

// ==================================================================
// Pledge (mint a marked pledge)
// ==================================================================

fn pledge_tx(o: Output, lo: Int, hi: Int, live: OfferingV2) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [wallet_in(alice)],
    reference_inputs: [state_in(live)],
    outputs: [o],
    mint: assets.from_asset(ph, pledge_marker, 1),
    extra_signatories: [alice],
    validity_range: between(lo, hi),
  }
}

fn pledge_ok(tx: Transaction) -> Bool {
  run(tx, None, fn(_) { fail }, Some(MintPledge))
}

test pledge_accepts_exact_deposit_before_the_deadline() {
  pledge_ok(pledge_tx(pledge_out(alice, 5), t0, dl, raised(0)))
}

test pledge_with_the_wrong_amount_is_rejected() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(Output { ..o, value: assets.add(o.value, up, un, -1) }, t0, dl, raised(0)),
  )
}

test pledge_overpaying_is_rejected_too() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(Output { ..o, value: assets.add(o.value, up, un, 1) }, t0, dl, raised(0)),
  )
}

test pledge_after_the_deadline_is_rejected() fail {
  pledge_ok(pledge_tx(pledge_out(alice, 5), t0, dl + 1, raised(0)))
}

test pledge_must_record_its_real_start_time() fail {
  // datum says created = t0, but the transaction starts later
  pledge_ok(pledge_tx(pledge_out(alice, 5), t0 + 1, dl, raised(0)))
}

test pledge_once_the_raise_is_closed_is_rejected() fail {
  pledge_ok(
    pledge_tx(pledge_out(alice, 5), t0, dl, with_status(raised(400), Operating)),
  )
}

test pledge_against_a_planted_state_is_rejected() fail {
  let live = state_in(raised(0))
  let o = live.output
  let planted =
    Input {
      ..live,
      output: Output { ..o, value: assets.add(o.value, oh, thread_name, -1) },
    }
  let tx = pledge_tx(pledge_out(alice, 5), t0, dl, raised(0))
  pledge_ok(Transaction { ..tx, reference_inputs: [planted] })
}

test pledge_for_another_offering_is_rejected() fail {
  let o = pledge_out(alice, 5)
  let other =
    #"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"
  pledge_ok(
    pledge_tx(
      Output {
        ..o,
        datum: InlineDatum(PledgeDatum { ..pledge_datum(alice, 5), offering: other }),
      },
      t0,
      dl,
      raised(0),
    ),
  )
}

test pledge_cannot_mint_two_markers() fail {
  let o = pledge_out(alice, 5)
  let tx =
    pledge_tx(
      Output { ..o, value: assets.add(o.value, ph, pledge_marker, 1) },
      t0,
      dl,
      raised(0),
    )
  pledge_ok(Transaction { ..tx, mint: assets.from_asset(ph, pledge_marker, 2) })
}

test pledge_owner_must_be_a_key() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(
      Output {
        ..o,
        datum: InlineDatum(
          PledgeDatum { ..pledge_datum(alice, 5), owner: address.from_script(oh) },
        ),
      },
      t0,
      dl,
      raised(0),
    ),
  )
}

test pledge_with_a_junk_token_is_rejected() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(Output { ..o, value: assets.add(o.value, mallory, "x", 1) }, t0, dl, raised(0)),
  )
}

test pledge_of_zero_fractions_is_rejected() fail {
  pledge_ok(pledge_tx(pledge_out(alice, 0), t0, dl, raised(0)))
}

// ==================================================================
// Settle
// ==================================================================

test settle_one_pledge() {
  settle(settle_tx(raised(0), [(alice, 5)]))
}

test settle_a_batch_of_three() {
  settle(settle_tx(raised(100), [(alice, 5), (bob, 20), (carol, 1)]))
}

test settle_by_the_committee_instead_of_the_keeper() {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, extra_signatories: board })
}

test settle_needs_the_keeper_or_the_committee() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, extra_signatories: [alice, c1] })
}

test settle_beyond_the_hard_cap_is_rejected() fail {
  settle(settle_tx(raised(996), [(alice, 5)]))
}

test settle_up_to_the_hard_cap_exactly() {
  settle(settle_tx(raised(995), [(alice, 5)]))
}

test settle_after_the_settle_window_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, validity_range: between(t0, dl + win + 1) })
}

test settle_inside_the_settle_window() {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, validity_range: between(dl + 1, dl + win) })
}

test settle_once_closed_is_rejected() fail {
  settle(settle_tx(with_status(raised(400), Operating), [(alice, 5)]))
}

test settle_paying_fractions_to_someone_else_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(swap_out(tx, 1, key_out(mallory, fractions(5))))
}

test settle_paying_short_fractions_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5), (bob, 2)])
  // alice gets 4, the fifth goes to bob: total still matches the mint
  settle(
    swap_out(swap_out(tx, 1, key_out(alice, fractions(4))), 2, key_out(bob, fractions(3))),
  )
}

test settle_minting_more_than_recorded_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, mint: assets.add(tx.mint, fp, asset, 1) })
}

test settle_minting_a_second_token_name_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, mint: assets.add(tx.mint, fp, "other", 1) })
}

test settle_recording_too_few_fees_is_rejected() fail {
  let d = raised(0)
  let tx = settle_tx(d, [(alice, 50)])
  let n = settled(d, [(alice, 50)])
  let cheap = with_book(n, Book { ..n.book, fees: 0 })
  settle(swap_out(tx, 0, state_out(cheap)))
}

test settle_recording_more_than_was_paid_in_is_rejected() fail {
  // the State claims 6 fractions for a 5-fraction pledge
  let d = raised(0)
  let tx = settle_tx(d, [(alice, 5)])
  let n = settled(d, [(alice, 6)])
  settle(Transaction { ..swap_out(tx, 0, state_out(n)), mint: assets.from_asset(fp, asset, 6) |> assets.add(ph, pledge_marker, -1) })
}

test settle_of_an_unmarked_pledge_is_rejected() fail {
  // what a cancelled or forged pledge looks like: no marker
  let tx = settle_tx(raised(0), [(alice, 5)])
  expect [s, p] = tx.inputs
  let o = p.output
  let bare = Output { ..o, value: assets.add(o.value, ph, pledge_marker, -1) }
  settle(
    Transaction {
      ..tx,
      inputs: [s, Input { ..p, output: bare }],
      mint: assets.from_asset(fp, asset, 5),
    },
  )
}

test settle_double_counting_one_pledge_is_rejected() fail {
  // one pledge input, but the State and the payouts count it twice
  let d = raised(0)
  let tx = settle_tx(d, [(alice, 5)])
  settle(
    Transaction {
      ..tx,
      outputs: [
        state_out(settled(d, [(alice, 5), (alice, 5)])),
        key_out(alice, fractions(5)),
        key_out(alice, fractions(5)),
      ],
      mint: assets.from_asset(fp, asset, 10) |> assets.add(ph, pledge_marker, -1),
    },
  )
}

test settle_of_a_pledge_for_another_offering_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  expect [s, p] = tx.inputs
  let o = p.output
  let other =
    #"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"
  let moved =
    Output {
      ..o,
      datum: InlineDatum(PledgeDatum { ..pledge_datum(alice, 5), offering: other }),
    }
  settle(Transaction { ..tx, inputs: [s, Input { ..p, output: moved }] })
}

test settle_keeping_the_owners_rider_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(
    swap_out(
      tx,
      1,
      key_out(alice, assets.from_lovelace(1_000_000) |> assets.add(fp, asset, 5)),
    ),
  )
}

test settle_without_burning_the_marker_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, mint: assets.from_asset(fp, asset, 5) })
}

test settle_burning_too_few_markers_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5), (bob, 2)])
  settle(
    Transaction {
      ..tx,
      mint: assets.from_asset(fp, asset, 7) |> assets.add(ph, pledge_marker, -1),
    },
  )
}

fn eligible_raise() -> OfferingV2 {
  let d = raised(0)
  OfferingV2 { ..d, terms: fv2.Terms { ..terms(), eligibility_policy: Some(elig) } }
}

fn pass_for(k: ByteArray) -> Input {
  Input {
    output_reference: p_ref(90),
    output: key_out(k, assets.from_lovelace(2_000_000) |> assets.add(elig, k, 1)),
  }
}

test settle_with_eligibility_accepts_a_holder() {
  let tx = settle_tx(eligible_raise(), [(alice, 5)])
  settle(Transaction { ..tx, reference_inputs: [pass_for(alice)] })
}

test settle_with_eligibility_rejects_a_non_holder() fail {
  let tx = settle_tx(eligible_raise(), [(alice, 5)])
  settle(Transaction { ..tx, reference_inputs: [pass_for(bob)] })
}

test settle_pledge_without_the_state_is_rejected() fail {
  // spend a pledge with SettlePledge while the State stays put
  let p = input(0, pledge_out(alice, 5))
  run(
    Transaction {
      ..placeholder,
      inputs: [p],
      outputs: [key_out(mallory, assets.from_lovelace(2_000_000) |> assets.add(up, un, 50_000_000))],
      mint: assets.from_asset(ph, pledge_marker, -1),
      validity_range: between(t0, dl),
    },
    None,
    fn(_) { SettlePledge },
    Some(BurnPledges),
  )
}

test settle_with_zero_pledges_is_rejected() fail {
  settle(settle_tx(raised(0), []))
}

// ==================================================================
// End of the raise
// ==================================================================

fn closed_from(d: OfferingV2) -> OfferingV2 {
  OfferingV2 {
    ..d,
    status: Operating,
    book: Book { ..d.book, net_proceeds: d.book.escrowed - d.book.fees },
  }
}

test close_at_the_soft_cap() {
  let d = raised(400)
  act(step(d, closed_from(d), [], assets.zero, board), CloseRaise)
}

test close_below_the_soft_cap_is_rejected() fail {
  let d = raised(399)
  act(step(d, closed_from(d), [], assets.zero, board), CloseRaise)
}

test close_needs_the_committee() fail {
  let d = raised(400)
  act(step(d, closed_from(d), [], assets.zero, [c1, keeper]), CloseRaise)
}

test close_must_record_net_proceeds() fail {
  let d = raised(400)
  let n = closed_from(d)
  act(step(d, with_book(n, Book { ..n.book, net_proceeds: d.book.escrowed }), [], assets.zero, board), CloseRaise)
}

fn refunding_from(d: OfferingV2) -> OfferingV2 {
  OfferingV2 { ..d, status: Refunding, book: Book { ..d.book, fees: 0 } }
}

fn after_window(tx: Transaction) -> Transaction {
  Transaction { ..tx, validity_range: between(dl + win + 1, dl + win + 1000) }
}

test fail_raise_below_the_soft_cap_after_the_window_needs_no_one() {
  let d = raised(399)
  act(after_window(step(d, refunding_from(d), [], assets.zero, [])), FailRaise)
}

test fail_raise_at_the_soft_cap_is_rejected() fail {
  let d = raised(400)
  act(after_window(step(d, refunding_from(d), [], assets.zero, [])), FailRaise)
}

test fail_raise_inside_the_window_is_rejected() fail {
  let d = raised(10)
  act(step(d, refunding_from(d), [], assets.zero, []), FailRaise)
}

test fail_raise_must_cancel_the_fees() fail {
  let d = raised(10)
  act(after_window(step(d, with_status(d, Refunding), [], assets.zero, [])), FailRaise)
}

test fail_raise_exactly_at_the_end_of_the_window_is_rejected() fail {
  let d = raised(10)
  let tx = step(d, refunding_from(d), [], assets.zero, [])
  act(Transaction { ..tx, validity_range: between(dl + win, dl + win + 1000) }, FailRaise)
}

test fail_raise_without_a_start_time_is_rejected() fail {
  let d = raised(10)
  let tx = step(d, refunding_from(d), [], assets.zero, [])
  act(Transaction { ..tx, validity_range: interval.before(dl + win + 1000) }, FailRaise)
}

test settle_without_an_end_time_is_rejected() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, validity_range: interval.after(t0) })
}

test settle_exactly_at_the_end_of_the_window() {
  let tx = settle_tx(raised(0), [(alice, 5)])
  settle(Transaction { ..tx, validity_range: between(dl, dl + win) })
}

test cancel_raise_by_the_committee() {
  let d = raised(500)
  act(step(d, refunding_from(d), [], assets.zero, board), CancelRaise)
}

test cancel_raise_needs_the_committee() fail {
  let d = raised(500)
  act(step(d, refunding_from(d), [], assets.zero, [c1]), CancelRaise)
}

test close_after_a_cancelled_raise_is_rejected() fail {
  // cancelled with the soft cap met: the escrow is owed back to holders and
  // must never become releasable
  let d = refunding_from(raised(500))
  act(step(d, closed_from(d), [], assets.zero, board), CloseRaise)
}

test close_cannot_reopen_a_winding_down_offering() fail {
  let d0 = closed_from(raised(500))
  let d = with_status(d0, WindingDown)
  act(step(d, closed_from(d), [], assets.zero, board), CloseRaise)
}

test fail_raise_cannot_reopen_a_closed_offering() fail {
  let d = with_status(refunding_from(raised(10)), Closed)
  act(after_window(step(d, refunding_from(d), [], assets.zero, [])), FailRaise)
}

test cancel_raise_cannot_go_straight_to_operating() fail {
  let d = raised(500)
  act(step(d, closed_from(d), [], assets.zero, board), CancelRaise)
}

test cancel_raise_must_cancel_the_fees() fail {
  let d = raised(500)
  act(step(d, with_status(d, Refunding), [], assets.zero, board), CancelRaise)
}

test cancel_raise_once_operating_is_rejected() fail {
  let d = closed_from(raised(500))
  act(step(d, refunding_from(d), [], assets.zero, board), CancelRaise)
}

// ==================================================================
// Refunds: fractions (Refunding) and pledges (anyone, no committee)
// ==================================================================

fn refund_fraction_tx(d: OfferingV2, qty: Int) -> Transaction {
  let b = d.book
  let left = b.outstanding - qty
  let n =
    OfferingV2 {
      ..d,
      status: if left == 0 {
        Closed
      } else {
        Refunding
      },
      book: Book { ..b, outstanding: left, escrowed: b.escrowed - qty * price },
    }
  Transaction {
    ..step(d, n, [key_out(alice, tsra(qty * price))], assets.from_asset(fp, asset, -qty), []),
    inputs: [state_in(d), wallet_in(alice)],
  }
}

test refund_fraction_pays_the_price_with_no_committee() {
  act(refund_fraction_tx(refunding_from(raised(10)), 3), RefundFraction { qty: 3 })
}

test refund_of_the_last_fraction_closes_the_offering() {
  act(refund_fraction_tx(refunding_from(raised(10)), 10), RefundFraction { qty: 10 })
}

test refund_fraction_while_raising_is_rejected() fail {
  act(refund_fraction_tx(raised(10), 3), RefundFraction { qty: 3 })
}

test refund_fraction_while_operating_is_rejected() fail {
  let d = closed_from(raised(400))
  act(refund_fraction_tx(with_status(d, Refunding) |> with_status(Operating), 3), RefundFraction { qty: 3 })
}

test refund_fraction_overpaying_is_rejected() fail {
  let d = refunding_from(raised(10))
  let tx = refund_fraction_tx(d, 3)
  expect [s, ..rest] = tx.outputs
  let n = state_of(s)
  let greedy = with_book(n, Book { ..n.book, escrowed: n.book.escrowed - 1 })
  act(Transaction { ..tx, outputs: [state_out(greedy), ..rest] }, RefundFraction { qty: 3 })
}

test refund_fraction_without_burning_is_rejected() fail {
  let tx = refund_fraction_tx(refunding_from(raised(10)), 3)
  act(Transaction { ..tx, mint: assets.zero }, RefundFraction { qty: 3 })
}

test refund_more_fractions_than_outstanding_is_rejected() fail {
  act(refund_fraction_tx(refunding_from(raised(10)), 11), RefundFraction { qty: 11 })
}

fn state_of(o: Output) -> OfferingV2 {
  expect InlineDatum(raw) = o.datum
  expect d: OfferingV2 = raw
  d
}

/// Return `pledge_out(alice, 5)` to alice, tagged with its reference.
fn refund_out(owner: ByteArray, qty: Int, ix: Int) -> Output {
  Output {
    ..key_out(owner, assets.from_lovelace(2_000_000) |> assets.add(up, un, qty * price)),
    datum: InlineDatum(p_ref(ix)),
  }
}

fn pledge_refund_tx(live: OfferingV2, lo: Int, hi: Int) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: [input(0, pledge_out(alice, 5)), wallet_in(mallory)],
    reference_inputs: [state_in(live)],
    outputs: [refund_out(alice, 5, 0)],
    mint: assets.from_asset(ph, pledge_marker, -1),
    extra_signatories: [],
    validity_range: between(lo, hi),
  }
}

fn refund(tx: Transaction) -> Bool {
  run(tx, None, fn(i) { RefundPledge { out_ix: i.output_reference.output_index } }, Some(BurnPledges))
}

test refund_pledge_after_a_failed_raise_needs_no_one() {
  refund(pledge_refund_tx(refunding_from(raised(10)), t0, dl))
}

test refund_pledge_after_the_window_even_while_raising() {
  refund(pledge_refund_tx(raised(10), dl + win + 1, dl + win + 1000))
}

test refund_pledge_once_the_raise_closed() {
  refund(pledge_refund_tx(closed_from(raised(400)), t0, dl))
}

test refund_pledge_while_the_raise_is_live_is_rejected() fail {
  refund(pledge_refund_tx(raised(10), t0, dl))
}

test refund_pledge_paid_to_someone_else_is_rejected() fail {
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(swap_out(tx, 0, refund_out(mallory, 5, 0)))
}

test refund_pledge_short_paid_is_rejected() fail {
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  let o = refund_out(alice, 5, 0)
  refund(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, up, un, -1) }))
}

test refund_pledge_without_the_tag_is_rejected() fail {
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(swap_out(tx, 0, key_out(alice, assets.from_lovelace(2_000_000) |> assets.add(up, un, 50_000_000))))
}

test one_payout_cannot_refund_two_pledges() fail {
  // two identical pledges of alice, one payout: the tag names one of them
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(
    Transaction {
      ..tx,
      inputs: [input(0, pledge_out(alice, 5)), input(1, pledge_out(alice, 5)), wallet_in(mallory)],
      outputs: [refund_out(alice, 5, 0), refund_out(alice, 5, 0)],
      mint: assets.from_asset(ph, pledge_marker, -2),
    },
  )
}

test two_pledges_refunded_in_one_transaction() {
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(
    Transaction {
      ..tx,
      inputs: [input(0, pledge_out(alice, 5)), input(1, pledge_out(alice, 5)), wallet_in(mallory)],
      outputs: [refund_out(alice, 5, 0), refund_out(alice, 5, 1)],
      mint: assets.from_asset(ph, pledge_marker, -2),
    },
  )
}

test refund_pledge_keeping_the_marker_is_rejected() fail {
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(Transaction { ..tx, mint: assets.zero })
}

test refund_of_an_unmarked_utxo_any_time() {
  // not a pledge (no marker): anyone may send it back to its owner
  let o = pledge_out(alice, 5)
  let bare = Output { ..o, value: assets.add(o.value, ph, pledge_marker, -1) }
  let tx = pledge_refund_tx(raised(10), t0, dl)
  refund(Transaction { ..tx, inputs: [input(0, bare), wallet_in(mallory)], reference_inputs: [], mint: assets.zero })
}

test refund_pledge_next_to_a_state_action_is_rejected() fail {
  // a pledge cannot leave beside any State action other than Settle
  let d = closed_from(raised(400))
  let n = OfferingV2 { ..d, period: 1, manifest_root: #"abababababababababababababababababababababababababababababababab" }
  let tx = step(d, n, [refund_out(alice, 5, 1)], assets.from_asset(ph, pledge_marker, -1), board)
  run(
    Transaction { ..tx, inputs: [state_in(d), input(1, pledge_out(alice, 5))] },
    Some(CommitPeriod { period: 1, manifest_root: n.manifest_root }),
    fn(_) { SettlePledge },
    Some(BurnPledges),
  )
}

fn cancel(tx: Transaction) -> Bool {
  run(tx, None, fn(i) { CancelPledge { out_ix: i.output_reference.output_index } }, Some(BurnPledges))
}

test cancel_pledge_by_its_owner_before_the_deadline() {
  let tx = pledge_refund_tx(raised(10), t0, dl)
  cancel(Transaction { ..tx, extra_signatories: [alice] })
}

test cancel_pledge_by_anyone_else_is_rejected() fail {
  let tx = pledge_refund_tx(raised(10), t0, dl)
  cancel(Transaction { ..tx, extra_signatories: [mallory, c1, c2] })
}

test cancel_pledge_after_the_deadline_is_rejected() fail {
  let tx = pledge_refund_tx(raised(10), dl, dl + 10)
  cancel(Transaction { ..tx, extra_signatories: [alice] })
}

test cancel_pledge_once_closed_is_rejected() fail {
  let tx = pledge_refund_tx(closed_from(raised(400)), t0, dl)
  cancel(Transaction { ..tx, extra_signatories: [alice] })
}

// ==================================================================
// Operating: release, periods, fees, committee
// ==================================================================

/// 500 fractions raised at 10 TSRA, 1% fee: net 4,950 TSRA.
fn operating() -> OfferingV2 {
  closed_from(raised(500))
}

fn release_tx(d: OfferingV2, amount: Int, to: ByteArray) -> Transaction {
  let n = with_book(d, Book { ..d.book, released: d.book.released + amount })
  step(d, n, [key_out(to, tsra(amount))], assets.zero, board)
}

const evidence: ByteArray =
  #"e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5"

test release_to_the_spv_within_the_cap() {
  act(release_tx(operating(), 1_000_000_000, spv), Release { amount: 1_000_000_000, evidence_hash: evidence })
}

test release_of_all_net_proceeds() {
  let d = operating()
  let all = d.book.net_proceeds
  act(release_tx(d, all, spv), Release { amount: all, evidence_hash: evidence })
}

test release_above_the_cap_is_rejected() fail {
  let d = operating()
  let all = d.book.net_proceeds + 1
  act(release_tx(d, all, spv), Release { amount: all, evidence_hash: evidence })
}

test release_cannot_touch_the_retained_amount() fail {
  let d0 = operating()
  let d = OfferingV2 { ..d0, terms: fv2.Terms { ..terms(), retained: 100_000_000 } }
  let amount = d.book.net_proceeds - 99_999_999
  act(release_tx(d, amount, spv), Release { amount: amount, evidence_hash: evidence })
}

test release_to_another_address_is_rejected() fail {
  act(release_tx(operating(), 1_000_000_000, mallory), Release { amount: 1_000_000_000, evidence_hash: evidence })
}

test release_while_raising_is_rejected() fail {
  let d = with_status(operating(), Raising)
  act(release_tx(d, 1_000_000, spv), Release { amount: 1_000_000, evidence_hash: evidence })
}

test release_in_winding_down_is_rejected() fail {
  let d = with_status(operating(), WindingDown)
  act(release_tx(d, 1_000_000, spv), Release { amount: 1_000_000, evidence_hash: evidence })
}

test release_needs_the_committee() fail {
  let tx = release_tx(operating(), 1_000_000, spv)
  act(Transaction { ..tx, extra_signatories: [c3] }, Release { amount: 1_000_000, evidence_hash: evidence })
}

test release_needs_a_32_byte_evidence_hash() fail {
  act(release_tx(operating(), 1_000_000, spv), Release { amount: 1_000_000, evidence_hash: #"e5" })
}

test release_recording_less_than_it_pays_is_rejected() fail {
  let d = operating()
  // the State books 1 TSRA released but actually gives up 2
  let lie = with_book(d, Book { ..d.book, released: d.book.released + 1_000_000 })
  let o = state_out(lie)
  let tx = step(d, lie, [key_out(spv, tsra(2_000_000))], assets.zero, board)
  act(
    swap_out(tx, 0, Output { ..o, value: assets.add(o.value, up, un, -1_000_000) }),
    Release { amount: 1_000_000, evidence_hash: evidence },
  )
}

const root1: ByteArray =
  #"abababababababababababababababababababababababababababababababab"

test commit_period_records_the_next_root() {
  let d = operating()
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: root1 }, [], assets.zero, board), CommitPeriod { period: 1, manifest_root: root1 })
}

test commit_period_cannot_skip_a_period() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, period: 2, manifest_root: root1 }, [], assets.zero, board), CommitPeriod { period: 2, manifest_root: root1 })
}

test commit_period_needs_a_32_byte_root() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: #"ab" }, [], assets.zero, board), CommitPeriod { period: 1, manifest_root: #"ab" })
}

test commit_period_while_raising_is_rejected() fail {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: root1 }, [], assets.zero, board), CommitPeriod { period: 1, manifest_root: root1 })
}

test commit_period_cannot_move_money() fail {
  let d = operating()
  let n = OfferingV2 { ..d, period: 1, manifest_root: root1, book: Book { ..d.book, released: 1 } }
  act(step(d, n, [key_out(spv, tsra(1))], assets.zero, board), CommitPeriod { period: 1, manifest_root: root1 })
}

test set_fees_while_raising() {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, fee_bps: 250 }, [], assets.zero, board), SetFees { fee_bps: 250 })
}

test set_fees_above_the_cap_is_rejected() fail {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, fee_bps: 501 }, [], assets.zero, board), SetFees { fee_bps: 501 })
}

test set_fees_after_the_raise_is_rejected() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, fee_bps: 250 }, [], assets.zero, board), SetFees { fee_bps: 250 })
}

fn claim_tx(d: OfferingV2, amount: Int, to: ByteArray) -> Transaction {
  let n = with_book(d, Book { ..d.book, fees: d.book.fees - amount, escrowed: d.book.escrowed - amount })
  step(d, n, [key_out(to, tsra(amount))], assets.zero, board)
}

test claim_fee_pays_the_treasury() {
  let d = operating()
  act(claim_tx(d, d.book.fees, treas), ClaimFee { amount: d.book.fees })
}

test claim_fee_to_anyone_else_is_rejected() fail {
  let d = operating()
  act(claim_tx(d, d.book.fees, c1), ClaimFee { amount: d.book.fees })
}

test claim_fee_above_what_accrued_is_rejected() fail {
  let d = operating()
  act(claim_tx(d, d.book.fees + 1, treas), ClaimFee { amount: d.book.fees + 1 })
}

test claim_fee_during_the_raise_is_rejected() fail {
  let d = raised(500)
  act(claim_tx(d, d.book.fees, treas), ClaimFee { amount: d.book.fees })
}

test rotate_the_committee() {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [c2, c3, mallory], threshold: 2 }, [], assets.zero, board), Rotate { committee: [c2, c3, mallory], threshold: 2 })
}

test rotate_needs_the_current_committee() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [mallory], threshold: 1 }, [], assets.zero, [c1, mallory]), Rotate { committee: [mallory], threshold: 1 })
}

test rotate_to_a_malformed_committee_is_rejected() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [c2], threshold: 2 }, [], assets.zero, board), Rotate { committee: [c2], threshold: 2 })
}

// --- each committee action needs the committee and changes only its field

test commit_period_needs_the_committee() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: root1 }, [], assets.zero, [c3]), CommitPeriod { period: 1, manifest_root: root1 })
}

test commit_period_cannot_change_the_status() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: root1, status: WindingDown }, [], assets.zero, board), CommitPeriod { period: 1, manifest_root: root1 })
}

test set_fees_needs_the_committee() fail {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, fee_bps: 250 }, [], assets.zero, [c3, keeper]), SetFees { fee_bps: 250 })
}

test set_fees_cannot_set_another_rate_than_named() fail {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, fee_bps: 300 }, [], assets.zero, board), SetFees { fee_bps: 250 })
}

test set_fees_cannot_change_the_status() fail {
  let d = raised(10)
  act(step(d, OfferingV2 { ..d, fee_bps: 250, status: Refunding }, [], assets.zero, board), SetFees { fee_bps: 250 })
}

test claim_fee_needs_the_committee() fail {
  let d = operating()
  let tx = claim_tx(d, d.book.fees, treas)
  act(Transaction { ..tx, extra_signatories: [treas, c3] }, ClaimFee { amount: d.book.fees })
}

test claim_fee_cannot_change_the_status() fail {
  let d = operating()
  let tx = claim_tx(d, d.book.fees, treas)
  expect [s, ..rest] = tx.outputs
  let n = with_status(state_of(s), WindingDown)
  act(Transaction { ..tx, outputs: [state_out(n), ..rest] }, ClaimFee { amount: d.book.fees })
}

test claim_fee_of_a_negative_amount_is_rejected() fail {
  let d = operating()
  act(claim_tx(d, -5_000_000, treas), ClaimFee { amount: -5_000_000 })
}

test claim_fee_of_more_than_named_is_rejected() fail {
  // the redeemer names 1 TSRA, the book and the payout take 2
  let d = operating()
  act(claim_tx(d, 2_000_000, treas), ClaimFee { amount: 1_000_000 })
}

test release_cannot_change_the_status() fail {
  let d = operating()
  let tx = release_tx(d, 1_000_000, spv)
  expect [s, ..rest] = tx.outputs
  let n = with_status(state_of(s), WindingDown)
  act(Transaction { ..tx, outputs: [state_out(n), ..rest] }, Release { amount: 1_000_000, evidence_hash: evidence })
}

test release_of_a_negative_amount_is_rejected() fail {
  let d = with_book(operating(), Book { ..operating().book, released: 10_000_000 })
  act(release_tx(d, -5_000_000, spv), Release { amount: -5_000_000, evidence_hash: evidence })
}

test rotate_cannot_install_another_committee_than_named() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [mallory], threshold: 1 }, [], assets.zero, board), Rotate { committee: [c2, c3, mallory], threshold: 2 })
}

test rotate_cannot_change_the_status() fail {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [c2, c3, mallory], threshold: 2, status: WindingDown }, [], assets.zero, board), Rotate { committee: [c2, c3, mallory], threshold: 2 })
}

test refund_fraction_of_a_negative_quantity_is_rejected() fail {
  // would mint new fractions during a refund
  act(refund_fraction_tx(refunding_from(raised(10)), -3), RefundFraction { qty: -3 })
}

// ==================================================================
// Winding down
// ==================================================================

fn wind_down(d: OfferingV2, final_pool: Int) -> OfferingV2 {
  let b = d.book
  OfferingV2 {
    ..d,
    status: WindingDown,
    book: Book { ..b, escrowed: b.released + b.fees, pool: b.pool + final_pool + b.escrowed - b.released - b.fees },
  }
}

/// Operating with 1,000 TSRA released and fees unclaimed.
fn running() -> OfferingV2 {
  let d = operating()
  with_book(d, Book { ..d.book, released: 1_000_000_000 })
}

test begin_wind_down_moves_unreleased_escrow_into_the_pool() {
  let d = running()
  let tx = step(d, wind_down(d, 6_000_000_000), [], assets.zero, board)
  act(Transaction { ..tx, inputs: [state_in(d), wallet_in(spv)] }, BeginWindDown { final_pool: 6_000_000_000 })
}

test begin_wind_down_cannot_sweep_the_fees_into_the_pool() fail {
  let d = running()
  let n = wind_down(d, 0)
  let greedy = with_book(n, Book { ..n.book, escrowed: d.book.released, pool: n.book.pool + d.book.fees })
  act(step(d, greedy, [], assets.zero, board), BeginWindDown { final_pool: 0 })
}

test begin_wind_down_needs_the_committee() fail {
  let d = running()
  act(step(d, wind_down(d, 0), [], assets.zero, [c1]), BeginWindDown { final_pool: 0 })
}

test begin_wind_down_while_raising_is_rejected() fail {
  let d = with_status(running(), Raising)
  act(step(d, wind_down(d, 0), [], assets.zero, board), BeginWindDown { final_pool: 0 })
}

test begin_wind_down_cannot_take_units_out() fail {
  // a negative final pool would move escrow out of the State
  let d = running()
  act(step(d, wind_down(d, -1_000_000_000), [key_out(c1, tsra(1_000_000_000))], assets.zero, board), BeginWindDown { final_pool: -1_000_000_000 })
}

test begin_wind_down_cannot_change_the_committee() fail {
  let d = running()
  act(step(d, OfferingV2 { ..wind_down(d, 0), committee: [mallory], threshold: 1 }, [], assets.zero, board), BeginWindDown { final_pool: 0 })
}

test redeem_of_a_negative_quantity_is_rejected() fail {
  act(redeem_tx(winding(), -7), Redeem { qty: -7 })
}

test redeem_of_a_negative_quantity_after_redemptions_is_rejected() fail {
  // after holders redeemed, outstanding < settled: a negative redeem would
  // mint fractions back for nothing and dilute everyone else
  let d0 = winding()
  let d = with_book(d0, Book { ..d0.book, outstanding: 490 })
  let n = with_book(d, Book { ..d.book, outstanding: 497 })
  act(
    Transaction {
      ..step(d, n, [key_out(mallory, fractions(7))], assets.from_asset(fp, asset, 7), []),
      inputs: [state_in(d), wallet_in(mallory)],
    },
    Redeem { qty: -7 },
  )
}

fn redeem_tx(d: OfferingV2, qty: Int) -> Transaction {
  let b = d.book
  let left = b.outstanding - qty
  let pay = b.pool * qty / b.outstanding
  let n =
    OfferingV2 {
      ..d,
      status: if left == 0 {
        Closed
      } else {
        WindingDown
      },
      book: Book { ..b, outstanding: left, pool: b.pool - pay },
    }
  Transaction {
    ..step(d, n, [key_out(bob, tsra(pay))], assets.from_asset(fp, asset, -qty), []),
    inputs: [state_in(d), wallet_in(bob)],
  }
}

fn winding() -> OfferingV2 {
  wind_down(running(), 6_000_000_001)
}

test redeem_pays_pro_rata_with_no_committee() {
  act(redeem_tx(winding(), 7), Redeem { qty: 7 })
}

test redeem_of_the_last_fractions_closes_the_offering() {
  act(redeem_tx(winding(), 500), Redeem { qty: 500 })
}

test redeem_overpaying_by_one_unit_is_rejected() fail {
  let d = winding()
  let tx = redeem_tx(d, 7)
  expect [s, ..rest] = tx.outputs
  let n = state_of(s)
  let greedy = with_book(n, Book { ..n.book, pool: n.book.pool - 1 })
  act(Transaction { ..tx, outputs: [state_out(greedy), ..rest] }, Redeem { qty: 7 })
}

test redeem_while_operating_is_rejected() fail {
  act(redeem_tx(with_status(winding(), Operating), 7), Redeem { qty: 7 })
}

test redeem_without_burning_is_rejected() fail {
  let tx = redeem_tx(winding(), 7)
  act(Transaction { ..tx, mint: assets.zero }, Redeem { qty: 7 })
}

test claim_fee_after_closing() {
  let d = with_status(winding(), Closed)
  act(claim_tx(d, d.book.fees, treas), ClaimFee { amount: d.book.fees })
}

// ==================================================================
// Structural invariants (every redeemer)
// ==================================================================

/// The base for structural attacks: an accepted CommitPeriod.
fn commit_tx() -> Transaction {
  let d = operating()
  step(d, OfferingV2 { ..d, period: 1, manifest_root: root1 }, [], assets.zero, board)
}

fn commit(tx: Transaction) -> Bool {
  act(tx, CommitPeriod { period: 1, manifest_root: root1 })
}

test inv1_a_state_without_the_thread_token_cannot_be_spent() fail {
  let tx = commit_tx()
  expect [s] = tx.inputs
  let o = s.output
  let planted = Input { ..s, output: Output { ..o, value: assets.add(o.value, oh, thread_name, -1) } }
  commit(Transaction { ..tx, inputs: [planted] })
}

test inv1_the_state_cannot_shed_its_thread_token() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, oh, thread_name, -1) }))
}

test inv1_two_state_outputs_are_rejected() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(Transaction { ..tx, outputs: [o, Output { ..o, value: assets.add(o.value, oh, thread_name, -1) }] })
}

test inv1_the_state_must_be_the_first_output() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(Transaction { ..tx, outputs: [key_out(c1, assets.from_lovelace(2_000_000)), o] })
}

test inv1_two_state_inputs_are_rejected() fail {
  let tx = commit_tx()
  expect [s] = tx.inputs
  let o = s.output
  let second = Input { output_reference: p_ref(7), output: Output { ..o, value: assets.add(o.value, oh, thread_name, -1) } }
  commit(Transaction { ..tx, inputs: [s, second] })
}

test inv2_token_flood_on_the_state_is_rejected() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, mallory, "junk", 1) }))
}

test inv2_a_second_name_under_the_unit_policy_is_rejected() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, up, "OTHER", 1) }))
}

test inv3_fractions_cannot_be_minted_outside_settle() fail {
  let tx = commit_tx()
  commit(Transaction { ..tx, mint: assets.from_asset(fp, asset, 1) })
}

test inv3_fractions_cannot_be_burned_outside_refund_or_redeem() fail {
  let tx = commit_tx()
  commit(Transaction { ..tx, mint: assets.from_asset(fp, asset, -1) })
}

test inv3_fraction_policy_alone_cannot_mint() fail {
  // no State spent: the policy has nothing to derive a supply from
  run(
    Transaction {
      ..placeholder,
      inputs: [wallet_in(mallory)],
      outputs: [key_out(mallory, fractions(5))],
      mint: assets.from_asset(fp, asset, 5),
    },
    None,
    fn(_) { fail },
    None,
  )
}

test inv3_fraction_policy_refuses_an_offering_naming_another_policy() fail {
  let d0 = raised(0)
  let d = OfferingV2 { ..d0, terms: fv2.Terms { ..terms(), fraction_policy: mallory } }
  fraction_v2.fraction_v2.mint(oh, asset, Void, fp, settle_tx(d, [(alice, 5)]))
}

test inv4_the_state_cannot_keep_unaccounted_units() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, up, un, 1) }))
}

test inv4_the_state_cannot_lose_units_quietly() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(Transaction { ..tx, outputs: [Output { ..o, value: assets.add(o.value, up, un, -1) }, key_out(mallory, tsra(1))] })
}

test inv4_the_state_keeps_its_rider() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, value: assets.add(o.value, #"", #"", -1) }))
}

test inv6_terms_are_immutable() fail {
  let d = operating()
  let n = OfferingV2 { ..d, period: 1, manifest_root: root1, terms: fv2.Terms { ..terms(), spv_payout: VerificationKey(mallory) } }
  commit(step(d, n, [], assets.zero, board))
}

test inv6_the_committee_moves_only_by_rotate() fail {
  let d = operating()
  let n = OfferingV2 { ..d, period: 1, manifest_root: root1, committee: [mallory], threshold: 1 }
  commit(step(d, n, [], assets.zero, board))
}

test f6_the_state_cannot_move_under_a_stake_credential() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, address: Address { ..o.address, stake_credential: Some(address.Inline(VerificationKey(mallory))) } }))
}

test f6_the_state_cannot_carry_a_reference_script() fail {
  let tx = commit_tx()
  expect [o] = tx.outputs
  commit(swap_out(tx, 0, Output { ..o, reference_script: Some(mallory) }))
}

test commit_fixture_is_accepted() {
  commit(commit_tx())
}

// ==================================================================
// Budget: Settle at N = 1, 5, 10, 20 (SPEC-v2.md §8)
// ==================================================================
//
// `settle_cost_N` runs every script in a batch of N pledges; `settle_fixture_N`
// only builds the same transaction. The scripts' cost is the difference
// (scripts/contracts/fv2-budget-report.mjs computes it).

fn fixture_only(tx: Transaction) -> Bool {
  list.length(tx.inputs) > 0 && list.length(tx.outputs) > 0 && tx.mint != assets.zero
}

test settle_cost_1() {
  settle(settle_tx(raised(0), fv2_fixture.batch(1)))
}

test settle_fixture_1() {
  fixture_only(settle_tx(raised(0), fv2_fixture.batch(1)))
}

test settle_cost_5() {
  settle(settle_tx(raised(0), fv2_fixture.batch(5)))
}

test settle_fixture_5() {
  fixture_only(settle_tx(raised(0), fv2_fixture.batch(5)))
}

test settle_cost_10() {
  settle(settle_tx(raised(0), fv2_fixture.batch(10)))
}

test settle_fixture_10() {
  fixture_only(settle_tx(raised(0), fv2_fixture.batch(10)))
}

test settle_cost_20() {
  settle(settle_tx(raised(0), fv2_fixture.batch(20)))
}

test settle_fixture_20() {
  fixture_only(settle_tx(raised(0), fv2_fixture.batch(20)))
}

test settle_cost_25() {
  settle(settle_tx(raised(0), fv2_fixture.batch(25)))
}

test settle_fixture_25() {
  fixture_only(settle_tx(raised(0), fv2_fixture.batch(25)))
}

// ==================================================================
// Each script on its own
// ==================================================================
//
// Some rules are checked by two scripts (defence in depth). The whole-
// transaction tests above pass if either script refuses, so these run one
// script alone to show each copy of a rule works by itself.

fn offering_alone(tx: Transaction, a: OfferingAction) -> Bool {
  expect Some(s) =
    list.find(tx.inputs, fn(i) { i.output.address.payment_credential == Script(oh) })
  expect InlineDatum(raw) = s.output.datum
  expect d: OfferingV2 = raw
  offering_v2.offering_v2.spend(0, asset, up, un, ph, seed, Some(d), a, s.output_reference, tx)
}

fn fraction_alone(tx: Transaction) -> Bool {
  fraction_v2.fraction_v2.mint(oh, asset, Void, fp, tx)
}

/// Replace the second input (the first pledge) of a Settle transaction.
fn with_pledge(tx: Transaction, o: Output) -> Transaction {
  expect [s, p, ..rest] = tx.inputs
  Transaction { ..tx, inputs: [s, Input { ..p, output: o }, ..rest] }
}

test alone_settle_base_is_accepted_by_the_state() {
  offering_alone(settle_tx(raised(0), [(alice, 5)]), Settle)
}

test alone_state_refuses_an_unmarked_pledge() fail {
  let o = pledge_out(alice, 5)
  offering_alone(
    with_pledge(
      settle_tx(raised(0), [(alice, 5)]),
      Output { ..o, value: assets.add(o.value, ph, pledge_marker, -1) },
    ),
    Settle,
  )
}

test alone_state_refuses_a_pledge_for_another_offering() fail {
  let o = pledge_out(alice, 5)
  let other =
    #"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"
  offering_alone(
    with_pledge(
      settle_tx(raised(0), [(alice, 5)]),
      Output {
        ..o,
        datum: InlineDatum(PledgeDatum { ..pledge_datum(alice, 5), offering: other }),
      },
    ),
    Settle,
  )
}

test alone_state_refuses_a_pledge_holding_the_wrong_amount() fail {
  let o = pledge_out(alice, 5)
  offering_alone(
    with_pledge(
      settle_tx(raised(0), [(alice, 5)]),
      Output { ..o, value: assets.add(o.value, up, un, -1) },
    ),
    Settle,
  )
}

test alone_state_refuses_a_pledge_dated_after_the_deadline() fail {
  let o = pledge_out(alice, 5)
  offering_alone(
    with_pledge(
      settle_tx(raised(0), [(alice, 5)]),
      Output {
        ..o,
        datum: InlineDatum(PledgeDatum { ..pledge_datum(alice, 5), created: dl + 1 }),
      },
    ),
    Settle,
  )
}

test alone_state_refuses_a_zero_fraction_pledge_in_a_batch() fail {
  offering_alone(settle_tx(raised(0), [(alice, 5), (bob, 0)]), Settle)
}

test alone_state_refuses_a_mint_that_differs_from_the_book() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  offering_alone(Transaction { ..tx, mint: assets.add(tx.mint, fp, asset, 1) }, Settle)
}

test alone_fraction_policy_accepts_the_base() {
  fraction_alone(settle_tx(raised(0), [(alice, 5)]))
}

test alone_fraction_policy_refuses_more_than_the_book() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  fraction_alone(Transaction { ..tx, mint: assets.add(tx.mint, fp, asset, 1) })
}

test alone_fraction_policy_refuses_a_second_name() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  fraction_alone(Transaction { ..tx, mint: assets.add(tx.mint, fp, "x", 1) })
}

test alone_fraction_policy_refuses_a_flat_book() fail {
  let d = raised(0)
  let tx = settle_tx(d, [(alice, 5)])
  fraction_alone(swap_out(tx, 0, state_out(d)))
}

test alone_fraction_policy_refuses_a_planted_state() fail {
  let tx = settle_tx(raised(0), [(alice, 5)])
  expect [s, ..rest] = tx.inputs
  let o = s.output
  fraction_alone(
    Transaction {
      ..tx,
      inputs: [Input { ..s, output: Output { ..o, value: assets.add(o.value, oh, thread_name, -1) } }, ..rest],
    },
  )
}

test alone_state_accepts_a_pledge_dated_exactly_at_the_deadline() {
  let o = pledge_out(alice, 5)
  offering_alone(
    with_pledge(
      settle_tx(raised(0), [(alice, 5)]),
      Output {
        ..o,
        datum: InlineDatum(PledgeDatum { ..pledge_datum(alice, 5), created: dl }),
      },
    ),
    Settle,
  )
}

test pledge_cannot_mint_a_spare_marker_to_another_wallet() fail {
  // a spare marker could later be planted in a forged pledge
  let tx = pledge_tx(pledge_out(alice, 5), t0, dl, raised(0))
  pledge_ok(
    Transaction {
      ..tx,
      outputs: [
        pledge_out(alice, 5),
        key_out(mallory, assets.from_lovelace(2_000_000) |> assets.add(ph, pledge_marker, 1)),
      ],
      mint: assets.from_asset(ph, pledge_marker, 2),
    },
  )
}

test begin_wind_down_with_no_sale_proceeds() {
  // e.g. the asset was written off: holders share only the unreleased escrow
  let d = running()
  act(step(d, wind_down(d, 0), [], assets.zero, board), BeginWindDown { final_pool: 0 })
}

test pledge_under_a_stake_credential_is_rejected() fail {
  // F-6: a pledge sits at the pledge script's enterprise address
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(
      Output {
        ..o,
        address: Address {
          ..o.address,
          stake_credential: Some(address.Inline(VerificationKey(mallory))),
        },
      },
      t0,
      dl,
      raised(0),
    ),
  )
}

test pledge_with_a_reference_script_is_rejected() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(pledge_tx(Output { ..o, reference_script: Some(mallory) }, t0, dl, raised(0)))
}

test cancel_pledge_keeping_the_marker_is_rejected() fail {
  // a kept marker could later be planted in a forged pledge
  let tx = pledge_refund_tx(raised(10), t0, dl)
  cancel(
    Transaction {
      ..tx,
      outputs: [
        Output {
          ..refund_out(alice, 5, 0),
          value: assets.from_lovelace(2_000_000)
            |> assets.add(up, un, 50_000_000)
            |> assets.add(ph, pledge_marker, 1),
        },
      ],
      mint: assets.zero,
      extra_signatories: [alice],
    },
  )
}

test pledge_with_less_than_the_rider_is_rejected() fail {
  let o = pledge_out(alice, 5)
  pledge_ok(
    pledge_tx(Output { ..o, value: assets.add(o.value, #"", #"", -1_000_001) }, t0, dl, raised(0)),
  )
}

test cancel_pledge_paid_to_someone_else_is_rejected() fail {
  let tx = pledge_refund_tx(raised(10), t0, dl)
  cancel(Transaction { ..swap_out(tx, 0, refund_out(mallory, 5, 0)), extra_signatories: [alice] })
}

test refund_pledge_exactly_at_the_end_of_the_window_is_rejected() fail {
  refund(pledge_refund_tx(raised(10), dl + win, dl + win + 1000))
}

test refund_pledge_without_a_start_time_while_raising_is_rejected() fail {
  let tx = pledge_refund_tx(raised(10), t0, dl)
  refund(Transaction { ..tx, validity_range: interval.before(dl + win + 1000) })
}

test refund_a_stray_utxo_and_a_pledge_together() {
  // the stray UTxO (no marker) is not counted in the marker burn
  let o = pledge_out(alice, 5)
  let bare = Output { ..o, value: assets.add(o.value, ph, pledge_marker, -1) }
  let tx = pledge_refund_tx(refunding_from(raised(10)), t0, dl)
  refund(
    Transaction {
      ..tx,
      inputs: [input(0, pledge_out(alice, 5)), input(1, bare), wallet_in(mallory)],
      outputs: [refund_out(alice, 5, 0), refund_out(alice, 5, 1)],
      mint: assets.from_asset(ph, pledge_marker, -1),
    },
  )
}

test refund_of_a_stray_utxo_returns_every_asset() fail {
  // a foreign token that happens to be called "pledge" must go back too
  let o = pledge_out(alice, 5)
  let bare =
    Output {
      ..o,
      value: assets.add(o.value, ph, pledge_marker, -1) |> assets.add(mallory, pledge_marker, 1),
    }
  let tx = pledge_refund_tx(raised(10), t0, dl)
  refund(
    Transaction {
      ..tx,
      inputs: [input(0, bare), wallet_in(mallory)],
      reference_inputs: [],
      mint: assets.zero,
    },
  )
}

fn open_with_terms(t: fv2.Terms) -> Bool {
  open_ok(OfferingV2 { ..state(Raising, empty_book()), terms: t }, [issuer, c1, c2])
}

test open_rejects_a_zero_soft_cap() fail {
  open_with_terms(fv2.Terms { ..terms(), soft_cap: 0 })
}

test open_rejects_a_zero_price() fail {
  open_with_terms(fv2.Terms { ..terms(), price: 0 })
}

test open_rejects_a_negative_retained_amount() fail {
  open_with_terms(fv2.Terms { ..terms(), retained: -1 })
}

test cancel_pledge_without_an_end_time_is_rejected() fail {
  let tx = pledge_refund_tx(raised(10), t0, dl)
  cancel(Transaction { ..tx, validity_range: interval.after(t0), extra_signatories: [alice] })
}

test refund_pledge_inside_the_settle_window_while_raising_is_rejected() fail {
  refund(pledge_refund_tx(raised(10), dl + 1, dl + 1000))
}

test open_rejects_a_short_treasury_key() fail {
  open_with_terms(fv2.Terms { ..terms(), treasury: #"7e" })
}

test open_rejects_a_docs_hash_that_is_not_32_bytes() fail {
  open_with_terms(fv2.Terms { ..terms(), docs_hash: #"d0d0" })
}

test open_rejects_a_fraction_policy_that_is_not_28_bytes() fail {
  open_with_terms(fv2.Terms { ..terms(), fraction_policy: #"fa" })
}

test open_rejects_a_negative_settle_window() fail {
  open_with_terms(fv2.Terms { ..terms(), settle_window: -1 })
}

test redeem_more_than_outstanding_is_rejected() fail {
  // the contract pays 0 when qty > outstanding; only the counter check stops it
  let d = winding()
  let n = with_book(d, Book { ..d.book, outstanding: -1 })
  act(
    Transaction {
      ..step(d, n, [], assets.from_asset(fp, asset, -501), []),
      inputs: [state_in(d), wallet_in(bob)],
    },
    Redeem { qty: 501 },
  )
}

test release_beyond_the_cap_after_earlier_releases_is_rejected() fail {
  // 1,000 TSRA already released: only net - 1,000 TSRA remains
  let d = running()
  let room = d.book.net_proceeds - d.book.released
  act(release_tx(d, room + 1, spv), Release { amount: room + 1, evidence_hash: evidence })
}

test release_of_exactly_the_remaining_room_after_earlier_releases() {
  let d = running()
  let room = d.book.net_proceeds - d.book.released
  act(release_tx(d, room, spv), Release { amount: room, evidence_hash: evidence })
}

test a_one_of_n_committee_can_act() {
  let d0 = operating()
  let d = OfferingV2 { ..d0, committee: [c1, c2], threshold: 1 }
  act(step(d, OfferingV2 { ..d, period: 1, manifest_root: root1 }, [], assets.zero, [c2]), CommitPeriod { period: 1, manifest_root: root1 })
}

test open_with_the_soft_cap_equal_to_the_hard_cap() {
  open_with_terms(fv2.Terms { ..terms(), soft_cap: 1_000 })
}

test release_after_earlier_releases_cannot_eat_the_retained_amount() fail {
  // with 100 TSRA retained and 1,000 already released, the room is
  // net - 100 - 1,000; one unit more would come out of the hold-back
  let d0 = running()
  let d = OfferingV2 { ..d0, terms: fv2.Terms { ..terms(), retained: 100_000_000 } }
  let room = d.book.net_proceeds - 100_000_000 - d.book.released
  act(release_tx(d, room + 1, spv), Release { amount: room + 1, evidence_hash: evidence })
}

test open_with_no_settle_window() {
  open_with_terms(fv2.Terms { ..terms(), settle_window: 0 })
}

test rotate_to_a_one_of_one_committee() {
  let d = operating()
  act(step(d, OfferingV2 { ..d, committee: [c3], threshold: 1 }, [], assets.zero, board), Rotate { committee: [c3], threshold: 1 })
}
