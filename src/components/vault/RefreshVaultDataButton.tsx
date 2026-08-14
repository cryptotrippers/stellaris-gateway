import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useVaultDataRefresh } from "@/hooks/useVaultDataRefresh";
import { timeAgo } from "@/lib/chain-format";

/**
 * Manual refresh for every on-chain figure on the page, alongside the
 * auto-refresh timer, with a plain-language "updated X ago" stamp.
 */
export function RefreshVaultDataButton({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const { refresh, isRefreshing, lastRefreshedAt } = useVaultDataRefresh(intervalMs);

  // Re-render each second so the relative stamp stays honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick(n => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>{isRefreshing ? "Updating…" : `Updated ${timeAgo(lastRefreshedAt)}`}</span>
      <button
        type="button"
        onClick={refresh}
        disabled={isRefreshing}
        aria-label="Refresh on-chain figures"
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-foreground hover:text-primary disabled:opacity-40"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
        Refresh
      </button>
    </div>
  );
}
