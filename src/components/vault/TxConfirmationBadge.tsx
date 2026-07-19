import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { useTxConfirmation } from "@/hooks/useTxConfirmation";

/**
 * Live confirmation state for a submitted vault transaction.
 * Polls Blockfrost every ~8s until the tx is included in a block.
 */
export function TxConfirmationBadge({ txHash }: { txHash: string }) {
  const { data } = useTxConfirmation(txHash);
  const state = data?.state ?? "pending";

  if (state === "confirmed") {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        Confirmed on-chain · {data?.confirmations ?? 1} confirmation{data?.confirmations === 1 ? "" : "s"}
        {data?.block ? <span className="text-emerald-700/70 dark:text-emerald-300/70"> · block {data.block}</span> : null}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
        <AlertCircle className="h-3 w-3" />
        Couldn't verify confirmation · {data?.detail ?? "Blockfrost error"}
      </div>
    );
  }
  return (
    <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Waiting for block inclusion…
    </div>
  );
}
