/**
 * sTSRA vault, first-loss reserve and reserve `SetVault`: pure parameter checks
 * and datum / redeemer encoders. No chain, no wallet, no I/O.
 *
 * Mirrors contracts/tessera: `genesis_ok` + `bounds_ok` (stsra_vault.ak,
 * vault_state.ak), first_loss.ak `genesis`, and reserve.ak `SetVault`.
 *
 * Encoding (contracts/tessera/plutus.json):
 *   VaultDatum.StateDatum(VaultState) = Constr 0 [Constr 0 [19 fields]]
 *   FirstLossState                    = Constr 0 [balance, epoch]
 *   ReserveRedeemer.SetVault{policy}  = Constr 7 [policy]
 *   Address = Constr 0 [PaymentCredential, Option<StakeCredential>]
 *     VerificationKey(h) = Constr 0 [h], Script(h) = Constr 1 [h]
 *     Some(Inline(cred)) = Constr 0 [Constr 0 [cred]], None = Constr 1 []
 */
import { Constr, Data, fromText, getAddressDetails } from "@lucid-evolution/lucid";
import { decodeReserveDatum } from "./genesis";

/** vault_state.loss_index_start */
export const LOSS_INDEX_START = 1_000_000_000_000n;
/** exchange.max_yield_fee_bps */
export const MAX_PROTOCOL_BPS = 2_000;
const DAY = 86_400_000;

export interface VaultBounds {
  longWeightBps: number;
  shortCooldownMs: number;
  longLockMs: number;
  protocolBps: number;
}

/** SPEC.md §3: proposed genesis bounds. */
export const PROPOSED_BOUNDS: VaultBounds = {
  longWeightBps: 12_500,
  shortCooldownMs: 7 * DAY,
  longLockMs: 30 * DAY,
  protocolBps: 1_250,
};

/** Every reason `bounds_ok` would refuse. */
export function boundsProblems(b: VaultBounds): string[] {
  const out: string[] = [];
  if (b.longWeightBps < 10_000 || b.longWeightBps > 15_000)
    out.push("long_weight_bps must be 10,000–15,000");
  if (b.shortCooldownMs < 7 * DAY || b.shortCooldownMs > 14 * DAY)
    out.push("short cooldown must be 7–14 days");
  if (b.longLockMs < 2 * b.shortCooldownMs) out.push("long lock must be at least 2× the cooldown");
  if (b.longLockMs > 90 * DAY) out.push("long lock must be at most 90 days");
  if (b.protocolBps < 0 || b.protocolBps > MAX_PROTOCOL_BPS)
    out.push("protocol_bps must be 0–2,000");
  return out;
}

/** Plutus `Address` for a bech32 address (key or script payment, optional inline stake). */
export function addressData(bech32: string): Constr<unknown> {
  const d = getAddressDetails(bech32);
  const pay = d.paymentCredential;
  if (!pay) throw new Error(`${bech32} has no payment credential`);
  const cred = (c: { type: "Key" | "Script"; hash: string }) =>
    new Constr(c.type === "Key" ? 0 : 1, [c.hash]);
  const stake = d.stakeCredential
    ? new Constr(0, [new Constr(0, [cred(d.stakeCredential)])])
    : new Constr(1, []);
  return new Constr(0, [cred(pay), stake]);
}

export interface VaultGenesisParams {
  bounds: VaultBounds;
  firstLossHash: string;
  treasuryAddress: string;
}

/** Every reason `genesis_ok` would refuse, given the vault's own hash. */
export function vaultGenesisProblems(p: VaultGenesisParams, vaultHash: string): string[] {
  const out = boundsProblems(p.bounds);
  if (!/^[0-9a-f]{56}$/.test(p.firstLossHash)) out.push("first_loss must be a 28-byte policy id");
  if (p.firstLossHash === vaultHash) out.push("first_loss must not be the vault");
  const pay = getAddressDetails(p.treasuryAddress).paymentCredential;
  if (pay?.type === "Script" && pay.hash === vaultHash) out.push("treasury must not be the vault");
  return out;
}

/** Inline datum of the genesis vault State: StateDatum(VaultState) with empty books. */
export function vaultStateDatumCbor(p: VaultGenesisParams): string {
  const s = new Constr(0, [
    0n, // short_shares
    0n, // short_assets
    0n, // long_shares
    0n, // long_assets
    LOSS_INDEX_START,
    0n, // ticket_escrow
    0n, // short_gen
    0n, // long_gen
    0n, // vest_short
    0n, // vest_long
    0n, // vest_from
    0n, // vest_until
    BigInt(p.bounds.longWeightBps),
    BigInt(p.bounds.shortCooldownMs),
    BigInt(p.bounds.longLockMs),
    BigInt(p.bounds.protocolBps),
    p.firstLossHash,
    addressData(p.treasuryAddress),
    0n, // epoch
  ]);
  return Data.to(new Constr(0, [s]) as never);
}

/** Inline datum of the genesis first-loss State: { balance: 0, epoch: 0 }. */
export function firstLossGenesisDatumCbor(): string {
  return Data.to(new Constr(0, [0n, 0n]) as never);
}

/** Reserve redeemer `SetVault { vault_policy }` (constructor 7). */
export function setVaultRedeemer(vaultHash: string): string {
  return Data.to(new Constr(7, [vaultHash]) as never);
}

/**
 * The next Config datum for SetVault: identical to `current` except
 * `vault_policy` and `epoch + 1`, exactly as reserve.ak requires.
 */
export function setVaultConfigDatum(currentCbor: string, vaultHash: string): string {
  const d = decodeReserveDatum(currentCbor);
  if (d?.kind !== "config") throw new Error("not a ConfigDatum");
  const f = [...d.fields];
  f[7] = vaultHash;
  f[9] = (f[9] as bigint) + 1n;
  return Data.to(new Constr(0, [new Constr(0, f)]) as never);
}

/** Committee (operators, threshold) from a Config datum. */
export function committeeOf(configCbor: string): { operators: string[]; threshold: number } {
  const d = decodeReserveDatum(configCbor);
  if (d?.kind !== "config") throw new Error("not a ConfigDatum");
  return { operators: d.fields[0] as string[], threshold: Number(d.fields[1] as bigint) };
}

export const THREAD_NAME = fromText("state");
export const STSRA_NAME = fromText("sTSRA");
