//// Test fixtures for the redemption queue scripts (Phase 2.6). Not used by any
//// validator, so none of this ships in a script.

use aiken/collection/list
use aiken/interval
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/certificate.{Certificate}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, ScriptPurpose, Spend,
  Transaction, Withdraw, placeholder,
}
use tessera/queue_state.{
  Config, Grace, GraceState, QueueConfig, QueueDatum, Request, RequestState,
  Shard, ShardState, Short, ShortState, Sink, Tally, config_name, payable_after_of,
  request_name, shard_name, short_name,
}
use tessera/reserve_state.{
  ConfigDatum, ConfigState, SupplyDatum, SupplyState,
}
use tessera/reserve_threads.{config_value, supply_value}
use tessera/rules

pub const day: Int = 86_400_000

pub const q: PolicyId =
  #"71717171717171717171717171717171717171717171717171717171"

pub const t_reserve: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

pub const t_flow: PolicyId =
  #"f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"

pub const t_admin: PolicyId =
  #"f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1"

pub const t_short: PolicyId =
  #"f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2"

pub const pay_policy: PolicyId =
  #"99999999999999999999999999999999999999999999999999999999"

pub const pay_name: ByteArray = "USDM"

pub const t_elig: PolicyId =
  #"77777777777777777777777777777777777777777777777777777777"

pub const alice: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

pub const bob: ByteArray =
  #"b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0"

pub const keeper: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

pub const op1: ByteArray =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

pub const op2: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

pub const op3: ByteArray =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

/// The validity window every fixture transaction uses: day 20, 01:00 to 01:30.
pub const now: Int = 1_731_600_000

pub fn ref(i: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"0707070707070707070707070707070707070707070707070707070707070707",
    output_index: i,
  }
}

pub fn q_addr() -> Address {
  Address { payment_credential: Script(q), stake_credential: None }
}

pub fn key_addr(k: ByteArray) -> Address {
  Address { payment_credential: VerificationKey(k), stake_credential: None }
}

pub fn inp(i: Int, o: Output) -> Input {
  Input { output_reference: ref(i), output: o }
}

// ----------------------------------------------------------------- values

pub fn ada(n: Int) -> Value {
  assets.from_lovelace(n)
}

pub fn tsra(qty: Int) -> Value {
  assets.from_asset(t_reserve, rules.tsra_name, qty)
}

pub fn usd(qty: Int) -> Value {
  assets.from_asset(pay_policy, pay_name, qty)
}

pub fn qtok(name: ByteArray, n: Int) -> Value {
  assets.from_asset(q, name, n)
}

// ------------------------------------------------------------------ config

pub fn cfg0() -> QueueConfig {
  QueueConfig {
    payout_policy: pay_policy,
    payout_name: pay_name,
    settle_delay: 2 * day,
    min_request: 100_000_000,
    instant_max: 10_000_000_000,
    settle_tip: 200_000,
    daily_limit: 40_000_000_000,
    monthly_limit: 400_000_000_000,
    shards: 4,
    grace_ms: 14 * day,
    suspended_until: 0,
    pending_limits: None,
    pending_defund: None,
    epoch: 0,
  }
}

pub fn short0() -> ShortState {
  ShortState {
    active: False,
    episode: 0,
    since: 0,
    reg_deadline: 0,
    last_exit: 0,
    tallies: [],
  }
}

pub fn shard0() -> ShardState {
  ShardState { day: 0, paid_day: 0, month: 0, paid_month: 0 }
}

pub fn rcfg0() -> ConfigState {
  ConfigState {
    operators: [op1, op2, op3],
    threshold: 2,
    paused: False,
    kyc_mint: False,
    kyc_redeem: False,
    kyc_stake: False,
    eligibility_policy: t_elig,
    vault_policy: #"",
    loss_pending_until: 0,
    epoch: 0,
  }
}

pub fn supply0() -> SupplyState {
  SupplyState {
    minted_supply: 500_000_000_000,
    attested_reserve: 600_000_000_000,
    mint_cap: 1_000_000_000_000,
    attestation_epoch: 1,
    attested_at: 0,
    epoch: 1,
  }
}

// ----------------------------------------------------------------- outputs

pub fn qout(v: Value, d: QueueDatum) -> Output {
  Output {
    address: q_addr(),
    value: ada(2_000_000) |> assets.merge(v),
    datum: InlineDatum(d),
    reference_script: None,
  }
}

pub fn config_out(c: QueueConfig) -> Output {
  qout(qtok(config_name, 1), Config(c))
}

pub fn short_out(s: ShortState) -> Output {
  qout(qtok(short_name, 1), Short(s))
}

pub fn shard_out(i: Int, s: ShardState, bal: Int) -> Output {
  qout(qtok(shard_name(i), 1) |> assets.merge(usd(bal)), Shard(s))
}

pub fn req(owner: ByteArray, qty: Int, bucket: Int) -> RequestState {
  RequestState {
    owner,
    payout_to: key_addr(owner),
    qty,
    bucket,
    payable_after: payable_after_of(bucket, 2 * day),
    reg_episode: 0,
  }
}

pub fn req_out(r: RequestState) -> Output {
  qout(tsra(r.qty) |> assets.merge(qtok(request_name, 1)), Request(r))
}

pub fn sink_out(qty: Int) -> Output {
  qout(tsra(qty), Sink)
}

pub fn grace_out(holder: ByteArray, until: Int) -> Output {
  qout(qtok(holder, 1), Grace(GraceState { until }))
}

pub fn wallet(k: ByteArray, v: Value) -> Output {
  Output {
    address: key_addr(k),
    value: ada(3_000_000) |> assets.merge(v),
    datum: NoDatum,
    reference_script: None,
  }
}

/// A payment of `n` payout units to `k`, carrying `lov` lovelace.
pub fn paid(k: ByteArray, n: Int, lov: Int) -> Output {
  Output {
    address: key_addr(k),
    value: ada(lov) |> assets.merge(usd(n)),
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn reserve_config_out(rc: ConfigState) -> Output {
  Output {
    address: Address { payment_credential: Script(t_reserve), stake_credential: None },
    value: ada(2_000_000) |> assets.merge(config_value(t_reserve)),
    datum: InlineDatum(ConfigDatum(rc)),
    reference_script: None,
  }
}

pub fn reserve_supply_out(s: SupplyState) -> Output {
  Output {
    address: Address { payment_credential: Script(t_reserve), stake_credential: None },
    value: ada(2_000_000) |> assets.merge(supply_value(t_reserve)),
    datum: InlineDatum(SupplyDatum(s)),
    reference_script: None,
  }
}

// ------------------------------------------------------------ transactions

pub fn tx0() -> Transaction {
  Transaction { ..placeholder, validity_range: interval.between(now, now + 1_800_000) }
}

pub fn at(tx: Transaction, lo: Int, hi: Int) -> Transaction {
  Transaction { ..tx, validity_range: interval.between(lo, hi) }
}

pub fn gate(tx: Transaction, h: PolicyId) -> Transaction {
  Transaction { ..tx, withdrawals: [Pair(Script(h), 0), ..tx.withdrawals] }
}

pub fn signed(tx: Transaction, who: List<ByteArray>) -> Transaction {
  Transaction { ..tx, extra_signatories: who }
}

pub fn ins(tx: Transaction, xs: List<Input>) -> Transaction {
  Transaction { ..tx, inputs: xs }
}

pub fn refs(tx: Transaction, xs: List<Input>) -> Transaction {
  Transaction { ..tx, reference_inputs: xs }
}

pub fn outs(tx: Transaction, xs: List<Output>) -> Transaction {
  Transaction { ..tx, outputs: xs }
}

pub fn minting(tx: Transaction, v: Value) -> Transaction {
  Transaction { ..tx, mint: v }
}

pub fn map_out(tx: Transaction, i: Int, f: fn(Output) -> Output) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.indexed_map(tx.outputs, fn(j, o) { if j == i { f(o) } else { o } }),
  }
}

pub fn map_in(tx: Transaction, i: Int, f: fn(Output) -> Output) -> Transaction {
  Transaction {
    ..tx,
    inputs: list.indexed_map(
      tx.inputs,
      fn(j, x) {
        if j == i {
          Input { ..x, output: f(x.output) }
        } else {
          x
        }
      },
    ),
  }
}

pub fn drop_out(tx: Transaction, i: Int) -> Transaction {
  Transaction {
    ..tx,
    outputs: list.indexed_map(tx.outputs, fn(j, o) { (j, o) })
      |> list.filter_map(fn((j, o)) { if j == i { None } else { Some(o) } }),
  }
}

pub fn add_out(tx: Transaction, o: Output) -> Transaction {
  Transaction { ..tx, outputs: list.concat(tx.outputs, [o]) }
}

pub fn add_in(tx: Transaction, x: Input) -> Transaction {
  Transaction { ..tx, inputs: list.concat(tx.inputs, [x]) }
}

pub fn add_ref(tx: Transaction, x: Input) -> Transaction {
  Transaction { ..tx, reference_inputs: list.concat(tx.reference_inputs, [x]) }
}

pub fn redeemer(tx: Transaction, p: ScriptPurpose, d: Data) -> Transaction {
  Transaction { ..tx, redeemers: [Pair(p, d), ..tx.redeemers] }
}

pub fn lovelace_plus(o: Output, n: Int) -> Output {
  Output { ..o, value: o.value |> assets.merge(ada(n)) }
}

pub fn with_value(o: Output, v: Value) -> Output {
  Output { ..o, value: o.value |> assets.merge(v) }
}

pub fn with_datum(o: Output, d: QueueDatum) -> Output {
  Output { ..o, datum: InlineDatum(d) }
}

pub fn staked(o: Output) -> Output {
  Output {
    ..o,
    address: Address {
      payment_credential: o.address.payment_credential,
      stake_credential: Some(
        address.Inline(
          VerificationKey(
            #"12121212121212121212121212121212121212121212121212121212",
          ),
        ),
      ),
    },
  }
}

pub fn with_ref_script(o: Output) -> Output {
  Output { ..o, reference_script: Some(#"0000000000000000000000000000000000000000000000000000000000") }
}

pub fn tally(d: Int, n: Int) -> Tally {
  Tally { day: d, open: n }
}

/// The Request datum of an output (fixtures only).
pub fn req_of(o: Output) -> RequestState {
  expect InlineDatum(d) = o.datum
  expect qd: QueueDatum = d
  expect Request(r) = qd
  r
}

pub fn edit_req(tx: Transaction, i: Int, f: fn(RequestState) -> RequestState) -> Transaction {
  map_out(tx, i, fn(o) { with_datum(o, Request(f(req_of(o)))) })
}

// ------------------------------------------------------- certificates

pub type DelegateM {
  DelegateBlockM { stake_pool: ByteArray }
  DelegateVoteM { drep: DrepM }
}

pub type DrepM {
  RegisteredM(Credential)
  AlwaysAbstainM
}

pub type CertMirror {
  RegisterM { credential: Credential, deposit: Option<Int> }
  UnregisterM { credential: Credential, refund: Option<Int> }
  DelegateM { credential: Credential, delegate: DelegateM }
  RegisterDelegateM { credential: Credential, delegate: DelegateM, deposit: Int }
  RegisterDrepM { credential: Credential, deposit: Int }
  UpdateDrepM { credential: Credential }
  UnregisterDrepM { credential: Credential, refund: Int }
}

pub fn cert(m: CertMirror) -> Certificate {
  let d: Data = m
  expect c: Certificate = d
  c
}

/// Every certificate shape the three withdraw-zero scripts must refuse.
pub fn refused_certs(c: Credential) -> List<CertMirror> {
  [
    UnregisterM { credential: c, refund: None },
    DelegateM {
      credential: c,
      delegate: DelegateBlockM {
        stake_pool: #"abababababababababababababababababababababababababababab",
      },
    },
    RegisterDelegateM {
      credential: c,
      delegate: DelegateBlockM {
        stake_pool: #"abababababababababababababababababababababababababababab",
      },
      deposit: 2_000_000,
    },
    RegisterDrepM { credential: c, deposit: 500_000_000 },
    UpdateDrepM { credential: c },
    UnregisterDrepM { credential: c, refund: 500_000_000 },
    DelegateM { credential: c, delegate: DelegateVoteM { drep: AlwaysAbstainM } },
  ]
}
