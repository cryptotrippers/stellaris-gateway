/**
 * Position history, recorded only after the chain confirms it.
 *
 * The browser sends a vault id and a transaction hash — nothing else. The
 * server reads the transaction from Blockfrost, finds the marked Position
 * output owned by one of the caller's proven (signed) wallets, and writes the
 * lovelace actually locked in that output. Each hash can be recorded once.
 *
 * These rows are history only: governance weight is always read live from
 * unspent Positions (governance-weight.server.ts).
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const TX_HASH = /^[0-9a-f]{64}$/;

export const recordVaultPosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { vaultId: string; txHash: string }) => {
    const txHash = (data?.txHash ?? "").trim().toLowerCase();
    if (!data?.vaultId) throw new Error("vaultId is required");
    if (!TX_HASH.test(txHash)) throw new Error("Invalid transaction hash");
    return { vaultId: data.vaultId, txHash };
  })
  .handler(
    async ({ data, context }): Promise<{ recorded: boolean; reason?: string; amountAda?: number }> => {
      const w = await import("./governance-weight.server");
      const owners = await w.linkedOwners(context.userId);
      if (owners.size === 0) return { recorded: false, reason: "no_linked_wallet" };

      const { verifyVaultTx, TxNotYetOnChain } = await import("./vault-tx-verify.server");
      let chain;
      try {
        chain = await verifyVaultTx(data.vaultId, data.txHash);
      } catch (e) {
        if (e instanceof TxNotYetOnChain) return { recorded: false, reason: "not_on_chain_yet" };
        throw e;
      }
      const mine = chain.positions.filter((p) => owners.has(p.owner));
      if (mine.length === 0) {
        return { recorded: false, reason: "no_position_for_your_linked_wallets" };
      }
      const lovelace = mine.reduce((s, p) => s + p.lovelace, 0n);
      const amountAda = Number(lovelace) / 1_000_000;

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("vault_positions").insert({
        user_id: context.userId,
        vault_id: data.vaultId,
        amount_ada: amountAda,
        tx_hash: data.txHash,
      } as never);
      if (error) {
        if (error.code === "23505") return { recorded: false, reason: "already_recorded" };
        throw new Error(error.message);
      }
      return { recorded: true, amountAda };
    },
  );
