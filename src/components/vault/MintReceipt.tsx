import { useMemo, useState } from "react";
import { CheckCircle2, Copy, Download, ExternalLink, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { cardanoscanTx, short } from "@/lib/chain-format";
import { formatDepositAmount, type DepositAsset } from "@/lib/deposit-assets.shared";
import { APP_NETWORK } from "@/lib/network";

export interface MintReceiptData {
  txHash: string;
  /** Project / asset the shares belong to. */
  assetId: string;
  /** Denomination the deposit was made in. */
  depositAsset: DepositAsset;
  /** Deposit amount in base units of the denomination. */
  amount: bigint;
  /** Fractional shares minted (estimate until the tx settles). */
  shares: bigint | null;
  /** Share price quoted by the adapter at submission. */
  sharePrice: number | null;
  /** Epoch reported by the vault accounting at submission. */
  epoch: number | null;
  /** Unix ms the transaction was submitted. */
  submittedAt: number;
}

function line(label: string, value: string) {
  return { label, value };
}

/**
 * Minting receipt shown after a successful allocation: transaction hash,
 * asset details, share quantity, and timestamp — copyable and downloadable.
 */
export function MintReceipt({ data }: { data: MintReceiptData }) {
  const [copied, setCopied] = useState(false);

  const submitted = new Date(data.submittedAt);
  const rows = useMemo(
    () => [
      line("Receipt", `STL-${data.txHash.slice(0, 8).toUpperCase()}`),
      line("Project", data.assetId),
      line("Denomination", `${data.depositAsset.symbol} · ${data.depositAsset.display_name}`),
      line("Deposited", formatDepositAmount(data.amount, data.depositAsset, 6)),
      line("Shares minted", data.shares !== null ? data.shares.toString() : "Pending settlement"),
      line("Share price", data.sharePrice !== null ? data.sharePrice.toFixed(6) : "—"),
      line("Epoch", data.epoch !== null ? String(data.epoch) : "—"),
      line("Network", APP_NETWORK),
      line("Transaction", data.txHash),
      line("Timestamp", `${submitted.toISOString()} (${submitted.toLocaleString()})`),
    ],
    [data, submitted],
  );

  const asText = useMemo(
    () =>
      ["Stellaris minting receipt", "", ...rows.map((r) => `${r.label}: ${r.value}`)].join("\n"),
    [rows],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(asText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    const blob = new Blob([asText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stellaris-receipt-${data.txHash.slice(0, 12)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          Minting receipt
        </div>
        <Badge tone="muted">
          <Receipt className="h-3 w-3" /> {APP_NETWORK}
        </Badge>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd
              className="truncate text-right font-medium tabular-nums text-foreground"
              title={r.value}
            >
              {r.label === "Transaction" ? short(r.value, 10, 8) : r.value}
            </dd>
          </div>
        ))}
      </dl>

      <TxConfirmationBadge txHash={data.txHash} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={cardanoscanTx(data.txHash)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium hover:border-primary"
        >
          View on Cardanoscan <ExternalLink className="h-3 w-3" />
        </a>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium hover:border-primary"
        >
          <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy receipt"}
        </button>
        <button
          onClick={download}
          className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium hover:border-primary"
        >
          <Download className="h-3 w-3" /> Download
        </button>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Share quantity is the adapter&apos;s quote at submission; the validator sets the exact
        figure at settlement.
      </p>
    </div>
  );
}
