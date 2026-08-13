import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Unlock, ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useWallet } from "@/lib/wallet-store";
import {
  isVaultDeployedOnNetwork,
  checkVaultPreconditions,
  withdrawAdaFromVault,
  type WithdrawResult,
} from "@/lib/vault";
import { APP_NETWORK, EXPECTED_WALLET_NETWORK_ID, networkNameFromId } from "@/lib/network";
import { VAULT_HOLDINGS_KEY } from "@/hooks/useVaultHoldings";
import { NetworkSwitchHelp } from "@/components/wallet/NetworkSwitchHelp";
import { recordVaultTx } from "@/lib/vault-tx-history";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { ConfirmAllWithdrawDialog } from "@/components/vault/ConfirmAllWithdrawDialog";

/**
 * Spend the caller's vault UTxOs back to their wallet. The validator only
 * allows this when `tx.extra_signatories` contains the owner PKH from the
 * datum — proof the Aiken script actually enforces ownership.
 */
export function WithdrawVaultCard({ assetId }: { assetId?: string } = {}) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"idle" | "signing" | "success" | "error">("idle");
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submissionInFlight = useRef(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);

  const pre = checkVaultPreconditions();
  const deployed = isVaultDeployedOnNetwork();
  const walletReady = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;
  const canSubmit = pre.ok && status !== "signing";

  async function submit() {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setStatus("signing");
    setError(null);
    setResult(null);
    try {
      const r = await withdrawAdaFromVault(assetId);
      setResult(r);
      setStatus("success");
      recordVaultTx({
        txHash: r.txHash,
        kind: "withdraw",
        amountAda: r.amountAda,
        utxoCount: r.utxoCount,
        address: wallet.address ?? "",
        assetId,
        network: APP_NETWORK === "mainnet" ? "mainnet" : "preprod",
      });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: VAULT_HOLDINGS_KEY(wallet.address) }), 25_000);
    } catch (e) {
      const message = (e as Error).message || "Withdraw failed";
      setError(message);
      setStatus("error");
      if (message.includes("already been spent")) {
        void queryClient.invalidateQueries({ queryKey: VAULT_HOLDINGS_KEY(wallet.address) });
      }
    } finally {
      submissionInFlight.current = false;
    }
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">Cash out</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Take your money back</h3>
        </div>
        <Badge tone={deployed ? "success" : "warning"}>
          <Unlock className="h-3 w-3" /> Only you
        </Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Sends everything you've invested in this project back to your wallet. Nobody else can move
        it — the contract only releases funds to you.
      </p>

      <details className="mt-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Technical details</summary>
        <p className="mt-1">
          Spends every vault UTxO whose datum matches your payment-key hash. The Aiken validator
          rejects the transaction unless your key signs it.
        </p>
      </details>

      {!walletReady && deployed && (
        <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground">
          {wallet.connected
            ? `Your wallet is on the wrong network — this app uses ${APP_NETWORK === "mainnet" ? "Mainnet" : "the Preprod demo network"} but your wallet is on ${networkNameFromId(wallet.networkId)}. Switch it and reconnect.`
            : "Connect a wallet from the top bar to continue."}
          {wallet.connected && (
            <div className="mt-2"><NetworkSwitchHelp compact /></div>
          )}
        </div>
      )}


      <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_auto]">
        <button
          disabled={!canSubmit}
          onClick={submit}
          aria-busy={status === "signing"}
          aria-disabled={!canSubmit}
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-primary/40 bg-surface py-3 text-sm font-semibold text-primary hover:bg-primary/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {status === "signing" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Preparing your withdrawal…
            </>
          ) : (
            <>Withdraw</>
          )}

        </button>
        <button
          type="button"
          onClick={() => setConfirmAllOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={confirmAllOpen}
          aria-controls="confirm-all-title"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-foreground hover:border-primary/40 hover:text-primary transition-colors"
        >
          <ListChecks className="h-4 w-4" aria-hidden="true" /> Confirm all
        </button>
      </div>

      <ConfirmAllWithdrawDialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen} assetId={assetId} />

      {status === "error" && error && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="break-words">{error}</div>
        </div>
      )}

      {status === "success" && result && (
        <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-1 font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Withdrawal sent
          </div>
          <div className="mt-1">
            ₳{result.amountAda.toFixed(2)} is on its way back to your wallet.
          </div>

          <a
            href={`https://preprod.cardanoscan.io/transaction/${result.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-medium hover:underline"
          >
            View on Cardanoscan <ExternalLink className="h-3 w-3" />
          </a>
          <div><TxConfirmationBadge txHash={result.txHash} /></div>
        </div>
      )}

      {!pre.ok && deployed && walletReady && status === "idle" && (
        <p className="mt-3 text-[11px] text-muted-foreground">{pre.reason}</p>
      )}
    </div>
  );
}
