import { useState } from "react";
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Unlock } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useWallet } from "@/lib/wallet-store";
import {
  VAULT_SCRIPT_ADDRESS,
  checkVaultPreconditions,
  withdrawAdaFromVault,
  type WithdrawResult,
} from "@/lib/vault";

/**
 * Spend the caller's vault UTxOs back to their wallet. The validator only
 * allows this when `tx.extra_signatories` contains the owner PKH from the
 * datum — proof the Aiken script actually enforces ownership.
 */
export function WithdrawVaultCard() {
  const wallet = useWallet();
  const [status, setStatus] = useState<"idle" | "signing" | "success" | "error">("idle");
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pre = checkVaultPreconditions();
  const deployed = Boolean(VAULT_SCRIPT_ADDRESS);
  const walletReady = wallet.connected && wallet.networkId === 0;
  const canSubmit = pre.ok && status !== "signing";

  async function submit() {
    setStatus("signing");
    setError(null);
    setResult(null);
    try {
      const r = await withdrawAdaFromVault();
      setResult(r);
      setStatus("success");
    } catch (e) {
      setError((e as Error).message || "Withdraw failed");
      setStatus("error");
    }
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">On-chain · Preprod</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Withdraw from vault</h3>
        </div>
        <Badge tone={deployed ? "success" : "warning"}>
          <Unlock className="h-3 w-3" /> Owner-only
        </Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Unlocks every vault UTxO whose datum matches your payment-key hash and sends the ADA back to your wallet. The Aiken validator rejects the tx unless you sign it.
      </p>

      {!walletReady && deployed && (
        <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground">
          {wallet.connected
            ? "Switch your wallet to the Preprod testnet to sign this transaction."
            : "Connect a CIP-30 wallet from the top bar to continue."}
        </div>
      )}

      <button
        disabled={!canSubmit}
        onClick={submit}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-surface py-3 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {status === "signing" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Building spend tx…
          </>
        ) : (
          <>Unlock my vault UTxOs</>
        )}
      </button>

      {status === "error" && error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="break-words">{error}</div>
        </div>
      )}

      {status === "success" && result && (
        <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-1 font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Withdrawal submitted
          </div>
          <div className="mt-1">
            Unlocked {result.amountAda.toFixed(6)} tADA from {result.utxoCount} UTxO
            {result.utxoCount === 1 ? "" : "s"}.
          </div>
          <a
            href={`https://preprod.cardanoscan.io/transaction/${result.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-medium hover:underline"
          >
            View on Cardanoscan <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {!pre.ok && deployed && walletReady && status === "idle" && (
        <p className="mt-3 text-[11px] text-muted-foreground">{pre.reason}</p>
      )}
    </div>
  );
}
