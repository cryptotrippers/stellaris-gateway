/**
 * Governance ↔ vault link (Step 5).
 *
 * A proposal is not just a title any more: it names the asset it concerns, the
 * action it authorises, and the exact parameters of that action. It reaches
 * `executed` only when a real Cardano transaction is verified server-side
 * against the vault's on-chain state — the browser never asserts execution.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { publicSupabase } from "./asset-vaults.shared";
import { BECH32_ADDRESS_RE, TX_HASH_RE } from "./yield-chain-decode";
import {
  MAX_FEE_BPS,
  PROPOSAL_COLUMNS,
  PROPOSAL_KINDS,
  nextSipNumber,
  requireRole,
  validateProposalParams,
  type ProposalKind,
  type ProposalRow,
  type ProposalParams,
} from "./governance-vault.shared";

export type { ProposalRow, ProposalKind } from "./governance-vault.shared";

/** Public proposal list, newest first. */
export const listVaultProposals = createServerFn({ method: "GET" })
  .inputValidator((data?: { assetId?: string }) => ({ assetId: data?.assetId ?? null }))
  .handler(async ({ data }): Promise<ProposalRow[]> => {
    const supabase = publicSupabase();
    let query = supabase
      .from("governance_proposals")
      .select(PROPOSAL_COLUMNS)
      .order("created_at", { ascending: false });
    if (data.assetId) query = query.eq("asset_id", data.assetId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as ProposalRow[];
  });

/** Create a proposal that names a concrete vault action. Signed-in users only. */
export const createVaultProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      title: string;
      body: string;
      kind: ProposalKind;
      assetId?: string | null;
      params?: Record<string, unknown>;
      votingDays?: number;
    }) => {
      const title = (data?.title ?? "").trim();
      const body = (data?.body ?? "").trim();
      if (title.length < 6 || title.length > 160) {
        throw new Error("The title must be between 6 and 160 characters.");
      }
      if (body.length < 40) {
        throw new Error("Write at least 40 characters explaining what this proposal does and why.");
      }
      if (!PROPOSAL_KINDS.includes(data?.kind)) throw new Error("Unknown proposal type.");
      const assetId = data.assetId?.trim() || null;
      const params = validateProposalParams(data.kind, assetId, data.params ?? {});
      const votingDays = Math.min(Math.max(Math.round(data.votingDays ?? 7), 1), 30);
      return { title, body: body.slice(0, 20000), kind: data.kind, assetId, params, votingDays };
    },
  )
  .handler(async ({ data, context }): Promise<{ id: string; sipNumber: string }> => {
    let params = data.params;

    if (data.kind === "fund_asset") {
      // Re-read the submitted funding request server-side: a proposal may never
      // claim different numbers than what was actually put up for review.
      const { data: fr, error: frErr } = await context.supabase
        .from("funding_requests")
        .select(
          "id, asset_slug, target_lovelace, min_deposit_lovelace, proposed_fee_bps, treasury_address",
        )
        .eq("id", String(params["funding_request_id"]))
        .maybeSingle();
      if (frErr) throw new Error(frErr.message);
      if (!fr) throw new Error("That funding request does not exist.");
      const feeBps = Number(fr.proposed_fee_bps);
      if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
        throw new Error(`The requested fee must be between 0 and ${MAX_FEE_BPS} bps.`);
      }
      params = {
        funding_request_id: fr.id,
        asset_slug: fr.asset_slug,
        target_lovelace: String(fr.target_lovelace),
        min_deposit_lovelace: String(fr.min_deposit_lovelace),
        proposed_fee_bps: feeBps,
        treasury_address: fr.treasury_address ?? "",
      };
      if (!params["treasury_address"]) {
        throw new Error("That funding request has no treasury address yet.");
      }
    }

    if (data.kind === "set_fee") {
      const { data: asset, error: aErr } = await context.supabase
        .from("assets")
        .select("id")
        .eq("id", data.assetId!)
        .maybeSingle();
      if (aErr) throw new Error(aErr.message);
      if (!asset) throw new Error("That asset does not exist.");
    }

    const { data: existing, error: listErr } = await context.supabase
      .from("governance_proposals")
      .select("sip_number");
    if (listErr) throw new Error(listErr.message);

    const now = new Date();
    const endsAt = new Date(now.getTime() + data.votingDays * 24 * 60 * 60 * 1000);

    const { data: inserted, error } = await context.supabase
      .from("governance_proposals")
      .insert({
        sip_number: nextSipNumber(existing ?? []),
        title: data.title,
        body: data.body,
        kind: data.kind,
        asset_id: data.assetId,
        params: params as never,
        author_user_id: context.userId,
        status: "active",
        votes_for_pct: 0,
        starts_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
      })
      .select("id, sip_number")
      .single();
    if (error) throw new Error(error.message);

    return { id: inserted.id as string, sipNumber: inserted.sip_number as string };
  });

/**
 * Record that a passed proposal was executed.
 *
 * For an accrual, execution is a Cardano transaction: it is verified against
 * the vault address before anything is written — it must spend and recreate
 * the vault state, bump the epoch, leave the share supply untouched, and
 * accrue exactly the approved amount.
 *
 * `fund_asset` and `set_fee` have no chain event of their own: funding a new
 * asset is what creates the vault in the first place, and a fee change is
 * mirrored from the terms the vote approved. For those two kinds the
 * "transaction" is the database becoming consistent, so a null tx hash is the
 * correct and expected outcome. Their writes go through a single Postgres
 * routine so a partial failure can never leave an executed proposal without
 * its asset.
 */
export const recordProposalExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { proposalId: string; txHash?: string | null }) => {
    if (!data?.proposalId) throw new Error("proposalId is required");
    const txHash = (data.txHash ?? "").trim().toLowerCase();
    if (txHash && !TX_HASH_RE.test(txHash)) throw new Error("Invalid transaction hash.");
    return { proposalId: data.proposalId, txHash: txHash || null };
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; reason: string }> => {
    const { data: proposal, error: pErr } = await context.supabase
      .from("governance_proposals")
      .select(PROPOSAL_COLUMNS)
      .eq("id", data.proposalId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!proposal) return { ok: false, reason: "Proposal not found." };

    const row = proposal as unknown as ProposalRow;
    if (row.status !== "passed") {
      return { ok: false, reason: "Only a proposal that has passed can be executed." };
    }
    if (row.executed_tx_hash) {
      return { ok: false, reason: "This proposal already has an execution transaction recorded." };
    }

    // --- Create a new real-world asset from an approved funding request -----
    if (row.kind === "fund_asset") {
      // Creating an asset is an admin decision, distinct from operating an
      // existing vault, so the operator role is deliberately not enough.
      await requireRole(context.supabase, context.userId, "admin");

      const fundingRequestId = String(row.params?.["funding_request_id"] ?? "");
      if (!fundingRequestId) {
        return { ok: false, reason: "This proposal names no funding request." };
      }
      // Re-read the request server-side; nothing from the client is trusted.
      const { data: fr, error: frErr } = await context.supabase
        .from("funding_requests")
        .select("id, asset_slug, status")
        .eq("id", fundingRequestId)
        .maybeSingle();
      if (frErr) throw new Error(frErr.message);
      if (!fr) return { ok: false, reason: "That funding request no longer exists." };

      // The RPC is service-role only; the admin check above already gated it.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: created, error: rpcErr } = await supabaseAdmin.rpc(
        "execute_fund_asset_proposal",
        { _proposal_id: row.id, _user_id: context.userId } as never,
      );
      if (rpcErr) return { ok: false, reason: rpcErr.message };
      return { ok: true, reason: `Asset "${String(created)}" created and proposal executed.` };
    }

    // --- Apply the approved management fee ---------------------------------
    if (row.kind === "set_fee") {
      await requireRole(context.supabase, context.userId, "operator");
      if (!row.asset_id) return { ok: false, reason: "This proposal names no asset." };

      const feeBps = Number(row.params?.["fee_bps"]);
      const treasuryAddress = String(row.params?.["treasury_address"] ?? "");
      if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
        return { ok: false, reason: `The approved fee must be between 0 and ${MAX_FEE_BPS} bps.` };
      }
      if (!BECH32_ADDRESS_RE.test(treasuryAddress)) {
        return { ok: false, reason: "The approved treasury address is not a valid address." };
      }

      const { data: feeVault, error: fvErr } = await context.supabase
        .from("asset_vaults")
        .select("vault_version, network")
        .eq("asset_id", row.asset_id)
        .order("vault_version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fvErr) throw new Error(fvErr.message);
      if (!feeVault) {
        return { ok: false, reason: "No bootstrapped vault is registered for this asset." };
      }

      const { insertFeeSchedule } = await import("./asset-vaults.shared");
      await insertFeeSchedule(context.supabase, {
        assetId: row.asset_id,
        vaultVersion: feeVault.vault_version as number,
        network: (feeVault.network as string) ?? "preprod",
        feeBps,
        treasuryAddress,
        proposalId: row.id,
      });

      // Service-role only RPC; the operator check above already gated it.
      const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
      const { error: markErr } = await admin.rpc(
        "mark_proposal_executed_offchain",
        { _proposal_id: row.id, _user_id: context.userId } as never,
      );
      if (markErr) return { ok: false, reason: markErr.message };
      return { ok: true, reason: "New fee schedule recorded and proposal executed." };
    }

    // --- Everything else is an on-chain accrual ----------------------------
    await requireRole(context.supabase, context.userId, "operator");
    if (row.kind !== "accrue") {
      return {
        ok: false,
        reason: "Only accrual proposals can be verified automatically right now.",
      };
    }
    if (!data.txHash) return { ok: false, reason: "A transaction hash is required." };
    if (!row.asset_id) return { ok: false, reason: "This proposal names no asset." };



    const { data: vault, error: vErr } = await context.supabase
      .from("asset_vaults")
      .select("script_address, vault_version, network")
      .eq("asset_id", row.asset_id)
      .order("vault_version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!vault || !BECH32_ADDRESS_RE.test(vault.script_address as string)) {
      return { ok: false, reason: "No bootstrapped vault is registered for this asset." };
    }

    const expected = String(row.params?.["amount_lovelace"] ?? "");
    const { verifyAccrualTx } = await import("./yield-chain.functions");
    const check = await verifyAccrualTx({
      data: {
        txHash: data.txHash,
        address: vault.script_address as string,
        expectedLovelace: expected || undefined,
      },
    });
    if (!check.ok) return { ok: false, reason: check.reason };

    const blockTimeIso = check.blockTime
      ? new Date(check.blockTime * 1000).toISOString()
      : new Date().toISOString();

    const { error: aErr } = await context.supabase.from("yield_accruals").insert({
      asset_id: row.asset_id,
      vault_version: vault.vault_version as number,
      network: (vault.network as string) ?? "preprod",
      tx_hash: data.txHash,
      epoch: check.epoch ?? 0,
      amount_lovelace: check.amountLovelace ?? "0",
      total_assets_after: "0",
      total_shares_after: "0",
      block_time: blockTimeIso,
      proposal_id: row.id,
    } as never);
    // A duplicate accrual row is not a failure — the chain is the source of
    // truth and this table is only a cache.
    if (aErr && !aErr.message.toLowerCase().includes("duplicate")) {
      throw new Error(aErr.message);
    }

    const { error: uErr } = await context.supabase
      .from("governance_proposals")
      .update({
        status: "executed",
        executed_tx_hash: data.txHash,
        executed_at: blockTimeIso,
        executed_epoch: check.epoch,
      })
      .eq("id", row.id);
    if (uErr) throw new Error(uErr.message);

    return { ok: true, reason: "Execution verified on chain and recorded." };
  });
