/**
 * Reads a submitted vault transaction back from Blockfrost so history rows
 * are written from the ledger, never from what the browser says happened.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { bfGet } from "./blockfrost-fetch.server";
import {
  lovelaceOf,
  markerUnitOfAddress,
  quantityOf,
  readPositionDatum,
  sameScriptCredential,
  type BfAmount,
} from "./yield-chain-decode";

interface BfIo {
  address: string;
  amount: BfAmount[];
  inline_datum: string | null;
  output_index?: number;
}
interface BfTxUtxos {
  inputs: BfIo[];
  outputs: BfIo[];
}
interface BfTx {
  block_height: number | null;
  block_time: number | null;
}

export interface VerifiedVaultTx {
  vaultAddress: string;
  blockHeight: number | null;
  /** lovelace into the vault minus lovelace out of it (negative = withdrawal). */
  netLovelace: bigint;
  /** Marked Position outputs created by this tx, with their owners. */
  positions: Array<{ owner: string; lovelace: bigint; shares: bigint; outputIndex: number }>;
}

export class TxNotYetOnChain extends Error {}

export async function verifyVaultTx(vaultId: string, txHash: string): Promise<VerifiedVaultTx> {
  const { data: vault, error } = await supabaseAdmin
    .from("asset_vaults")
    .select("script_address")
    .eq("asset_id", vaultId)
    .eq("network", "preprod")
    .order("vault_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!vault?.script_address) throw new Error("That vault is not registered.");
  const vaultAddress = vault.script_address;

  const [io, tx] = await Promise.all([
    bfGet<BfTxUtxos>(`/txs/${txHash}/utxos`),
    bfGet<BfTx>(`/txs/${txHash}`),
  ]);
  if (!io || !tx) throw new TxNotYetOnChain("The transaction is not on chain yet.");

  const atVault = (a: string) => sameScriptCredential(a, vaultAddress);
  const inLovelace = io.inputs.filter((i) => atVault(i.address)).reduce((s, i) => s + lovelaceOf(i), 0n);
  const outs = io.outputs.filter((o) => atVault(o.address));
  const outLovelace = outs.reduce((s, o) => s + lovelaceOf(o), 0n);
  if (outs.length === 0 && inLovelace === 0n) {
    throw new Error("That transaction does not touch this vault.");
  }

  const marker = markerUnitOfAddress(vaultAddress);
  const positions: VerifiedVaultTx["positions"] = [];
  io.outputs.forEach((o, idx) => {
    if (!atVault(o.address)) return;
    const p = readPositionDatum(o.inline_datum);
    if (!p || marker === null || quantityOf(o.amount, marker) !== 1n) return;
    positions.push({
      owner: p.owner.toLowerCase(),
      lovelace: lovelaceOf(o),
      shares: BigInt(p.shares),
      outputIndex: o.output_index ?? idx,
    });
  });

  return {
    vaultAddress,
    blockHeight: tx.block_height ?? null,
    netLovelace: outLovelace - inLovelace,
    positions,
  };
}
