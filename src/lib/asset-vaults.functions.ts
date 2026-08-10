/**
 * Asset ↔ vault registry and role lookups.
 *
 * The registry binds a real-world project (an `assets` row) to the on-chain
 * vault instance that funds it: version, script hash, bech32 address, the
 * operator committee, and the bootstrap transaction. Reads are public because
 * all of it is already public on the Cardano ledger; writes are admin-only and
 * enforced by row-level rules, not by the browser.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  BECH32_ADDRESS_RE,
  TX_HASH_RE,
} from "./yield-chain-decode";
import {
  publicSupabase,
  type AssetVaultRow,
  assertRole,
  normaliseCommittee,
  insertFeeSchedule,
  FEE_COLS,
  type VaultFeeScheduleRow,
} from "./asset-vaults.shared";
import { isValidatorKey, type ValidatorKey } from "./ref-scripts.shared";

export type { AssetVaultRow } from "./asset-vaults.shared";

/** Every registered vault, newest first. Public. */
export const listAssetVaults = createServerFn({ method: "GET" }).handler(
  async (): Promise<AssetVaultRow[]> => {
    const supabase = publicSupabase();
    const { data, error } = await supabase
      .from("asset_vaults")
      .select(
        "id, asset_id, vault_version, network, script_hash, script_address, operator_key_hashes, signature_threshold, bootstrap_tx_hash, bootstrapped_at, reporting_cadence",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as AssetVaultRow[];
  },
);

/** The vault registered for one asset, or null. Public. */
export const getAssetVault = createServerFn({ method: "GET" })
  .inputValidator((data: { assetId: string }) => {
    if (!data?.assetId) throw new Error("assetId is required");
    return { assetId: data.assetId };
  })
  .handler(async ({ data }): Promise<AssetVaultRow | null> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("asset_vaults")
      .select(
        "id, asset_id, vault_version, network, script_hash, script_address, operator_key_hashes, signature_threshold, bootstrap_tx_hash, bootstrapped_at, reporting_cadence",
      )
      .eq("asset_id", data.assetId)
      .order("vault_version", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return ((rows ?? [])[0] as AssetVaultRow | undefined) ?? null;
  });

/** Roles held by the signed-in user, for gating operator/admin surfaces. */
export const getMyRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ roles: string[] }> => {
    const { data, error } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { roles: (data ?? []).map((r: { role: string }) => r.role) };
  });

/**
 * Record a bootstrapped vault. Admin only — the row-level rules reject anyone
 * else, and the role is checked here so the UI gets a clear message.
 */
export const registerAssetVault = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      assetId: string;
      vaultVersion: number;
      network?: string;
      scriptHash: string;
      scriptAddress: string;
      operators: string[];
      threshold: number;
      bootstrapTxHash: string;
      reportingCadence?: string;
    }) => {
      if (!data?.assetId) throw new Error("assetId is required");
      if (!Number.isInteger(data.vaultVersion) || data.vaultVersion < 1) {
        throw new Error("vaultVersion must be a positive integer");
      }
      if (!/^[0-9a-f]{56}$/.test(data.scriptHash ?? "")) throw new Error("Invalid script hash");
      if (!BECH32_ADDRESS_RE.test(data.scriptAddress ?? "")) throw new Error("Invalid vault address");
      if (!TX_HASH_RE.test(data.bootstrapTxHash ?? "")) throw new Error("Invalid bootstrap tx hash");
      return {
        assetId: data.assetId,
        vaultVersion: data.vaultVersion,
        network: data.network === "mainnet" ? "mainnet" : "preprod",
        scriptHash: data.scriptHash,
        scriptAddress: data.scriptAddress,
        operators: normaliseCommittee(data.operators, data.threshold),
        threshold: data.threshold,
        bootstrapTxHash: data.bootstrapTxHash,
        reportingCadence: data.reportingCadence?.slice(0, 64) ?? null,
      };
    },
  )
  .handler(async ({ data, context }): Promise<AssetVaultRow> => {
    await assertRole(context.supabase, context.userId, "admin");

    // Gate: a vault may only be registered against a real, approved asset —
    // one created by an executed fund_asset proposal, or an explicit pilot.
    const { data: asset, error: assetErr } = await context.supabase
      .from("assets")
      .select("id, data_source, funding_status")
      .eq("id", data.assetId)
      .maybeSingle();
    if (assetErr) throw new Error(assetErr.message);
    if (!asset) throw new Error(`No asset "${data.assetId}" exists — it cannot be given a vault.`);

    const { data: approvedReq, error: reqErr } = await context.supabase
      .from("funding_requests")
      .select("id")
      .eq("asset_id", data.assetId)
      .eq("status", "asset_created")
      .limit(1);
    if (reqErr) throw new Error(reqErr.message);

    const isPilot = asset.data_source === "onchain_preprod" && asset.funding_status === "pilot";
    if ((approvedReq?.length ?? 0) === 0 && !isPilot) {
      throw new Error(
        `"${data.assetId}" has no approved funding request. An asset must pass governance and have its funding proposal executed before a vault can be bootstrapped for it.`,
      );
    }



    const { data: row, error } = await context.supabase
      .from("asset_vaults")
      .upsert(
        {
          asset_id: data.assetId,
          vault_version: data.vaultVersion,
          network: data.network,
          script_hash: data.scriptHash,
          script_address: data.scriptAddress,
          operator_key_hashes: data.operators,
          signature_threshold: data.threshold,
          bootstrap_tx_hash: data.bootstrapTxHash,
          bootstrapped_at: new Date().toISOString(),
          reporting_cadence: data.reportingCadence,
        },
        { onConflict: "asset_id,vault_version,network" },
      )
      .select(
        "id, asset_id, vault_version, network, script_hash, script_address, operator_key_hashes, signature_threshold, bootstrap_tx_hash, bootstrapped_at, reporting_cadence",
      )
      .single();
    if (error) throw new Error(error.message);
    return row as AssetVaultRow;
  });

// ---------------------------------------------------------------------------
// Management fee schedule
// ---------------------------------------------------------------------------

export type { VaultFeeScheduleRow } from "./asset-vaults.shared";

/** Fee rate in force for an asset's vault, newest first. Public. */
export const getVaultFeeSchedule = createServerFn({ method: "GET" })
  .inputValidator((data: { assetId: string }) => {
    if (!data?.assetId) throw new Error("assetId is required");
    return { assetId: data.assetId };
  })
  .handler(async ({ data }): Promise<VaultFeeScheduleRow | null> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("vault_fee_schedules")
      .select(FEE_COLS)
      .eq("asset_id", data.assetId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return ((rows ?? [])[0] as VaultFeeScheduleRow | undefined) ?? null;
  });

/**
 * Record the fee terms written into a vault's on-chain state. Admin only.
 * This is a mirror of chain facts for display; the datum remains the source
 * of truth and the UI reads the live rate from it.
 */
export const recordVaultFeeSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      assetId: string;
      vaultVersion: number;
      network?: string;
      feeBps: number;
      treasuryAddress: string;
      treasuryPkh?: string;
      setTxHash?: string;
      proposalId?: string;
    }) => {
      if (!data?.assetId) throw new Error("assetId is required");
      if (!Number.isInteger(data.feeBps) || data.feeBps < 0 || data.feeBps > 500) {
        throw new Error("feeBps must be a whole number between 0 and 500");
      }
      if (data.setTxHash && !TX_HASH_RE.test(data.setTxHash)) {
        throw new Error("Invalid transaction hash");
      }
      if (data.treasuryPkh && !/^[0-9a-f]{56}$/.test(data.treasuryPkh)) {
        throw new Error("Invalid treasury key hash");
      }
      return {
        assetId: data.assetId,
        vaultVersion: data.vaultVersion,
        network: data.network === "mainnet" ? "mainnet" : "preprod",
        feeBps: data.feeBps,
        treasuryAddress: data.treasuryAddress ?? "",
        treasuryPkh: data.treasuryPkh ?? null,
        setTxHash: data.setTxHash ?? null,
        proposalId: data.proposalId ?? null,
      };
    },
  )
  .handler(async ({ data, context }): Promise<VaultFeeScheduleRow> => {
    await assertRole(context.supabase, context.userId, "admin");
    return insertFeeSchedule(context.supabase, data);
  });

// ---------------------------------------------------------------------------
// Published reference scripts
// ---------------------------------------------------------------------------

export interface RefScriptEntry {
  txHash: string;
  outputIndex: number;
  publishedAt: string;
  scriptHash?: string;
}

/**
 * Record a reference script published for one validator of one asset vault.
 *
 * Admin only: publishing spends real ADA into a UTxO that is meant never to be
 * spent again, so a wrong entry cannot be cheaply undone. Nothing the client
 * says about *what* was published is trusted — the expected script identity is
 * re-established server-side and compared against the chain.
 */
export const recordReferenceScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      assetId: string;
      vaultVersion: number;
      validatorKey: string;
      txHash: string;
      replaceExisting?: boolean;
    }) => {
      if (!data?.assetId) throw new Error("assetId is required");
      if (!Number.isInteger(data.vaultVersion) || data.vaultVersion < 1) {
        throw new Error("vaultVersion must be a positive integer");
      }
      if (!isValidatorKey(data.validatorKey)) {
        throw new Error("validatorKey must be one of vault, yield_vault, receipt");
      }
      if (!TX_HASH_RE.test(data.txHash ?? "")) throw new Error("Invalid transaction hash");
      return {
        assetId: data.assetId,
        vaultVersion: data.vaultVersion,
        validatorKey: data.validatorKey,
        txHash: data.txHash.toLowerCase(),
        replaceExisting: data.replaceExisting === true,
      };
    },
  )
  .handler(async ({ data, context }): Promise<{ entries: Record<string, RefScriptEntry> }> => {
    await assertRole(context.supabase, context.userId, "admin");

    const { data: vault, error: vaultErr } = await context.supabase
      .from("asset_vaults")
      .select("id, script_hash, script_address, ref_script_utxos")
      .eq("asset_id", data.assetId)
      .eq("vault_version", data.vaultVersion)
      .maybeSingle();
    if (vaultErr) throw new Error(vaultErr.message);
    if (!vault) {
      throw new Error(
        `No registered vault for "${data.assetId}" version ${data.vaultVersion}. Bootstrap it before publishing reference scripts.`,
      );
    }

    const entries = {
      ...((vault.ref_script_utxos as Record<string, RefScriptEntry> | null) ?? {}),
    };
    const already = entries[data.validatorKey];
    if (already && !data.replaceExisting) {
      throw new Error(
        `A reference script for ${data.validatorKey} is already published for this vault (${already.txHash}#${already.outputIndex}). Publishing again would strand more ADA — confirm the replacement explicitly if that is really what you want.`,
      );
    }

    const { verifyPublishedReferenceScript } = await import("./ref-scripts-verify.server");
    const verified = await verifyPublishedReferenceScript({
      assetId: data.assetId,
      validatorKey: data.validatorKey,
      txHash: data.txHash,
      vault: { script_hash: vault.script_hash, script_address: vault.script_address },
    });

    entries[data.validatorKey] = {
      txHash: verified.txHash,
      outputIndex: verified.outputIndex,
      publishedAt: new Date().toISOString(),
      scriptHash: verified.scriptHash,
    };

    const { error: updErr } = await context.supabase
      .from("asset_vaults")
      .update({ ref_script_utxos: entries })
      .eq("id", vault.id);
    if (updErr) throw new Error(updErr.message);

    return { entries };
  });
