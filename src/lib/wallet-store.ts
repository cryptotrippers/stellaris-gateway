import { useSyncExternalStore } from "react";
import { enableWallet, type CardanoWalletId } from "./cip30";
import {
  startPairing,
  disconnectSession,
  isWalletConnectConfigured,
  type Cip34Chain,
  type PairingHandle,
} from "./walletconnect";


export type WalletProvider = "Lace" | "Eternl" | "Nami" | "Typhon" | "Flint" | "Yoroi" | "GeroWallet" | "WalletConnect";

export interface WalletState {
  connected: boolean;
  provider: WalletProvider | null;
  /** Bech32 address if we've resolved it (from CIP-30 hex → bech32 via Blockfrost or wallet call), otherwise the raw hex. */
  address: string | null;
  addressHex: string | null;
  balanceAda: number;
  networkId: 0 | 1 | null; // 0 = testnet
  /** WalletConnect session topic (only set when provider === "WalletConnect"). */
  wcTopic?: string | null;
}

let state: WalletState = {
  connected: false,
  provider: null,
  address: null,
  addressHex: null,
  balanceAda: 0,
  networkId: null,
  wcTopic: null,
};

const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }

const ID_MAP: Record<Exclude<WalletProvider, "WalletConnect">, CardanoWalletId> = {
  Lace: "lace", Eternl: "eternl", Nami: "nami", Typhon: "typhon",
  Flint: "flint", Yoroi: "yoroi", GeroWallet: "gerowallet",
};


/**
 * Connect to a browser wallet via CIP-30. Falls back to a mock connection
 * if the wallet extension isn't installed, so the demo UI still functions.
 */
export async function connectWallet(provider: WalletProvider): Promise<{ ok: boolean; mock?: boolean; error?: string }> {
  const id = ID_MAP[provider];
  if (id && typeof window !== "undefined" && (window as unknown as { cardano?: Record<string, unknown> }).cardano?.[id]) {
    try {
      const info = await enableWallet(id);
      state = {
        connected: true,
        provider,
        address: info.changeAddressHex,     // hex — pass through to server for bech32 lookup if needed
        addressHex: info.changeAddressHex,
        balanceAda: info.balanceAda,
        networkId: info.networkId,
      };
      emit();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
  // fallback mock (matches previous behaviour)
  const rand = Math.random().toString(16).slice(2, 10);
  state = {
    connected: true,
    provider,
    address: `addr_test1q${rand}${"x".repeat(48)}`.slice(0, 58),
    addressHex: null,
    balanceAda: 24_812.44,
    networkId: 0,
  };
  emit();
  return { ok: true, mock: true };
}

export function disconnectWallet() {
  state = { connected: false, provider: null, address: null, addressHex: null, balanceAda: 0, networkId: null };
  emit();
}

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
}

export function shortAddr(addr: string | null) {
  if (!addr) return "";
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
