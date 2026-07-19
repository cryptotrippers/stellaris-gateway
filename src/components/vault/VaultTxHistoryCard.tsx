import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Copy, Check, History, Trash2 } from "lucide-react";
import { useVaultTxHistory, clearVaultTxHistory, type VaultTxRecord } from "@/lib/vault-tx-history";
import { useTxConfirmation } from "@/hooks/useTxConfirmation";
import { useWallet } from "@/lib/wallet-store";
import { toast } from "sonner";

function scanUrl(network: VaultTxRecord["network"], hash: string) {
  return network === "mainnet"
    ? `https://cardanoscan.io/transaction/${hash}`
    : `https://preprod.cardanoscan.io/transaction/${hash}`;
}

function shortHash(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

function relative(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TxRow({ row }: { row: VaultTxRecord }) {
  const { data } = useTxConfirmation(row.txHash);
  const [copied, setCopied] = useState(false);

  const state = data?.state ?? "pending";
  const isDeposit = row.kind === "deposit";

  async function copy() {
    try {
      await navigator.clipboard.writeText(row.txHash);
      setCopied(true);
      toast.success("Transaction hash copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard unavailable");
    }
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 p-3">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${isDeposit ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"}`}>
        {isDeposit ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <div className="text-xs font-semibold text-foreground">
            {isDeposit ? "Deposit" : "Withdraw"} · {row.amountAda.toFixed(row.amountAda < 1 ? 6 : 2)} {row.network === "mainnet" ? "ADA" : "tADA"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{relative(row.createdAt)}</div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <code className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{shortHash(row.txHash)}</code>
          <button
            onClick={copy}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40"
            aria-label="Copy transaction hash"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <a
            href={scanUrl(row.network, row.txHash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-primary hover:border-primary/40"
          >
            Cardanoscan <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="mt-1.5 text-[11px]">
          {state === "confirmed" ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              ✓ Confirmed · {data?.confirmations ?? 1} conf{data?.confirmations === 1 ? "" : "s"}
              {data?.block ? ` · block ${data.block}` : ""}
            </span>
          ) : state === "error" ? (
            <span className="text-destructive">Couldn't verify · {data?.detail ?? "Blockfrost error"}</span>
          ) : (
            <span className="text-muted-foreground">Pending inclusion in a block…</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Local, wallet-scoped ledger of every vault deposit / withdraw this browser
 * has submitted. Each row polls Blockfrost live so users can see confirmation
 * status without leaving the app, and every row deep-links to Cardanoscan
 * so the same records remain accessible from any device.
 */
export function VaultTxHistoryCard({ assetId }: { assetId?: string }) {
  const wallet = useWallet();
  const all = useVaultTxHistory();
  const [filter, setFilter] = useState<"all" | "mine" | "asset">(assetId ? "asset" : "all");

  const rows = useMemo(() => {
    let out = all;
    if (filter === "mine" && wallet.address) {
      out = out.filter(r => r.address === wallet.address);
    } else if (filter === "asset" && assetId) {
      out = out.filter(r => r.assetId === assetId);
    }
    return out;
  }, [all, filter, wallet.address, assetId]);

  return (
    <div className="card-institutional p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-primary">
            <History className="h-3 w-3" /> Transaction history
          </div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">All vault transactions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every deposit and withdrawal from this browser, with live on-chain confirmation.
          </p>
        </div>
        {all.length > 0 && (
          <button
            onClick={() => {
              clearVaultTxHistory();
              toast.success("Local history cleared");
            }}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-destructive hover:border-destructive/40"
            aria-label="Clear local transaction history"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {(
          [
            ["all", `All (${all.length})`],
            ["mine", "This wallet"],
            ...(assetId ? ([["asset", "This asset"]] as const) : []),
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setFilter(k as typeof filter)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
              filter === k
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No transactions yet. Deposits and withdrawals will appear here the instant they're signed.
          </div>
        ) : (
          rows.map(r => <TxRow key={r.txHash} row={r} />)
        )}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        History is stored locally in this browser for quick access. The transactions themselves live permanently on Cardano — every row above deep-links to the immutable record on Cardanoscan.
      </p>
    </div>
  );
}
