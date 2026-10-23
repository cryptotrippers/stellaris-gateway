/**
 * Redemption queue genesis (Phase 2.6): pure parameter checks and datum /
 * redeemer encoders. No chain, no wallet, no I/O.
 *
 * Mirrors contracts/tessera: `config_valid` + `limits_ok` + `limit_floor`
 * (lib/tessera/queue_state.ak) and queue_admin `genesis`.
 *
 * Encoding (contracts/tessera/plutus.json):
 *   QueueDatum = Config(QueueConfig) 0 | Request 1 | Sink 2 | Shard(ShardState) 3
 *              | Short(ShortState) 4 | Grace 5
 *   QueueConfig = Constr 0 [14 fields]   ShardState = Constr 0 [day, paid_day, month, paid_month]
 *   ShortState  = Constr 0 [active, episode, since, reg_deadline, last_exit, tallies]
 *   AdminRedeemer = Constr 0 [queue, AdminAction]; Genesis = Constr 0 []
 *   Option: Some = Constr 0 [x], None = Constr 1 []
 */
import { Constr, Data, fromText, toHex } from "@lucid-evolution/lucid";

const DAY = 86_400_000;
export const MAX_SETTLE_DELAY = 7 * DAY;
export const MAX_SETTLE_TIP = 1_000_000n;
export const MAX_GRACE_MS = 30 * DAY;
export const MIN_DAILY_LIMIT = 10_000_000_000n;
export const MAX_SHARDS = 8;

export const CONFIG_NAME = fromText("queue");
export const SHORT_NAME = fromText("short");
/** `shard` ++ one byte, the index (queue_state.shard_name). */
export const shardName = (i: number) => fromText("shard") + toHex(new Uint8Array([i]));

export interface QueueParams {
  payoutPolicy: string;
  /** hex asset name */
  payoutName: string;
  settleDelayMs: number;
  minRequest: bigint;
  instantMax: bigint;
  settleTip: bigint;
  dailyLimit: bigint;
  monthlyLimit: bigint;
  shards: number;
  graceMs: number;
}

/** SPEC.md §4.12 bootstrap defaults + Kurt's launch limits (2026-10-23). */
export function defaultQueueParams(payoutPolicy: string, payoutName: string): QueueParams {
  return {
    payoutPolicy,
    payoutName,
    settleDelayMs: 2 * DAY,
    minRequest: 100_000_000n, // 100 TSRA
    instantMax: 10_000_000_000n, // 10,000 TSRA
    settleTip: 200_000n, // 0.2 ADA
    dailyLimit: 50_000_000_000n, // 50,000 payout units
    monthlyLimit: 500_000_000_000n, // 500,000
    shards: 4,
    graceMs: 14 * DAY,
  };
}

/** queue_state.limit_floor: max(min_daily_limit, minted_supply / 100). */
export function limitFloor(mintedSupply: bigint): bigint {
  const share = mintedSupply / 100n;
  return share > MIN_DAILY_LIMIT ? share : MIN_DAILY_LIMIT;
}

/** Every reason `config_valid` would refuse at the given TSRA minted supply. */
export function queueProblems(p: QueueParams, mintedSupply: bigint): string[] {
  const out: string[] = [];
  if (!/^[0-9a-f]{56}$/.test(p.payoutPolicy)) out.push("payout policy must be 28 bytes (not ADA)");
  if (p.payoutName.length / 2 > 32) out.push("payout name longer than 32 bytes");
  if (p.settleDelayMs < 0 || p.settleDelayMs > MAX_SETTLE_DELAY) out.push("settle delay 0–7 days");
  if (p.minRequest <= 0n) out.push("min_request must be > 0");
  if (p.instantMax <= 0n) out.push("instant_max must be > 0");
  if (p.settleTip < 0n || p.settleTip > MAX_SETTLE_TIP) out.push("settle tip 0–1 ADA");
  if (p.shards < 1 || p.shards > MAX_SHARDS) out.push("shards 1–8");
  if (p.graceMs < 0 || p.graceMs > MAX_GRACE_MS) out.push("grace 0–30 days");
  const floor = limitFloor(mintedSupply);
  if (p.dailyLimit < floor) out.push(`daily limit below the floor ${floor.toString()}`);
  if (p.monthlyLimit < p.dailyLimit) out.push("monthly limit below the daily limit");
  return out;
}

const NONE = new Constr(1, []);
const FALSE = new Constr(0, []);

export function queueConfigDatumCbor(p: QueueParams): string {
  const c = new Constr(0, [
    p.payoutPolicy,
    p.payoutName,
    BigInt(p.settleDelayMs),
    p.minRequest,
    p.instantMax,
    p.settleTip,
    p.dailyLimit,
    p.monthlyLimit,
    BigInt(p.shards),
    BigInt(p.graceMs),
    0n, // suspended_until
    NONE, // pending_limits
    NONE, // pending_defund
    0n, // epoch
  ]);
  return Data.to(new Constr(0, [c]) as never);
}

export function shortGenesisDatumCbor(): string {
  return Data.to(new Constr(4, [new Constr(0, [FALSE, 0n, 0n, 0n, 0n, []])]) as never);
}

export function shardGenesisDatumCbor(): string {
  return Data.to(new Constr(3, [new Constr(0, [0n, 0n, 0n, 0n])]) as never);
}

/** queue_admin withdraw redeemer `{ queue, Genesis }`. */
export function adminGenesisRedeemer(queueHash: string): string {
  return Data.to(new Constr(0, [queueHash, new Constr(0, [])]) as never);
}

/** Minted supply (1e-6 TSRA) from a reserve SupplyDatum. */
export function mintedSupplyOf(supplyCbor: string): bigint {
  const d = Data.from(supplyCbor) as Constr<Constr<bigint>>;
  return d.fields[0]!.fields[0]!;
}
