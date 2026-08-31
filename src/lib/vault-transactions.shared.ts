/**
 * Validation for the vault transaction ledger, shared by the server function
 * and any caller that wants to check a payload before sending it.
 */

export type VaultTxType = "deposit" | "withdraw" | "yield";

export interface VaultTxInput {
  /** Asset id the vault is registered under, e.g. `ph-solar-01`. */
  vaultId: string;
  type: VaultTxType;
  /** Amount in ADA (not lovelace), as the table stores it. */
  amountAda: number;
  txHash: string;
  blockHeight?: number | null;
}

const TX_HASH = /^[0-9a-f]{64}$/;

export function normaliseVaultTxRecord(data: VaultTxInput) {
  if (!data?.vaultId) throw new Error("vaultId is required");
  if (!["deposit", "withdraw", "yield"].includes(data.type)) {
    throw new Error("Unsupported transaction type");
  }
  if (!TX_HASH.test((data.txHash ?? "").toLowerCase())) {
    throw new Error("Invalid transaction hash");
  }
  const amount = Number(data.amountAda);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("amountAda must be a non-negative number");
  }
  return {
    vault_id: data.vaultId,
    type: data.type,
    amount_ada: amount,
    tx_hash: data.txHash.toLowerCase(),
    block_height: data.blockHeight ?? null,
  };
}
