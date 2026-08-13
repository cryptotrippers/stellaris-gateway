import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Wallet, Shield } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useWallet } from "@/lib/wallet-store";
import {
  isVaultDeployedOnNetwork,
  checkVaultPreconditions,
  depositAdaToVault,
  type DepositResult,
} from "@/lib/vault";
import { VAULT_HOLDINGS_KEY } from "@/hooks/useVaultHoldings";
import { APP_NETWORK, EXPECTED_WALLET_NETWORK_ID, networkNameFromId } from "@/lib/network";
import { NetworkSwitchHelp } from "@/components/wallet/NetworkSwitchHelp";
import { recordVaultTx } from "@/lib/vault-tx-history";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";

/**
 * On-chain deposit card for the Phase-1 Preprod vault.
 * Rendered next to the mock invest widget on `/marketplace/sfm-01`.
 */
export function DepositVaultCard({ assetId }: { assetId?: string } = {}) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("5");
  const [status, setStatus] = useState<"idle" | "signing" | "success" | "error">("idle");
  const [result, setResult] = useState<DepositResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pre = checkVaultPreconditions();
  const deployed = isVaultDeployedOnNetwork();
  const walletReady = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;
  const n = Number(amount) || 0;
  const canSubmit = pre.ok && n >= 2 && status !== "signing";

  async function submit() {
    setStatus("signing");
    setError(null);
    setResult(null);
    try {
      const r = await depositAdaToVault(n, assetId);
      setResult(r);
      setStatus("success");
      recordVaultTx({
        txHash: r.txHash,
        kind: "deposit",
        amountAda: r.amountAda,
        address: wallet.address ?? "",
        assetId,
        network: APP_NETWORK === "mainnet" ? "mainnet" : "preprod",
      });
      // Nudge the live holdings card ~25s later, once the tx should be confirmed.
      setTimeout(() => queryClient.invalidateQueries({ queryKey: VAULT_HOLDINGS_KEY(wallet.address) }), 25_000);
    } catch (e) {
      setError((e as Error).message || "Deposit failed");
      setStatus("error");
    }
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">Invest</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Put money into this project</h3>
        </div>
        <Badge tone={deployed ? "success" : "warning"}>
          <Shield className="h-3 w-3" /> {deployed ? "Open" : "Not open yet"}
        </Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        This is a demo network — you're investing test funds, not real money. Your investment is
        held by the project's smart contract and only you can take it back out.
      </p>

      <details className="mt-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Technical details</summary>
        <p className="mt-1">
          Builds and submits a Cardano Preprod transaction with your connected CIP-30 wallet. Funds
          are locked at the Aiken vault script with your payment-key hash recorded as owner in the
          datum.
        </p>
      </details>

      {!deployed && (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-semibold">This project isn't open for investment yet</div>
          <div className="mt-1">
            Its contract still needs to be published to the network before deposits can be accepted.
          </div>
        </div>
      )}

      {deployed && !walletReady && (
        <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground">
          <Wallet className="mr-1 inline h-3.5 w-3.5 text-primary" />
          {wallet.connected
            ? `Your wallet is on the wrong network — this app uses ${APP_NETWORK === "mainnet" ? "Mainnet" : "the Preprod demo network"} but your wallet is on ${networkNameFromId(wallet.networkId)}. Switch it and reconnect.`
            : "Connect a wallet (Lace, Eternl or Nami) from the top bar to continue."}
          {wallet.connected && (
            <div className="mt-2"><NetworkSwitchHelp compact /></div>
          )}
        </div>
      )}

      <div className="mt-5">
        <label className="text-xs font-medium text-muted-foreground">Amount to invest</label>
        <div className="mt-1 flex items-center rounded-xl border border-border bg-surface px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <span className="text-lg text-muted-foreground">₳</span>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            className="w-full bg-transparent px-2 py-3 text-lg font-semibold number-display outline-none"
            inputMode="decimal"
            disabled={status === "signing"}
          />
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Test ADA — no real money. Minimum ₳2; the free faucet gives you 10,000 per request.
        </div>
      </div>


      <button
        disabled={!canSubmit}
        onClick={submit}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-primary py-3 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5 transition-transform"
      >
        {status === "signing" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Confirm in your wallet…
          </>
        ) : (
          <>Invest ₳{n || "—"}</>
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
            <CheckCircle2 className="h-4 w-4" /> Investment sent
          </div>
          <div className="mt-1">
            ₳{result.amountAda} is on its way. It usually confirms in about 20 seconds.
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
