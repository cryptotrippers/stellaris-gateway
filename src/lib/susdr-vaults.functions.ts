/**
 * sUSDr vault registry server functions — mirrors `asset-vaults.functions.ts`.
 * Reads are public (already public on the Cardano ledger); writes are
 * admin/operator-only, enforced by row-level rules, not by the browser.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BECH32_ADDRESS_RE, TX_HASH_RE } from "./susdr-chain-decode";
import {
  publicSupabase,
  assertRole,
  normaliseCommittee,
  fetchVaultOr404,
  SUSDR_VAULT_COLUMNS,
  type SusdrVaultRow,
  type SusdrAccrualRow,
} from "./susdr-vaults.shared";

export type { SusdrVaultRow, SusdrAccrualRow } from "./susdr-vaults.shared";

/** Every registered sUSDr vault, newest first. Public. */
export const listSusdrVaults = createServerFn({ method: "GET" }).handler(
  async (): Promise<SusdrVaultRow[]> => {
    const supabase = publicSupabase();
    const { data, error } = await supabase
      .from("susdr_vaults")
      .select(SUSDR_VAULT_COLUMNS)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as SusdrVaultRow[];
  },
);

/** The vault registered for a USDr policy, or null. Public. */
export const getSusdrVault = createServerFn({ method: "GET" })
  .inputValidator((data: { usdrPolicyId: string }) => {
    if (!/^[0-9a-f]{56}$/.test(data?.usdrPolicyId ?? "")) {
      throw new Error("usdrPolicyId must be a 28-byte hex policy id");
    }
    return { usdrPolicyId: data.usdrPolicyId };
  })
  .handler(async ({ data }): Promise<SusdrVaultRow | null> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("susdr_vaults")
      .select(SUSDR_VAULT_COLUMNS)
      .eq("usdr_policy_id", data.usdrPolicyId)
      .order("vault_version", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return (rows?.[0] as SusdrVaultRow | undefined) ?? null;
  });

/** Roles held by the signed-in user, for gating operator/admin surfaces. */
export const getMySusdrRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ roles: string[] }> => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { roles: (data ?? []).map((r: { role: string }) => r.role) };
  });

/** Record a bootstrapped vault. Admin only. */
export const registerSusdrVault = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      vaultVersion: number;
      network?: string;
      usdrPolicyId: string;
      scriptHash: string;
      susdrPolicyId: string;
      scriptAddress: string;
      operators: string[];
      threshold: number;
      feeBps?: number;
      treasuryKeyHash?: string;
      bootstrapTxHash: string;
    }) => {
      if (!Number.isInteger(data.vaultVersion) || data.vaultVersion < 1) {
        throw new Error("vaultVersion must be a positive integer");
      }
      if (!/^[0-9a-f]{56}$/.test(data.usdrPolicyId ?? "")) throw new Error("Invalid USDr policy id");
      if (!/^[0-9a-f]{56}$/.test(data.scriptHash ?? "")) throw new Error("Invalid script hash");
      if (data.scriptHash !== data.susdrPolicyId) {
        throw new Error(
          "scriptHash must equal susdrPolicyId — susdr_vault's spend and mint handlers share one hash (see DESIGN.md).",
        );
      }
      if (!BECH32_ADDRESS_RE.test(data.scriptAddress ?? "")) throw new Error("Invalid vault address");
      if (!TX_HASH_RE.test(data.bootstrapTxHash ?? "")) throw new Error("Invalid bootstrap tx hash");
      const feeBps = data.feeBps ?? 0;
      if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 500) {
        throw new Error("feeBps must be a whole number between 0 and 500");
      }
      const treasuryKeyHash = data.treasuryKeyHash?.trim().toLowerCase() || null;
      if (treasuryKeyHash && !/^[0-9a-f]{56}$/.test(treasuryKeyHash)) {
        throw new Error("Invalid treasury key hash");
      }
      return {
        vaultVersion: data.vaultVersion,
        network: data.network === "mainnet" ? "mainnet" : "preprod",
        usdrPolicyId: data.usdrPolicyId.toLowerCase(),
        scriptHash: data.scriptHash.toLowerCase(),
        susdrPolicyId: data.susdrPolicyId.toLowerCase(),
        scriptAddress: data.scriptAddress,
        operators: normaliseCommittee(data.operators, data.threshold),
        threshold: data.threshold,
        feeBps,
        treasuryKeyHash,
        bootstrapTxHash: data.bootstrapTxHash,
      };
    },
  )
  .handler(async ({ data, context }): Promise<SusdrVaultRow> => {
    await assertRole(context.supabase, context.userId, "admin");

    const { data: row, error } = await context.supabase
      .from("susdr_vaults")
      .upsert(
        {
          vault_version: data.vaultVersion,
          network: data.network,
          usdr_policy_id: data.usdrPolicyId,
          script_hash: data.scriptHash,
          susdr_policy_id: data.susdrPolicyId,
          script_address: data.scriptAddress,
          operator_key_hashes: data.operators,
          signature_threshold: data.threshold,
          fee_bps: data.feeBps,
          treasury_key_hash: data.treasuryKeyHash,
          bootstrap_tx_hash: data.bootstrapTxHash,
          bootstrapped_at: new Date().toISOString(),
        },
        { onConflict: "usdr_policy_id,vault_version,network" },
      )
      .select(SUSDR_VAULT_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return row as SusdrVaultRow;
  });

/** Record a real, on-chain Accrue transaction. Operator only. */
export const recordSusdrAccrual = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      usdrPolicyId: string;
      network?: string;
      txHash: string;
      epoch: number;
      amountUsdr: string;
      totalAssetsAfter: string;
      totalSharesAfter: string;
      sharePriceBefore?: number;
      sharePriceAfter?: number;
      feeSharesMinted?: string;
      blockHeight?: number;
      blockTime: string;
    }) => {
      if (!/^[0-9a-f]{56}$/.test(data.usdrPolicyId ?? "")) throw new Error("Invalid USDr policy id");
      if (!TX_HASH_RE.test(data.txHash ?? "")) throw new Error("Invalid tx hash");
      if (!Number.isInteger(data.epoch) || data.epoch < 1) throw new Error("Invalid epoch");
      return {
        usdrPolicyId: data.usdrPolicyId.toLowerCase(),
        network: data.network === "mainnet" ? "mainnet" : "preprod",
        txHash: data.txHash,
        epoch: data.epoch,
        amountUsdr: data.amountUsdr,
        totalAssetsAfter: data.totalAssetsAfter,
        totalSharesAfter: data.totalSharesAfter,
        sharePriceBefore: data.sharePriceBefore ?? null,
        sharePriceAfter: data.sharePriceAfter ?? null,
        feeSharesMinted: data.feeSharesMinted ?? "0",
        blockHeight: data.blockHeight ?? null,
        blockTime: data.blockTime,
      };
    },
  )
  .handler(async ({ data, context }): Promise<SusdrAccrualRow> => {
    await assertRole(context.supabase, context.userId, "operator");
    const vault = await fetchVaultOr404(context.supabase, data.usdrPolicyId);

    const { data: row, error } = await context.supabase
      .from("susdr_accruals")
      .upsert(
        {
          vault_id: vault.id,
          network: data.network,
          tx_hash: data.txHash,
          epoch: data.epoch,
          amount_usdr: data.amountUsdr,
          total_assets_after: data.totalAssetsAfter,
          total_shares_after: data.totalSharesAfter,
          share_price_before: data.sharePriceBefore,
          share_price_after: data.sharePriceAfter,
          fee_shares_minted: data.feeSharesMinted,
          block_height: data.blockHeight,
          block_time: data.blockTime,
        },
        { onConflict: "tx_hash,network" },
      )
      .select("id, vault_id, network, tx_hash, epoch, amount_usdr, total_assets_after, total_shares_after, share_price_before, share_price_after, fee_shares_minted, block_height, block_time")
      .single();
    if (error) throw new Error(error.message);
    return row as SusdrAccrualRow;
  });

/** Accrual history for a vault, newest first. Public. */
export const listSusdrAccruals = createServerFn({ method: "GET" })
  .inputValidator((data: { usdrPolicyId: string; limit?: number }) => {
    if (!/^[0-9a-f]{56}$/.test(data?.usdrPolicyId ?? "")) throw new Error("Invalid USDr policy id");
    return { usdrPolicyId: data.usdrPolicyId, limit: Math.min(Math.max(data.limit ?? 50, 1), 200) };
  })
  .handler(async ({ data }): Promise<SusdrAccrualRow[]> => {
    const supabase = publicSupabase();
    const vault = await fetchVaultOr404(supabase, data.usdrPolicyId);
    const { data: rows, error } = await supabase
      .from("susdr_accruals")
      .select("id, vault_id, network, tx_hash, epoch, amount_usdr, total_assets_after, total_shares_after, share_price_before, share_price_after, fee_shares_minted, block_height, block_time")
      .eq("vault_id", vault.id)
      .order("epoch", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return (rows ?? []) as SusdrAccrualRow[];
  });
