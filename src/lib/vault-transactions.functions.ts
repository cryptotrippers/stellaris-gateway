/**
 * Durable ledger for vault transactions the wallet has actually submitted to
 * Preprod.
 *
 * The transaction builders sign and submit on chain, but until now nothing
 * wrote the resulting hash anywhere except browser localStorage, so the
 * portfolio page and the dApp readiness report both saw an empty
 * `transactions` table for flows that demonstrably work. Recording is
 * best-effort and never blocks a submitted transaction: the chain is the
 * source of truth, this table is history.
 *
 * Server-function modules carry only imports, types and declarations.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  normaliseVaultTxRecord,
  type VaultTxInput,
} from "@/lib/vault-transactions.shared";

/** Record one submitted vault transaction against the signed-in user. */
export const recordVaultTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: VaultTxInput) => input)
  .handler(async ({ data, context }) => {
    const row = normaliseVaultTxRecord(data);
    const { error } = await context.supabase
      .from("transactions")
      .upsert({ ...row, user_id: context.userId } as never, {
        onConflict: "tx_hash",
        ignoreDuplicates: true,
      });
    if (error) throw new Error(error.message);
    return { recorded: true as const, txHash: row.tx_hash };
  });
