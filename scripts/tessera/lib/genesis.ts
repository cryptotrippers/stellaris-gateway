/**
 * Tessera Reserve genesis: pure parameter checks and datum encoders.
 *
 * No chain, no wallet, no I/O. Every rule here mirrors `genesis_config_ok`,
 * `genesis_supply_ok` and `operators_valid` in contracts/tessera (reserve.ak,
 * reserve_state.ak, rules.ak), so a bad parameter is refused before a
 * transaction is ever built. The validator remains the authority; these are
 * an early, readable failure.
 *
 * Encoding follows contracts/tessera/plutus.json:
 *   ReserveDatum = ConfigDatum(ConfigState) | SupplyDatum(SupplyState)   (Constr 0 | 1)
 *   ConfigState  = Constr 0 [operators, threshold, paused, kyc_mint, kyc_redeem,
 *                            kyc_stake, eligibility_policy, vault_policy,
 *                            loss_pending_until, epoch]
 *   SupplyState  = Constr 0 [minted_supply, attested_reserve, mint_cap,
 *                            attestation_epoch, attested_at, epoch]
 *   Bool         = False: Constr 0 [], True: Constr 1 []
 */
import { Constr, Data, fromText } from "@lucid-evolution/lucid";

/** rules.min_threshold — never a single key. */
export const MIN_THRESHOLD = 2;
/** rules.max_mint_cap — 1,000,000,000 TSRA in 1e-6 units. */
export const MAX_MINT_CAP = 1_000_000_000_000_000n;
/** rules.max_attest_window — the genesis validity range may span at most 1 day. */
export const MAX_ATTEST_WINDOW_MS = 86_400_000;
/** TSRA has 6 decimals (src/config/brand.ts). */
export const TSRA_DECIMALS = 6;

export const TSRA_NAME = "TSRA";
export const CONFIG_NAME = "config";
export const SUPPLY_NAME = "supply";

export interface GenesisParams {
  /** Committee payment key hashes, 28 bytes hex each. */
  operators: string[];
  threshold: number;
  /** Working mint ceiling in 1e-6 TSRA. */
  mintCap: bigint;
  /** Reserve recorded at genesis, 1e-6 TSRA. Usually 0. */
  attestedReserve: bigint;
  paused: boolean;
  kycMint: boolean;
  kycRedeem: boolean;
  kycStake: boolean;
  /** Applied eligibility script hash (28 bytes hex). */
  eligibilityPolicy: string;
}

const HEX28 = /^[0-9a-f]{56}$/;

/** Every reason these params would fail on-chain genesis. Empty = acceptable. */
export function genesisProblems(p: GenesisParams): string[] {
  const out: string[] = [];
  const n = p.operators.length;
  for (const op of p.operators) {
    if (!HEX28.test(op)) out.push(`operator ${op} is not a 28-byte lowercase hex key hash`);
  }
  if (new Set(p.operators).size !== n) out.push("committee contains a duplicate key");
  if (!Number.isInteger(p.threshold)) out.push("threshold must be an integer");
  if (p.threshold < MIN_THRESHOLD) out.push(`threshold must be at least ${MIN_THRESHOLD}`);
  if (p.threshold > n) out.push(`threshold ${p.threshold} exceeds committee size ${n}`);
  if (p.mintCap < 0n) out.push("mint_cap must not be negative");
  if (p.mintCap > MAX_MINT_CAP) out.push("mint_cap exceeds the 1,000,000,000 TSRA hard ceiling");
  if (p.attestedReserve < 0n) out.push("attested_reserve must not be negative");
  if (!HEX28.test(p.eligibilityPolicy)) out.push("eligibility_policy must be 28 bytes");
  return out;
}

/** The genesis validity window is acceptable to `rules.window_ok(lo, hi, 0)`. */
export function windowProblems(lo: number, hi: number): string[] {
  const out: string[] = [];
  if (lo < 0) out.push("validity lower bound is negative");
  if (hi < lo) out.push("validity upper bound is before the lower bound");
  if (hi - lo > MAX_ATTEST_WINDOW_MS) out.push("validity window is longer than 1 day");
  return out;
}

const bool = (b: boolean) => new Constr(b ? 1 : 0, []);

/** The ConfigState Constr for genesis. */
export function configState(p: GenesisParams): Constr<unknown> {
  return new Constr(0, [
    p.operators,
    BigInt(p.threshold),
    bool(p.paused),
    bool(p.kycMint),
    bool(p.kycRedeem),
    bool(p.kycStake),
    p.eligibilityPolicy,
    "", // vault_policy: empty until SetVault
    0n, // loss_pending_until
    0n, // epoch
  ]);
}

/** The SupplyState Constr for genesis; `attestedAt` must equal the tx lower bound. */
export function supplyState(p: GenesisParams, attestedAt: number): Constr<unknown> {
  return new Constr(0, [
    0n, // minted_supply
    p.attestedReserve,
    p.mintCap,
    0n, // attestation_epoch
    BigInt(attestedAt),
    0n, // epoch
  ]);
}

/** Inline datum CBOR of the genesis Config UTxO: ConfigDatum(ConfigState). */
export function configDatumCbor(p: GenesisParams): string {
  return Data.to(new Constr(0, [configState(p)]) as never);
}

/** Inline datum CBOR of the genesis Supply UTxO: SupplyDatum(SupplyState). */
export function supplyDatumCbor(p: GenesisParams, attestedAt: number): string {
  return Data.to(new Constr(1, [supplyState(p, attestedAt)]) as never);
}

/** Units minted / carried under the reserve policy. */
export function reserveUnits(policy: string) {
  return {
    tsra: policy + fromText(TSRA_NAME),
    config: policy + fromText(CONFIG_NAME),
    supply: policy + fromText(SUPPLY_NAME),
  };
}

/** Whole TSRA → 1e-6 units, from a decimal string ("5000000" or "12.5"). */
export function tsraToUnits(whole: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(whole.trim());
  if (!m) throw new Error(`"${whole}" is not a TSRA amount with at most 6 decimals`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** Decoded genesis datums, for checking what actually landed on chain. */
export function decodeReserveDatum(
  cbor: string,
): { kind: "config"; fields: unknown[] } | { kind: "supply"; fields: unknown[] } | null {
  let d: unknown;
  try {
    d = Data.from(cbor);
  } catch {
    return null;
  }
  if (!(d instanceof Constr) || d.fields.length !== 1) return null;
  const inner = d.fields[0];
  if (!(inner instanceof Constr) || inner.index !== 0) return null;
  if (d.index === 0 && inner.fields.length === 10) return { kind: "config", fields: inner.fields };
  if (d.index === 1 && inner.fields.length === 6) return { kind: "supply", fields: inner.fields };
  return null;
}
