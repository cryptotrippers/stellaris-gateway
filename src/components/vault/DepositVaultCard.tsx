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

/**
 * On-chain deposit card for the Phase-1 Preprod vault.
 * Rendered next to the mock invest widget on `/marketplace/sfm-01`.
 */
export function DepositVaultCard() {
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
      const r = await depositAdaToVault(n);
      setResult(r);
      setStatus("success");
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
          <div className="text-[10px] uppercase tracking-widest text-primary">On-chain · Preprod</div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Deposit ADA into vault</h3>
        </div>
        <Badge tone={deployed ? "success" : "warning"}>
          <Shield className="h-3 w-3" /> {deployed ? "Vault live" : "Not deployed"}
        </Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        This card builds and submits a real Cardano transaction on the Preprod testnet using your connected wallet. Funds are locked at the Aiken vault script with your payment-key hash as the owner.
      </p>

      {!deployed && (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <div className="font-semibold">Compile the validator first</div>
          <div className="mt-1">
            Run <code className="font-mono">aiken build</code> in <code className="font-mono">contracts/vault/</code>, derive the Preprod script address, then set{" "}
            <code className="font-mono">VITE_VAULT_SCRIPT_ADDRESS</code> in <code className="font-mono">.env.development</code>. See <code className="font-mono">contracts/vault/README.md</code>.
          </div>
        </div>
      )}

      {deployed && !walletReady && (
        <div className="mt-4 rounded-lg border border-border bg-secondary/60 p-3 text-xs text-muted-foreground">
          <Wallet className="mr-1 inline h-3.5 w-3.5 text-primary" />
          {wallet.connected
            ? `Network mismatch — this app is on ${APP_NETWORK === "mainnet" ? "Mainnet" : "Preprod testnet"} but your wallet is on ${networkNameFromId(wallet.networkId)}. Switch your wallet's network and reconnect.`
            : "Connect a CIP-30 wallet (Lace, Eternl, Nami) from the top bar to continue."}
          {wallet.connected && (
            <div className="mt-2"><NetworkSwitchHelp compact /></div>
          )}
        </div>
      )}

      <div className="mt-5">
        <label className="text-xs font-medium text-muted-foreground">Amount (tADA)</label>
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
          Min. 2 tADA · Preprod faucet gives 10,000 tADA per request.
        </div>
      </div>

      <button
        disabled={!canSubmit}
        onClick={submit}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-primary py-3 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5 transition-transform"
      >
        {status === "signing" ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for wallet signature…
          </>
        ) : (
          <>Lock {n || "—"} tADA in vault</>
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
            <CheckCircle2 className="h-4 w-4" /> Deposit submitted
          </div>
          <div className="mt-1">
            {result.amountAda} tADA locked at the vault. Confirmation usually takes ~20s on Preprod.
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
