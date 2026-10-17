//// Stellaris fraction vault — fractional ownership of a real-world asset.
////
//// One offering, one script UTxO. The offering holds:
////
////   * the counters (how many fractions exist, how many are outstanding,
////     the price, the pool, the unclaimed treasury fees), and
////   * the deposit units themselves — buy proceeds plus distributed income.
////
//// Ownership never lives here. Buying mints a `fraction` native token
//// straight into the buyer's wallet; it is an ordinary Cardano asset from
//// that moment on, freely transferable, visible in any wallet, with no
//// contract-side transfer restriction. Redemption burns it back.
////
//// The denomination is a parameter — `(version, asset_id, unit_policy,
//// unit_name)` — so ADA (the empty policy) and any native token share one
//// compiled script, exactly as in the multi-asset vault. Stellaris ships
//// ADA-first; a stablecoin is a new parameterisation, not a new contract.
////
//// Invariants carried over from the audited vault work:
////   * exactly one state UTxO in and one out, so the accounting branch runs
////     on every transaction and two states can never be collapsed into one;
////   * every script output is "clean" — only lovelace and the deposit unit —
////     which blocks the token-flood min-ADA lock;
////   * the committee, the treasury, the issuer, the total supply and the
////     bound fraction policy are immutable through ordinary spending;
////   * fee rates are capped and only a committee M-of-N can move them;
////   * the treasury is the only address `ClaimFee` may pay;
////   * the offering is identified by a one-shot state-thread token minted at
////     opening (validator parameter `seed`, AUDIT.md F-1). An Offering datum
////     paid here by anyone else has no token and can never be spent, so it
////     cannot be used to mint cheap fractions that redeem against the real
////     pool.

use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use stellaris/offering.{
  Closed, Offering, OfferingDatum, Open, Redeeming, Status, bps_of, buy_cost,
  fee_bps_ok, operators_valid, redeem_gross, supply_ok, threshold_met,
}
use stellaris/thread.{holds_thread, one_shot_mint, thread_name}
use stellaris/units.{is_ada, min_rider_lovelace, rider_ok, unit_of, value_clean}

pub type FractionRedeemer {
  /// Pay `qty * price` of the deposit unit, receive `qty` fraction tokens.
  Buy { qty: Int }
  /// Burn `qty` fraction tokens, take the pro-rata slice of the pool.
  Redeem { qty: Int }
  /// Pay income into the offering. Raises every holder's claim pro rata.
  Distribute { amount: Int }
  /// Committee moves the lifecycle: Open -> Closed -> Redeeming.
  SetStatus { status: Status }
  /// Committee changes the fee rates, within the hard caps.
  SetFees { mint_fee_bps: Int, redeem_fee_bps: Int }
  /// Committee pays accrued fees out to the treasury key hash.
  ClaimFee { amount: Int }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

fn own_hash(inputs: List<Input>, own_ref: OutputReference) -> Option<ByteArray> {
  when list.find(inputs, fn(i) { i.output_reference == own_ref }) is {
    Some(i) ->
      when i.output.address.payment_credential is {
        Script(h) -> Some(h)
        _ -> None
      }
    None -> None
  }
}

fn at_script(output: Output, hash: ByteArray) -> Bool {
  when output.address.payment_credential is {
    Script(h) -> h == hash
    _ -> False
  }
}

fn datum_of(output: Output) -> Option<OfferingDatum> {
  when output.datum is {
    InlineDatum(raw) -> {
      expect d: OfferingDatum = raw
      Some(d)
    }
    _ -> None
  }
}

fn script_outputs(tx: Transaction, hash: ByteArray) -> List<Output> {
  list.filter(tx.outputs, fn(o) { at_script(o, hash) })
}

fn script_inputs(tx: Transaction, hash: ByteArray) -> List<Output> {
  list.map(
    list.filter(tx.inputs, fn(i) { at_script(i.output, hash) }),
    fn(i) { i.output },
  )
}

/// Exactly one readable offering output among `outs`, else None.
fn sole_offering(outs: List<Output>) -> Option<Output> {
  when outs is {
    [only] ->
      when datum_of(only) is {
        Some(_) -> Some(only)
        None -> None
      }
    _ -> None
  }
}

/// Quantity of the fraction token this transaction mints (negative = burns).
fn fraction_minted(tx: Transaction, policy: PolicyId, name: ByteArray) -> Int {
  assets.quantity_of(tx.mint, policy, name)
}

/// Nothing else under the fraction policy may move in the same transaction.
fn only_bound_token_moves(
  tx: Transaction,
  policy: PolicyId,
  name: ByteArray,
  expected: Int,
) -> Bool {
  let moved = assets.tokens(tx.mint, policy)
  if expected == 0 {
    dict.size(moved) == 0
  } else {
    dict.size(moved) == 1 && fraction_minted(tx, policy, name) == expected
  }
}

/// Did `tx` pay at least `amount` of the deposit unit to the key hash `pkh`?
fn paid_to_key(
  tx: Transaction,
  pkh: ByteArray,
  policy: PolicyId,
  name: ByteArray,
  amount: Int,
) -> Bool {
  let total =
    list.foldr(
      tx.outputs,
      0,
      fn(o: Output, acc) {
        when o.address.payment_credential is {
          VerificationKey(k) ->
            if k == pkh {
              acc + unit_of(o.value, policy, name)
            } else {
              acc
            }
          _ -> acc
        }
      },
    )
  total >= amount
}

fn values_clean(outs: List<Output>, policy: PolicyId, name: ByteArray) -> Bool {
  list.all(
    outs,
    fn(o) { value_clean(o.value, policy, name) && rider_ok(o.value) },
  )
}

/// The offering output carries exactly one thread token and, beside it, only
/// lovelace and the deposit unit, with a min-ADA rider.
fn offering_value_ok(
  out: Output,
  own: PolicyId,
  policy: PolicyId,
  name: ByteArray,
) -> Bool {
  let rest = assets.add(out.value, own, thread_name, -1)
  holds_thread(out.value, own) && values_clean(
    [Output { ..out, value: rest }],
    policy,
    name,
  )
}

/// A freshly opened offering: nothing sold, nothing pooled, open for buying,
/// a well-formed committee and supply, fees inside the caps.
fn opening_ok(d: OfferingDatum) -> Bool {
  let Offering {
    total_fractions,
    minted,
    outstanding,
    price,
    pool,
    fees,
    operators,
    threshold,
    status,
    mint_fee_bps,
    redeem_fee_bps,
    fraction_policy,
    ..
  } = d
  minted == 0 && outstanding == 0 && pool == 0 && fees == 0 && status == Open && supply_ok(
    total_fractions,
    minted,
    outstanding,
    pool,
    fees,
    price,
  ) && operators_valid(operators, threshold) && fee_bps_ok(mint_fee_bps) && fee_bps_ok(
    redeem_fee_bps,
  ) && bytearray.length(fraction_policy) == 28
}

fn unit_total(outs: List<Output>, policy: PolicyId, name: ByteArray) -> Int {
  list.foldr(outs, 0, fn(o: Output, acc) { acc + unit_of(o.value, policy, name) })
}

// ------------------------------------------------------------------
// Validator
// ------------------------------------------------------------------

validator fraction_vault(
  _version: Int,
  asset_id: ByteArray,
  unit_policy: PolicyId,
  unit_name: ByteArray,
  seed: OutputReference,
) {
  /// Opening: mint the one-shot state-thread token into the initial
  /// Offering. The seed can be spent once, so this succeeds at most once.
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    expect [boot] = script_outputs(tx, policy_id)
    expect Some(boot_datum) = datum_of(boot)
    one_shot_mint(tx, policy_id, seed) && script_inputs(tx, policy_id) == [] && offering_value_ok(
      boot,
      policy_id,
      unit_policy,
      unit_name,
    ) && opening_ok(boot_datum)
  }

  spend(
    datum: Option<OfferingDatum>,
    redeemer: FractionRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    expect Some(hash) = own_hash(tx.inputs, own_ref)

    let ins = script_inputs(tx, hash)
    let outs = script_outputs(tx, hash)

    // Exactly one state in, exactly one state out — and both are the GENUINE
    // offering, carrying the thread token (F-1).
    expect [only_in] = ins
    expect Some(state_out) = sole_offering(outs)
    expect Some(next) = datum_of(state_out)
    let genuine = holds_thread(only_in.value, hash)

    let Offering {
      total_fractions,
      minted,
      outstanding,
      price,
      pool,
      fees,
      issuer,
      treasury,
      operators,
      threshold,
      status,
      mint_fee_bps,
      redeem_fee_bps,
      fraction_policy,
    } = d
    let Offering {
      total_fractions: n_total,
      minted: n_minted,
      outstanding: n_outstanding,
      price: n_price,
      pool: n_pool,
      fees: n_fees,
      issuer: n_issuer,
      treasury: n_treasury,
      operators: n_operators,
      threshold: n_threshold,
      status: n_status,
      mint_fee_bps: n_mint_fee_bps,
      redeem_fee_bps: n_redeem_fee_bps,
      fraction_policy: n_fraction_policy,
    } = next

    let held_in = unit_total(ins, unit_policy, unit_name)
    let held_out = unit_total(outs, unit_policy, unit_name)
    let value_delta = held_out - held_in
    let committee_signed =
      threshold_met(operators, threshold, tx.extra_signatories)

    // Facts that hold for EVERY action.
    let structural =
      genuine && offering_value_ok(state_out, hash, unit_policy, unit_name) && n_total == total_fractions && n_issuer == issuer && n_treasury == treasury && n_operators == operators && n_threshold == threshold && n_fraction_policy == fraction_policy && n_price == price && operators_valid(
        operators,
        threshold,
      ) && supply_ok(n_total, n_minted, n_outstanding, n_pool, n_fees, n_price) && fee_bps_ok(
        n_mint_fee_bps,
      ) && fee_bps_ok(n_redeem_fee_bps)

    let transition =
      when redeemer is {
        // ------------------------------------------------
        Buy { qty } -> {
          let cost = buy_cost(price, qty)
          let fee = bps_of(cost, mint_fee_bps)
          status == Open && qty > 0 && minted + qty <= total_fractions && cost > 0 && value_delta == cost && n_minted == minted + qty && n_outstanding == outstanding + qty && n_pool == pool + cost - fee && n_fees == fees + fee && n_status == status && n_mint_fee_bps == mint_fee_bps && n_redeem_fee_bps == redeem_fee_bps && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            qty,
          )
        }

        // ------------------------------------------------
        Redeem { qty } -> {
          let gross = redeem_gross(pool, qty, outstanding)
          let fee = bps_of(gross, redeem_fee_bps)
          let net = gross - fee
          status == Redeeming && qty > 0 && qty <= outstanding && gross > 0 && value_delta == -net && n_minted == minted && n_outstanding == outstanding - qty && n_pool == pool - gross && n_fees == fees + fee && n_status == status && n_mint_fee_bps == mint_fee_bps && n_redeem_fee_bps == redeem_fee_bps && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            -qty,
          )
        }

        // ------------------------------------------------
        Distribute { amount } ->
          amount > 0 && outstanding > 0 && value_delta == amount && n_minted == minted && n_outstanding == outstanding && n_pool == pool + amount && n_fees == fees && n_status == status && n_mint_fee_bps == mint_fee_bps && n_redeem_fee_bps == redeem_fee_bps && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            0,
          )

        // ------------------------------------------------
        SetStatus { status: want } ->
          committee_signed && want != status && n_status == want && value_delta == 0 && n_minted == minted && n_outstanding == outstanding && n_pool == pool && n_fees == fees && n_mint_fee_bps == mint_fee_bps && n_redeem_fee_bps == redeem_fee_bps && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            0,
          )

        // ------------------------------------------------
        SetFees { mint_fee_bps: want_mint, redeem_fee_bps: want_redeem } ->
          committee_signed && fee_bps_ok(want_mint) && fee_bps_ok(want_redeem) && ( want_mint != mint_fee_bps || want_redeem != redeem_fee_bps ) && n_mint_fee_bps == want_mint && n_redeem_fee_bps == want_redeem && value_delta == 0 && n_minted == minted && n_outstanding == outstanding && n_pool == pool && n_fees == fees && n_status == status && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            0,
          )

        // ------------------------------------------------
        ClaimFee { amount } ->
          committee_signed && amount > 0 && amount <= fees && paid_to_key(
            tx,
            treasury,
            unit_policy,
            unit_name,
            amount,
          ) && value_delta == -amount && n_fees == fees - amount && n_pool == pool && n_minted == minted && n_outstanding == outstanding && n_status == status && n_mint_fee_bps == mint_fee_bps && n_redeem_fee_bps == redeem_fee_bps && only_bound_token_moves(
            tx,
            fraction_policy,
            asset_id,
            0,
          )
      }

    // Solvency: the units actually locked by this transaction must cover the
    // pool and the unclaimed fees. When the denomination is ADA the min-ADA
    // rider is part of the same balance, so it is reserved on top.
    let reserve =
      if is_ada(unit_policy) {
        min_rider_lovelace
      } else {
        0
      }
    let solvency = held_out >= n_pool + n_fees + reserve

    structural && transition && solvency
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

const vhash: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

const fpolicy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const op1: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

const op2: ByteArray =
  #"44444444444444444444444444444444444444444444444444444444"

const issuer_pkh: ByteArray =
  #"55555555555555555555555555555555555555555555555555555555"

const treas_pkh: ByteArray =
  #"66666666666666666666666666666666666666666666666666666666"

// "ph-solar-01"
const t_asset: ByteArray = #"70682d736f6c61722d3031"

const rider: Int = min_rider_lovelace

const unit_price: Int = 25_000_000

fn offering(
  minted: Int,
  outstanding: Int,
  pool: Int,
  fees: Int,
  status: Status,
  mint_fee_bps: Int,
  redeem_fee_bps: Int,
) -> OfferingDatum {
  Offering {
    total_fractions: 1_000,
    minted,
    outstanding,
    price: unit_price,
    pool,
    fees,
    issuer: issuer_pkh,
    treasury: treas_pkh,
    operators: [op1, op2],
    threshold: 2,
    status,
    mint_fee_bps,
    redeem_fee_bps,
    fraction_policy: fpolicy,
  }
}

/// The genuine offering UTxO: carries the state-thread token.
fn script_utxo(lovelace: Int, d: OfferingDatum) -> Output {
  let o = bare_utxo(lovelace, d)
  Output { ..o, value: assets.add(o.value, vhash, thread_name, 1) }
}

/// An Offering datum WITHOUT the thread token: what anyone can pay here.
fn bare_utxo(lovelace: Int, d: OfferingDatum) -> Output {
  Output {
    address: address.Address {
      payment_credential: Script(vhash),
      stake_credential: None,
    },
    value: assets.from_lovelace(lovelace),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

/// The opening seed the fixture offering is parameterised by.
const t_seed: OutputReference =
  OutputReference {
    transaction_id: #"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed",
    output_index: 0,
  }

fn key_utxo(pkh: ByteArray, lovelace: Int) -> Output {
  Output {
    address: address.Address {
      payment_credential: VerificationKey(pkh),
      stake_credential: None,
    },
    value: assets.from_lovelace(lovelace),
    datum: transaction.NoDatum,
    reference_script: None,
  }
}

const own_ref_0: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

fn spend_tx(
  in_utxo: Output,
  outs: List<Output>,
  mint: Value,
  signers: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [Input { output_reference: own_ref_0, output: in_utxo }],
    outputs: outs,
    mint: mint,
    extra_signatories: signers,
  }
}

fn run(
  before: OfferingDatum,
  in_lovelace: Int,
  outs: List<Output>,
  mint: Value,
  signers: List<ByteArray>,
  r: FractionRedeemer,
) -> Bool {
  let in_utxo = script_utxo(in_lovelace, before)
  fraction_vault.spend(
    0,
    t_asset,
    #"",
    #"",
    t_seed,
    Some(before),
    r,
    own_ref_0,
    spend_tx(in_utxo, outs, mint, signers),
  )
}

test buy_mints_fractions_and_takes_the_mint_fee() {
  // 4 fractions at 25 ADA = 100 ADA, 1% mint fee = 1 ADA to treasury fees.
  let before = offering(0, 0, 0, 0, Open, 100, 100)
  let after = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  run(
    before,
    rider,
    [script_utxo(rider + 100_000_000, after)],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

test buy_without_minting_the_token_is_rejected() {
  let before = offering(0, 0, 0, 0, Open, 100, 100)
  let after = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  !run(
    before,
    rider,
    [script_utxo(rider + 100_000_000, after)],
    assets.zero,
    [],
    Buy { qty: 4 },
  )
}

test buy_that_underpays_is_rejected() {
  let before = offering(0, 0, 0, 0, Open, 100, 100)
  let after = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  !run(
    before,
    rider,
    [script_utxo(rider + 99_000_000, after)],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

test buy_beyond_the_total_supply_is_rejected() {
  let before = offering(998, 998, 0, 0, Open, 0, 0)
  let after = offering(1_002, 1_002, 100_000_000, 0, Open, 0, 0)
  !run(
    before,
    rider,
    [script_utxo(rider + 100_000_000, after)],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

test buy_is_rejected_once_the_offering_is_closed() {
  let before = offering(0, 0, 0, 0, Closed, 0, 0)
  let after = offering(4, 4, 100_000_000, 0, Closed, 0, 0)
  !run(
    before,
    rider,
    [script_utxo(rider + 100_000_000, after)],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

test distribute_raises_the_pool_without_minting() {
  let before = offering(4, 4, 100_000_000, 0, Closed, 0, 0)
  let after = offering(4, 4, 110_000_000, 0, Closed, 0, 0)
  run(
    before,
    rider + 100_000_000,
    [script_utxo(rider + 110_000_000, after)],
    assets.zero,
    [issuer_pkh],
    Distribute { amount: 10_000_000 },
  )
}

test redeem_burns_and_pays_pro_rata_net_of_the_exit_fee() {
  // Pool 110, 4 outstanding, redeem 1 -> gross 27.5, 1% fee = 0.275.
  let before = offering(4, 4, 110_000_000, 0, Redeeming, 0, 100)
  let gross = 27_500_000
  let fee = 275_000
  let after =
    offering(4, 3, 110_000_000 - gross, fee, Redeeming, 0, 100)
  run(
    before,
    rider + 110_000_000,
    [script_utxo(rider + 110_000_000 - ( gross - fee ), after)],
    assets.from_asset(fpolicy, t_asset, -1),
    [],
    Redeem { qty: 1 },
  )
}

test redeem_is_rejected_while_the_offering_is_open() {
  let before = offering(4, 4, 110_000_000, 0, Open, 0, 0)
  let after = offering(4, 3, 82_500_000, 0, Open, 0, 0)
  !run(
    before,
    rider + 110_000_000,
    [script_utxo(rider + 82_500_000, after)],
    assets.from_asset(fpolicy, t_asset, -1),
    [],
    Redeem { qty: 1 },
  )
}

test redeem_cannot_overdraw_the_pool() {
  let before = offering(4, 4, 110_000_000, 0, Redeeming, 0, 0)
  let after = offering(4, 3, 82_500_000, 0, Redeeming, 0, 0)
  !run(
    before,
    rider + 110_000_000,
    [script_utxo(rider + 60_000_000, after)],
    assets.from_asset(fpolicy, t_asset, -1),
    [],
    Redeem { qty: 1 },
  )
}

test set_status_needs_the_committee() {
  let before = offering(4, 4, 100_000_000, 0, Open, 0, 0)
  let after = offering(4, 4, 100_000_000, 0, Closed, 0, 0)
  let outs = [script_utxo(rider + 100_000_000, after)]
  run(before, rider + 100_000_000, outs, assets.zero, [op1, op2], SetStatus { status: Closed }) && !run(
    before,
    rider + 100_000_000,
    outs,
    assets.zero,
    [op1],
    SetStatus { status: Closed },
  )
}

test set_fees_respects_the_cap() {
  let before = offering(4, 4, 100_000_000, 0, Open, 0, 0)
  let ok_after = offering(4, 4, 100_000_000, 0, Open, 500, 500)
  let bad_after = offering(4, 4, 100_000_000, 0, Open, 501, 500)
  run(
    before,
    rider + 100_000_000,
    [script_utxo(rider + 100_000_000, ok_after)],
    assets.zero,
    [op1, op2],
    SetFees { mint_fee_bps: 500, redeem_fee_bps: 500 },
  ) && !run(
    before,
    rider + 100_000_000,
    [script_utxo(rider + 100_000_000, bad_after)],
    assets.zero,
    [op1, op2],
    SetFees { mint_fee_bps: 501, redeem_fee_bps: 500 },
  )
}

test claim_fee_pays_the_treasury_only() {
  let before = offering(4, 4, 99_000_000, 1_000_000, Closed, 100, 100)
  let after = offering(4, 4, 99_000_000, 0, Closed, 100, 100)
  run(
    before,
    rider + 100_000_000,
    [
      script_utxo(rider + 99_000_000, after),
      key_utxo(treas_pkh, 1_000_000),
    ],
    assets.zero,
    [op1, op2],
    ClaimFee { amount: 1_000_000 },
  ) && !run(
    before,
    rider + 100_000_000,
    [script_utxo(rider + 99_000_000, after), key_utxo(op1, 1_000_000)],
    assets.zero,
    [op1, op2],
    ClaimFee { amount: 1_000_000 },
  )
}

test claim_fee_cannot_exceed_what_accrued() {
  let before = offering(4, 4, 99_000_000, 1_000_000, Closed, 100, 100)
  let after = offering(4, 4, 99_000_000, -1_000_000, Closed, 100, 100)
  !run(
    before,
    rider + 100_000_000,
    [
      script_utxo(rider + 98_000_000, after),
      key_utxo(treas_pkh, 2_000_000),
    ],
    assets.zero,
    [op1, op2],
    ClaimFee { amount: 2_000_000 },
  )
}

test the_committee_cannot_rewrite_the_supply_or_the_treasury() {
  let before = offering(4, 4, 100_000_000, 0, Open, 0, 0)
  let tampered =
    Offering { ..offering(4, 4, 100_000_000, 0, Closed, 0, 0), treasury: op1 }
  !run(
    before,
    rider + 100_000_000,
    [script_utxo(rider + 100_000_000, tampered)],
    assets.zero,
    [op1, op2],
    SetStatus { status: Closed },
  )
}

// --- Phase 1: state-thread token (AUDIT.md F-1) ------------------------

fn seed_input() -> Input {
  Input { output_reference: t_seed, output: key_utxo(issuer_pkh, 50_000_000) }
}

fn opening_tx(ins: List<Input>, outs: List<Output>, minted: Int) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: ins,
    outputs: outs,
    mint: assets.from_asset(vhash, thread_name, minted),
    extra_signatories: [issuer_pkh],
  }
}

fn open(tx: Transaction) -> Bool {
  fraction_vault.mint(0, t_asset, #"", #"", t_seed, Void, vhash, tx)
}

test opening_mints_the_thread_token_into_an_empty_offering() {
  open(
    opening_tx(
      [seed_input()],
      [script_utxo(rider, offering(0, 0, 0, 0, Open, 100, 100))],
      1,
    ),
  )
}

test opening_without_the_seed_is_rejected() {
  let other =
    Input {
      output_reference: OutputReference { ..t_seed, output_index: 7 },
      output: key_utxo(issuer_pkh, 50_000_000),
    }
  !open(
    opening_tx(
      [other],
      [script_utxo(rider, offering(0, 0, 0, 0, Open, 100, 100))],
      1,
    ),
  )
}

test opening_cannot_start_with_fractions_already_sold() {
  !open(
    opening_tx(
      [seed_input()],
      [script_utxo(rider + 100_000_000, offering(4, 4, 100_000_000, 0, Open, 100, 100))],
      1,
    ),
  )
}

test opening_cannot_start_in_redeeming() {
  !open(
    opening_tx(
      [seed_input()],
      [script_utxo(rider, offering(0, 0, 0, 0, Redeeming, 100, 100))],
      1,
    ),
  )
}

test opening_cannot_happen_while_an_offering_is_spent() {
  let live = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  !open(
    opening_tx(
      [
        seed_input(),
        Input { output_reference: own_ref_0, output: script_utxo(rider + 100_000_000, live) },
      ],
      [script_utxo(rider, offering(0, 0, 0, 0, Open, 100, 100))],
      1,
    ),
  )
}

test opening_cannot_burn_the_thread_token() {
  !open(
    opening_tx(
      [seed_input()],
      [script_utxo(rider, offering(0, 0, 0, 0, Open, 100, 100))],
      -1,
    ),
  )
}

/// F-1 on the fraction vault: an Offering datum paid to the address with a
/// cheap price would let an attacker buy fractions for almost nothing and
/// redeem them against the genuine pool. Without the token it is unspendable.
test planted_offering_cannot_sell_fractions() {
  // Price 1 lovelace per fraction instead of 25 ADA.
  let planted = Offering { ..offering(0, 0, 0, 0, Open, 0, 0), price: 1 }
  let after = Offering { ..offering(500, 500, 500, 0, Open, 0, 0), price: 1 }
  let t =
    spend_tx(
      bare_utxo(rider, planted),
      [script_utxo(rider + 500, after)],
      assets.from_asset(fpolicy, t_asset, 500),
      [],
    )
  !fraction_vault.spend(0, t_asset, #"", #"", t_seed, Some(planted), Buy { qty: 500 }, own_ref_0, t)
}

/// Control for the test above: the identical purchase against the genuine
/// offering is accepted, so the only difference is the thread token.
test genuine_offering_with_the_same_terms_sells_fractions() {
  let genuine = Offering { ..offering(0, 0, 0, 0, Open, 0, 0), price: 1 }
  let after = Offering { ..offering(500, 500, 500, 0, Open, 0, 0), price: 1 }
  let t =
    spend_tx(
      script_utxo(rider, genuine),
      [script_utxo(rider + 500, after)],
      assets.from_asset(fpolicy, t_asset, 500),
      [],
    )
  fraction_vault.spend(0, t_asset, #"", #"", t_seed, Some(genuine), Buy { qty: 500 }, own_ref_0, t)
}

/// F-1: the offering may not shed its token on the way out.
test offering_must_keep_its_thread_token() {
  let before = offering(0, 0, 0, 0, Open, 100, 100)
  let after = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  !run(
    before,
    rider,
    [bare_utxo(rider + 100_000_000, after)],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

/// The thread token is the ONLY extra the offering output may carry.
test offering_cannot_carry_junk_beside_its_thread_token() {
  let before = offering(0, 0, 0, 0, Open, 100, 100)
  let after = offering(4, 4, 99_000_000, 1_000_000, Open, 100, 100)
  let o = script_utxo(rider + 100_000_000, after)
  let junked = Output { ..o, value: assets.add(o.value, fpolicy, #"ff", 1) }
  !run(
    before,
    rider,
    [junked],
    assets.from_asset(fpolicy, t_asset, 4),
    [],
    Buy { qty: 4 },
  )
}

/// Opening cannot pre-mint a supply even with an empty pool: fractions sold
/// before the offering exists would be unbacked claims on later buyers.
test opening_cannot_claim_minted_fractions_with_an_empty_pool() {
  !open(
    opening_tx(
      [seed_input()],
      [script_utxo(rider, offering(4, 4, 0, 0, Open, 100, 100))],
      1,
    ),
  )
}
