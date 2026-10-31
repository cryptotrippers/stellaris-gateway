import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { restoreWallet, refreshWalletConnection, disconnectWallet, getWalletState, useWallet } from "@/lib/wallet-store";

export function WalletLifecycle() {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  useEffect(() => {
    void restoreWallet().catch(() => {});
    const refresh = () => { if (document.visibilityState === "visible") void refreshWalletConnection().catch(() => {}); };
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  useEffect(() => {
    if (wallet.provider !== "WalletConnect") return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/walletconnect").then((module) => {
      if (!active) return;
      unsubscribe = module.onWalletConnectSessionChange((topic) => {
        if (getWalletState().wcTopic === topic) void disconnectWallet().catch(() => {});
      });
    }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, [wallet.provider]);
  useEffect(() => {
    // Stale chain/account projections cannot survive an account change or disconnect.
    void queryClient.cancelQueries({ predicate: (query) => ["portfolio", "my-investments", "my-vault-holdings", "governance"].includes(String(query.queryKey[0])) });
    void queryClient.invalidateQueries({ predicate: (query) => ["portfolio", "my-investments", "my-vault-holdings", "governance"].includes(String(query.queryKey[0])) });
  }, [wallet.address, wallet.networkId, queryClient]);
  return null;
}
