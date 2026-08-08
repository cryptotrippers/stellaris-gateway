/**
 * Stage 4 — recording an accrual after it lands on chain.
 *
 * Nothing is written from the client's word alone: the handler re-reads the
 * transaction from Blockfrost, decodes the vault state before and after, and
 * only stores the row when the ledger itself proves an accrual happened.
 *
 * Module scope holds only imports, types and server-function declarations.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  BECH32_ADDRESS_RE,
  TX_HASH_RE,
  readStateDatum,
  sharePriceOf,
  type BfTxUtxos,
  type VaultStateDatum,
} from "./yield-chain-decode";
import { publicSupabase } from "./asset-vaults.shared";

export interface YieldAccrualRow {
  id: string;
  asset_id: string;
  epoch: number;
  amount_lovelace: number;
  total_assets_after: number;
  total_shares_after: number;
  share_price_before: number | null;
  share_price_after: number | null;
  tx_hash: string;
  block_time: string;
}

/** Recorded accruals for one asset, newest first. Public. */
export const listYieldAccruals = createServerFn({ method: "GET" })
  .inputValidator((data: { assetId: string }) => {
    if (!data?.assetId) throw new Error("assetId is required");
    return { assetId: data.assetId };
  })
  .handler(async ({ data }): Promise<YieldAccrualRow[]> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("yield_accruals")
      .select(
        "id, asset_id, epoch, amount_lovelace, total_assets_after, total_shares_after, share_price_before, share_price_after, tx_hash, block_time",
      )
      .eq("asset_id", data.assetId)
      .order("epoch", { ascending: false });
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as YieldAccrualRow[];
  });

/**
 * Verify an accrual transaction on chain and record it. Requires the operator
 * or admin role; the row-level rules enforce the same thing independently.
 */
export const recordYieldAccrual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      assetId: string;
      vaultVersion: number;
      address: string;
      txHash: string;
      proposalId?: string | null;
    }) => {
      if (!data?.assetId) throw new Error("assetId is required");
      if (!TX_HASH_RE.test(data?.txHash ?? "")) throw new Error("Invalid transaction hash");
      if (!BECH32_ADDRESS_RE.test(data?.address ?? "")) {
        throw new Error("A valid bech32 vault address is required");
      }
      if (!Number.isInteger(data.vaultVersion)) throw new Error("vaultVersion must be an integer");
      return {
        assetId: data.assetId,
        vaultVersion: data.vaultVersion,
        address: data.address,
        txHash: data.txHash,
        proposalId: data.proposalId ?? null,
      };
    },
  )
  .handler(async ({ data, context }): Promise<{ recorded: boolean; epoch: number }> => {
    const { supabase, userId } = context;

    const [{ data: isOperator }, { data: isAdmin }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: userId, _role: "operator" } as never),
      supabase.rpc("has_role", { _user_id: userId, _role: "admin" } as never),
    ]);
    if (!isOperator && !isAdmin) {
      throw new Error("Recording an accrual requires the operator or admin role.");
    }

    const { bfGet } = await import("./blockfrost-fetch.server");
    const detail = await bfGet<BfTxUtxos>(`/txs/${data.txHash}/utxos`);
    if (!detail) throw new Error("Transaction not found on chain yet — wait for confirmation.");

    const before = detail.inputs
      .filter((i) => i.address === data.address)
      .map((i) => readStateDatum(i.inline_datum))
      .find((s): s is VaultStateDatum => s !== null);
    const after = detail.outputs
      .filter((o) => o.address === data.address)
      .map((o) => readStateDatum(o.inline_datum))
      .find((s): s is VaultStateDatum => s !== null);

    if (!before || !after) {
      throw new Error("This transaction does not spend and recreate the vault state.");
    }
    const amount = BigInt(after.totalAssets) - BigInt(before.totalAssets);
    if (after.epoch !== before.epoch + 1) throw new Error("The vault epoch did not advance by one.");
    if (after.totalShares !== before.totalShares) {
      throw new Error("Share supply changed — this is not an accrual.");
    }
    if (amount <= 0n) throw new Error("No yield was added in this transaction.");

    const tx = await bfGet<{ block_time: number; block_height: number }>(`/txs/${data.txHash}`);

    const { error } = await supabase.from("yield_accruals").insert({
      asset_id: data.assetId,
      vault_version: data.vaultVersion,
      tx_hash: data.txHash,
      epoch: after.epoch,
      amount_lovelace: Number(amount),
      total_assets_after: Number(after.totalAssets),
      total_shares_after: Number(after.totalShares),
      share_price_before: sharePriceOf(before),
      share_price_after: sharePriceOf(after),
      block_height: tx?.block_height ?? null,
      block_time: new Date((tx?.block_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      proposal_id: data.proposalId,
    } as never);
    if (error) throw new Error(error.message);

    return { recorded: true, epoch: after.epoch };
  });
