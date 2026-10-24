/**
 * Live governance weight, read from the chain at the moment it is needed.
 *
 * Weight = the redeemable value of genuine Position UTxOs (marked by the
 * vault's position token, valued against the thread-token State) that are
 * still UNSPENT right now, owned by a payment key hash that a user has proven
 * with a signed wallet link. Recorded database rows are history only and
 * never count. A withdrawn position simply stops existing, so it stops
 * counting everywhere at once.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { bfGet } from "./blockfrost-fetch.server";
import {
  bfVaultUtxos,
  markerUnitOfAddress,
  quantityOf,
  readPositionDatum,
  readStateDatum,
  selectThreadState,
  threadUnitOfAddress,
  type BfUtxo,
  type VaultStateDatum,
} from "./yield-chain-decode";

/** lovelace per owner payment key hash, for the vaults in scope. */
export type OwnerWeights = Map<string, bigint>;

async function registeredVaults(assetId: string | null) {
  let q = supabaseAdmin
    .from("asset_vaults")
    .select("asset_id, script_address")
    .eq("network", "preprod");
  if (assetId) q = q.eq("asset_id", assetId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).filter((v) => !!v.script_address) as { asset_id: string; script_address: string }[];
}

async function vaultOwnerWeights(address: string, into: OwnerWeights): Promise<void> {
  const { utxos } = await bfVaultUtxos<BfUtxo>(bfGet, address, "?count=100");
  const thread = threadUnitOfAddress(address);
  const marker = markerUnitOfAddress(address);
  const states: Array<{ state: VaultStateDatum; holdsThread: boolean }> = [];
  const positions: Array<{ owner: string; shares: bigint }> = [];
  for (const u of utxos) {
    const s = readStateDatum(u.inline_datum);
    if (s) {
      states.push({ state: s, holdsThread: thread !== null && quantityOf(u.amount, thread) === 1n });
      continue;
    }
    const p = readPositionDatum(u.inline_datum);
    if (p && marker !== null && quantityOf(u.amount, marker) === 1n) {
      positions.push({ owner: p.owner.toLowerCase(), shares: BigInt(p.shares) });
    }
  }
  const { genuine } = selectThreadState(states, (c) => c.holdsThread, address);
  if (!genuine) return; // not bootstrapped: nobody holds weight here
  const totalShares = BigInt(genuine.state.totalShares);
  const totalAssets = BigInt(genuine.state.totalAssets);
  if (totalShares <= 0n) return;
  for (const p of positions) {
    const value = p.shares >= totalShares ? totalAssets : (p.shares * totalAssets) / totalShares;
    into.set(p.owner, (into.get(p.owner) ?? 0n) + value);
  }
}

/** Unspent position value per owner, across one asset's vault or all vaults. */
export async function liveOwnerWeights(assetId: string | null): Promise<OwnerWeights> {
  const out: OwnerWeights = new Map();
  for (const v of await registeredVaults(assetId)) {
    await vaultOwnerWeights(v.script_address, out);
  }
  return out;
}

/** Live weight per asset (lovelace per owner), for every registered vault. */
export async function liveOwnerWeightsByAsset(): Promise<Map<string, OwnerWeights>> {
  const out = new Map<string, OwnerWeights>();
  for (const v of await registeredVaults(null)) {
    const m = out.get(v.asset_id) ?? new Map();
    await vaultOwnerWeights(v.script_address, m);
    out.set(v.asset_id, m);
  }
  return out;
}

/** Proven wallets: payment key hash -> user id. */
export async function linkedOwners(userId?: string): Promise<Map<string, string>> {
  let q = supabaseAdmin.from("linked_wallets").select("user_id, payment_key_hash").eq("network", "preprod");
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((r) => [r.payment_key_hash.toLowerCase(), r.user_id]));
}

/** Lovelace -> ADA for display and storage. Only the final sum is converted. */
export function toAda(lovelace: bigint): number {
  return Number(lovelace) / 1_000_000;
}

/** Sum the weights of owners that map to each user. */
export function weightsPerUser(weights: OwnerWeights, owners: Map<string, string>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [pkh, value] of weights) {
    const user = owners.get(pkh);
    if (!user) continue;
    out.set(user, (out.get(user) ?? 0n) + value);
  }
  return out;
}
