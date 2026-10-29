//// Test fixture for fraction_vault v2: one TSRA-denominated offering
//// (Preprod's payout unit, D3), three committee keys, an issuer, a keeper,
//// a treasury, an SPV and three investors. Used only by tests.

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  placeholder,
}
use stellaris/fv2.{
  Book, OfferingV2, PledgeDatum, Raising, Status, Terms, pledge_marker,
}
use stellaris/thread.{thread_name}

// --- hashes (28 bytes) ------------------------------------------------

pub const oh: ByteArray =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

pub const ph: ByteArray =
  #"9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a"

pub const fp: PolicyId =
  #"fafafafafafafafafafafafafafafafafafafafafafafafafafafafa"

/// TSRA on Preprod is 938b32e0…; any 28 bytes serve the fixture.
pub const up: PolicyId =
  #"75757575757575757575757575757575757575757575757575757575"

pub const un: ByteArray = "TSRA"

pub const elig: PolicyId =
  #"e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1"

pub const c1: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

pub const c2: ByteArray =
  #"c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"

pub const c3: ByteArray =
  #"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"

pub const issuer: ByteArray =
  #"15151515151515151515151515151515151515151515151515151515"

pub const keeper: ByteArray =
  #"6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e"

pub const treas: ByteArray =
  #"7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e7e"

pub const spv: ByteArray =
  #"5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b"

pub const alice: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

pub const bob: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

pub const carol: ByteArray =
  #"ca7aca7aca7aca7aca7aca7aca7aca7aca7aca7aca7aca7aca7aca7a"

pub const mallory: ByteArray =
  #"bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0"

// "ph-solar-01"
pub const asset: ByteArray = #"70682d736f6c61722d3031"

pub const seed: OutputReference =
  OutputReference {
    transaction_id: #"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed",
    output_index: 0,
  }

pub const s_ref: OutputReference =
  OutputReference {
    transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
    output_index: 0,
  }

pub const p_tx: ByteArray =
  #"7070707070707070707070707070707070707070707070707070707070707070"

// --- terms and time -----------------------------------------------------

/// 10 TSRA (6 decimals) per fraction.
pub const price: Int = 10_000_000

pub const t0: Int = 1_790_000_000_000

pub const dl: Int = 1_800_000_000_000

/// 7 days.
pub const win: Int = 604_800_000

pub const rider: Int = 3_000_000

pub fn terms() -> Terms {
  Terms {
    total_fractions: 1_000,
    soft_cap: 400,
    price,
    deadline: dl,
    settle_window: win,
    retained: 0,
    docs_hash: #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0",
    spv_payout: VerificationKey(spv),
    treasury: treas,
    issuer,
    keeper,
    fraction_policy: fp,
    eligibility_policy: None,
    unit_policy: up,
    unit_name: un,
  }
}

pub fn book(
  settled: Int,
  outstanding: Int,
  escrowed: Int,
  released: Int,
  fees: Int,
  pool: Int,
  net: Int,
) -> Book {
  Book { settled, outstanding, escrowed, released, fees, pool, net_proceeds: net }
}

pub fn empty_book() -> Book {
  book(0, 0, 0, 0, 0, 0, 0)
}

pub fn state(status: Status, b: Book) -> OfferingV2 {
  OfferingV2 {
    status,
    terms: terms(),
    book: b,
    fee_bps: 100,
    period: 0,
    manifest_root: #"",
    committee: [c1, c2, c3],
    threshold: 2,
  }
}

/// A raise with `n` fractions settled at 1% fee.
pub fn raised(n: Int) -> OfferingV2 {
  let cost = n * price
  state(Raising, book(n, n, cost, 0, cost / 100, 0, 0))
}

pub fn key_addr(k: ByteArray) -> Address {
  address.from_verification_key(k)
}

// --- outputs and inputs -------------------------------------------------

/// The genuine State: thread token, rider, and exactly the accounted units.
pub fn state_out(d: OfferingV2) -> Output {
  Output {
    address: address.from_script(oh),
    value: assets.from_lovelace(rider)
      |> assets.add(oh, thread_name, 1)
      // computed here, not with fv2.accounted, so a broken formula is caught
      |> assets.add(up, un, d.book.escrowed - d.book.released + d.book.pool),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn state_in(d: OfferingV2) -> Input {
  Input { output_reference: s_ref, output: state_out(d) }
}

pub fn pledge_datum(owner: ByteArray, qty: Int) -> PledgeDatum {
  PledgeDatum { offering: oh, owner: key_addr(owner), qty, created: t0 }
}

/// A marked, well-formed pledge holding exactly `qty * price` TSRA.
pub fn pledge_out(owner: ByteArray, qty: Int) -> Output {
  Output {
    address: address.from_script(ph),
    value: assets.from_lovelace(2_000_000)
      |> assets.add(ph, pledge_marker, 1)
      |> assets.add(up, un, qty * price),
    datum: InlineDatum(pledge_datum(owner, qty)),
    reference_script: None,
  }
}

pub fn p_ref(ix: Int) -> OutputReference {
  OutputReference { transaction_id: p_tx, output_index: ix }
}

pub fn input(ix: Int, o: Output) -> Input {
  Input { output_reference: p_ref(ix), output: o }
}

pub fn key_out(k: ByteArray, v: Value) -> Output {
  Output {
    address: key_addr(k),
    value: v,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn fractions(qty: Int) -> Value {
  assets.from_lovelace(2_000_000) |> assets.add(fp, asset, qty)
}

pub fn tsra(amount: Int) -> Value {
  assets.from_lovelace(2_000_000) |> assets.add(up, un, amount)
}

/// Funds of whoever builds the transaction (fee input).
pub fn wallet_in(k: ByteArray) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      output_index: 0,
    },
    output: key_out(k, assets.from_lovelace(50_000_000)),
  }
}

pub fn between(lo: Int, hi: Int) -> interval.Interval<Int> {
  interval.between(lo, hi)
}

// --- Settle -----------------------------------------------------------

/// The State after settling pledges of `ps` (owner, qty) on top of `d`.
pub fn settled(d: OfferingV2, ps: List<(ByteArray, Int)>) -> OfferingV2 {
  let q = list.foldr(ps, 0, fn(p, acc) { acc + p.2nd })
  let cost = q * price
  let b = d.book
  OfferingV2 {
    ..d,
    book: Book {
      ..b,
      settled: b.settled + q,
      outstanding: b.outstanding + q,
      escrowed: b.escrowed + cost,
      // fee computed here, not with fv2.bps_of
      fees: b.fees + cost * d.fee_bps / 10_000,
    },
  }
}

/// A keeper's batch: the State first, then one pledge per (owner, qty);
/// outputs are the new State then each owner's fractions.
pub fn settle_tx(d: OfferingV2, ps: List<(ByteArray, Int)>) -> Transaction {
  let q = list.foldr(ps, 0, fn(p, acc) { acc + p.2nd })
  Transaction {
    ..placeholder,
    inputs: [
      state_in(d),
      ..list.indexed_map(ps, fn(i, p) { input(i, pledge_out(p.1st, p.2nd)) })
    ],
    outputs: [
      state_out(settled(d, ps)),
      ..list.map(ps, fn(p) { key_out(p.1st, fractions(p.2nd)) })
    ],
    mint: assets.from_asset(fp, asset, q)
      |> assets.add(ph, pledge_marker, -list.length(ps)),
    extra_signatories: [keeper],
    validity_range: between(t0, dl),
  }
}

/// `n` pledges of 1..n fractions, rotating over three investors (budget runs).
pub fn batch(n: Int) -> List<(ByteArray, Int)> {
  list.map(
    list.range(1, n),
    fn(i) {
      let who =
        when i % 3 is {
          0 -> alice
          1 -> bob
          _ -> carol
        }
      (who, i)
    },
  )
}
