import { useEffect, useState, useCallback } from "react";

export type VaultTxKind = "deposit" | "withdraw";

export interface VaultTxRecord {
  txHash: string;
  kind: VaultTxKind;
  amountAda: number;
  /** Wallet payment address that submitted the tx. */
  address: string;
  /** For withdraw: number of UTxOs unlocked. */
  utxoCount?: number;
  /** Asset id the vault deposit is tagged with. */
  assetId?: string;
  network: "preprod" | "mainnet";
  createdAt: number;
}

const KEY = "vault:tx-history:v1";
const MAX = 100;
const EVT = "vault-tx-history:changed";

function safeRead(): VaultTxRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as VaultTxRecord[]) : [];
  } catch {
    return [];
  }
}

function safeWrite(rows: VaultTxRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX)));
    window.dispatchEvent(new Event(EVT));
  } catch {
    /* quota / private mode — ignore */
  }
}

export function getVaultTxHistory(): VaultTxRecord[] {
  return safeRead();
}

export function recordVaultTx(row: Omit<VaultTxRecord, "createdAt">): VaultTxRecord {
  const record: VaultTxRecord = { ...row, createdAt: Date.now() };
  const rows = safeRead();
  // Dedupe on txHash — same tx should not appear twice.
  const filtered = rows.filter(r => r.txHash !== record.txHash);
  filtered.unshift(record);
  safeWrite(filtered);
  return record;
}

export function clearVaultTxHistory(): void {
  safeWrite([]);
}

/** Subscribe to history changes across tabs + within the same tab. */
export function useVaultTxHistory(): VaultTxRecord[] {
  const [rows, setRows] = useState<VaultTxRecord[]>(() => safeRead());
  useEffect(() => {
    const sync = () => setRows(safeRead());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return rows;
}

export function useClearVaultTxHistory() {
  return useCallback(() => clearVaultTxHistory(), []);
}
