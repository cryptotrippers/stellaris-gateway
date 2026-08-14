import { useCallback, useEffect, useState } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

/** Query keys that hold anything read from (or derived from) the chain. */
const CHAIN_KEYS = [
  "asset",
  "asset-vault",
  "vault-chain-state",
  "vault-chain-history",
  "yield-vault-view",
  "vault-holdings",
  "vault-returns",
];

function isChainKey(key: readonly unknown[]): boolean {
  return typeof key[0] === "string" && CHAIN_KEYS.includes(key[0]);
}

/**
 * One switch for every on-chain read on a project page: refreshes the registry
 * row, vault state, history, holdings and share balances together so the
 * headline numbers can never drift apart, and keeps them current on a timer.
 *
 * @param intervalMs polling period; pass 0 to disable the timer.
 */
export function useVaultDataRefresh(intervalMs = 60_000) {
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ predicate: q => isChainKey(q.queryKey) });
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(() => Date.now());

  const refresh = useCallback(() => {
    setLastRefreshedAt(Date.now());
    void queryClient.invalidateQueries({ predicate: q => isChainKey(q.queryKey) });
  }, [queryClient]);

  useEffect(() => {
    if (!intervalMs) return;
    // Pause polling while the tab is hidden, then catch up on return.
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, refresh]);

  return { refresh, isRefreshing: fetching > 0, lastRefreshedAt };
}
