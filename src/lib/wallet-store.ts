import { useSyncExternalStore } from "react";

export type WalletProvider = "Lace" | "Eternl" | "Nami" | "WalletConnect";
export interface WalletState {
  connected: boolean;
  provider: WalletProvider | null;
  address: string | null;
  balanceAda: number;
}

let state: WalletState = {
  connected: false,
  provider: null,
  address: null,
  balanceAda: 0,
};

const listeners = new Set<() => void>();
function emit() { listeners.forEach(l => l()); }

export function connectWallet(provider: WalletProvider) {
  const rand = Math.random().toString(16).slice(2, 10);
  state = {
    connected: true,
    provider,
    address: `addr1q9${rand}${"x".repeat(48)}`.slice(0, 58),
    balanceAda: 24_812.44,
  };
  emit();
}
export function disconnectWallet() {
  state = { connected: false, provider: null, address: null, balanceAda: 0 };
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
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}
