/**
 * Durable ledger for vault transactions the wallet has actually submitted to
 * Preprod.
 *
 * Rows are written only by the server, after Blockfrost confirms the
 * transaction exists and touches the registered vault. The amount stored is
 * the net lovelace that moved at the vault address on chain, not the figure
 * the browser sent. Each transaction hash can be recorded once, by one user.
 * Recording is best-effort and never blocks a submitted transaction.
 *
 * Server-function modules carry only imports, types and declarations.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  normaliseVaultTxRecord,
  type VaultTxInput,
} from "@/lib/vault-transactions.shared";
import { parseInput, vaultTxInputSchema } from "./input-guards.shared";

/** Record one submitted vault transaction against the signed-in user. */
export const recordVaultTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: VaultTxInput): VaultTxInput => parseInput(vaultTxInputSchema, input))
  .handler(
    async ({ data, context }): Promise<{ recorded: boolean; txHash: string; reason?: string }> => {
      const { enforceRateLimit, RATE_RULES } = await import("./rate-limit.server");
      await enforceRateLimit(RATE_RULES.vaultTx, context.userId);
      const row = normaliseVaultTxRecord(data);
      const { verifyVaultTx, TxNotYetOnChain } = await import("./vault-tx-verify.server");
      let chain;
      try {
        chain = await verifyVaultTx(row.vault_id, row.tx_hash);
      } catch (e) {
        if (e instanceof TxNotYetOnChain) {
          return { recorded: false, txHash: row.tx_hash, reason: "not_on_chain_yet" };
        }
        throw e;
      }
      const net = chain.netLovelace < 0n ? -chain.netLovelace : chain.netLovelace;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: existing } = await supabaseAdmin
        .from("transactions")
        .select("user_id")
        .eq("tx_hash", row.tx_hash)
        .maybeSingle();
      if (existing) {
        if (existing.user_id !== context.userId) {
          throw new Error("This transaction is already recorded by another account.");
        }
        return { recorded: false, txHash: row.tx_hash, reason: "already_recorded" };
      }
      const { error } = await supabaseAdmin.from("transactions").insert({
        user_id: context.userId,
        vault_id: row.vault_id,
        type: row.type,
        amount_ada: Number(net) / 1_000_000,
        tx_hash: row.tx_hash,
        block_height: chain.blockHeight,
      } as never);
      if (error) {
        if (error.code === "23505") {
          return { recorded: false, txHash: row.tx_hash, reason: "already_recorded" };
        }
        throw new Error(error.message);
      }
      return { recorded: true, txHash: row.tx_hash };
    },
  );
