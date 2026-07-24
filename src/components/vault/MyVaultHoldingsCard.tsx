import { Loader2, RefreshCw, Coins, ExternalLink, Eye } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useEffectiveAddress, useWallet } from "@/lib/wallet-store";
import { useVaultHoldings } from "@/hooks/useVaultHoldings";
import { EXPECTED_WALLET_NETWORK_ID } from "@/lib/network";

/**
 * Live view of the connected wallet's (or a tracked address's) on-chain vault
 * UTxOs. Auto-refreshes every 30s.
 */
export function MyVaultHoldingsCard() {
  const wallet = useWallet();
  const eff = useEffectiveAddress();
  const { holdings, totalAda, isLoading, isFetching, error, refetch, enabled, mode } =
    useVaultHoldings();
  const wrongNetwork = eff.address !== null && eff.networkId !== EXPECTED_WALLET_NETWORK_ID;

  return (
    <div className="card-institutional p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">On-chain · Preprod</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">
            {mode === "viewer" ? "Tracked address · on-chain position" : "Your on-chain position"}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {isFetching && enabled && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Badge tone={mode === "viewer" ? "primary" : "success"}>
            {mode === "viewer" ? <Eye className="h-3 w-3" /> : <Coins className="h-3 w-3" />}
            {mode === "viewer" ? "Read-only" : "Live"}
          </Badge>
          <button
            onClick={() => refetch()}
            disabled={!enabled || isFetching}
            aria-label="Refresh holdings"
            className="rounded-md border border-border bg-surface p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {!enabled && (
        <p className="mt-4 text-xs text-muted-foreground">
          {wrongNetwork
            ? "This address is for a different network than the app is pointed at."
            : wallet.connected
            ? "Switch your wallet to the Preprod testnet to see your on-chain position."
            : "Connect a wallet, or paste a payment / stake address, to view vault UTxOs."}
        </p>
      )}


      {enabled && (
        <>
          <div className="mt-5 rounded-xl bg-secondary/60 p-4">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Total locked</div>
            <div className="mt-1 number-display text-3xl font-semibold text-foreground">
              {isLoading ? "…" : totalAda.toFixed(6)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">tADA</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {isLoading
                ? "Reading UTxOs at the vault script…"
                : `${holdings.length} UTxO${holdings.length === 1 ? "" : "s"} owned by this wallet`}
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive break-words">
              {error.message}
            </div>
          )}

          {!isLoading && !error && holdings.length === 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              No confirmed deposits yet. New deposits appear ~20s after the tx confirms on Preprod.
            </p>
          )}

          {holdings.length > 0 && (
            <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-surface">
              {holdings.map(h => (
                <li key={`${h.txHash}#${h.outputIndex}`} className="flex items-center justify-between px-3 py-2.5 text-xs">
                  <div className="min-w-0">
                    <a
                      href={`https://preprod.cardanoscan.io/transaction/${h.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-foreground hover:text-primary"
                    >
                      {h.txHash.slice(0, 10)}…{h.txHash.slice(-6)}#{h.outputIndex}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="number-display font-semibold text-foreground">
                    {h.ada.toFixed(6)} <span className="text-muted-foreground font-normal">tADA</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
