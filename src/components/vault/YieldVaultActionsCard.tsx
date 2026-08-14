import { useState } from "react";
import { formatFeeBps } from "@/lib/vault-fees";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, PieChart, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useWallet } from "@/lib/wallet-store";
import { EXPECTED_WALLET_NETWORK_ID } from "@/lib/network";
import { NetworkSwitchHelp } from "@/components/wallet/NetworkSwitchHelp";
import { cardanoscanTx, lovelaceToAda } from "@/lib/chain-format";
import {
  depositToYieldVault,
  loadMyVaultView,
  MIN_INITIAL_DEPOSIT,
  MIN_POSITION_VALUE,
  withdrawFromYieldVault,
  type VaultView,
} from "@/lib/yield-position";
import { getAssetVault } from "@/lib/asset-vaults.functions";

/**
 * Depositor-side smart contract actions for a shared yield vault: mint shares
 * with `Deposit`, redeem them with `Withdraw`. Every figure shown is read from
 * the vault's on-chain State and Position UTxOs.
 */
export function YieldVaultActionsCard({ assetId }: { assetId: string }) {
  const wallet = useWallet();
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const walletReady = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;

  // AUDIT.md O-01: the registry's recorded address, verified against the
  // script this build derives before any builder spends the vault's UTxOs.
  const registryQ = useQuery({
    queryKey: ["asset-vault", assetId],
    queryFn: () => getAssetVault({ data: { assetId } }),
    staleTime: 60_000,
  });
  const registryAddress = registryQ.data?.script_address ?? null;

  const viewQ = useQuery<VaultView>({
    queryKey: ["yield-vault-view", assetId, wallet.address, registryAddress],
    queryFn: () => loadMyVaultView(assetId, registryAddress),
    enabled: walletReady,
    refetchInterval: walletReady ? 60_000 : false,
    retry: 0,
  });

  const view = viewQ.data ?? null;
  // Wallet-side read (needed for signing) with a server-side Blockfrost read as
  // fallback, so the position is still displayed when Lucid cannot enumerate it.
  const chainMine = useMyInvestments().investments.find((i) => i.assetId === assetId) ?? null;
  const walletShares = view ? view.positions.reduce((a, p) => a + p.shares, 0n) : 0n;
  const walletRedeemable = view ? view.positions.reduce((a, p) => a + p.redeemable, 0n) : 0n;
  const totalShares = walletShares > 0n ? walletShares : (chainMine?.shares ?? 0n);
  const totalRedeemable =
    walletShares > 0n ? walletRedeemable : (chainMine?.redeemableLovelace ?? 0n);

  const isBootstrapDeposit = view ? BigInt(view.state.totalShares) <= 0n : false;
  const minAda = Number(isBootstrapDeposit ? MIN_INITIAL_DEPOSIT : MIN_POSITION_VALUE) / 1e6;

  async function run(kind: "deposit" | "withdraw") {
    setBusy(kind);
    setError(null);
    setTxHash(null);
    try {
      if (kind === "deposit") {
        const lovelace = BigInt(Math.round((Number(amount) || 0) * 1e6));
        const r = await depositToYieldVault({ assetId, amountLovelace: lovelace, registryAddress });
        setTxHash(r.txHash);
      } else {
        const r = await withdrawFromYieldVault({ assetId, registryAddress });
        setTxHash(r.txHash);
      }
      setTimeout(() => void viewQ.refetch(), 25_000);
    } catch (e) {
      setError((e as Error).message || "Transaction failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">
            Shared vault · on-chain
          </div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">Deposit &amp; redeem shares</h3>
        </div>
        <Badge tone={view?.state.paused ? "warning" : view ? "success" : "muted"}>
          <PieChart className="h-3 w-3" />
          {view ? (view.state.paused ? "Paused" : `Epoch ${view.state.epoch}`) : "Not loaded"}
        </Badge>
      </div>

      {!walletReady ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect a wallet on the app's network to read your position and sign vault
            transactions.
          </p>
          <NetworkSwitchHelp />
        </div>
      ) : viewQ.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading vault state from chain…
        </p>
      ) : viewQ.isError ? (
        <p className="mt-4 flex items-start gap-2 text-sm text-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {(viewQ.error as Error).message}
        </p>
      ) : view ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Share price" value={`${view.sharePrice.toFixed(6)} ₳`} />
            <Stat label="Your shares" value={totalShares.toString()} />
            <Stat label="Redeemable" value={`${lovelaceToAda(totalRedeemable.toString())} ₳`} />
          </div>

          <div className="mt-3 rounded-md border border-border bg-secondary/20 p-3 text-[11px] text-muted-foreground">
            Receipt tokens: <span className="text-foreground">proof of claim — not transferable
            value</span>. One receipt is minted per share to evidence your deposit, but redemption
            is authorised by your position&apos;s owner key, not by holding the token. Sending a
            receipt to another wallet transfers no redemption right, and this vault offers no
            transfer or trading action for them.
          </div>

          <div className="mt-3 rounded-md border border-border bg-secondary/20 p-3 text-[11px] text-muted-foreground">
            Management fee <span className="text-foreground">{formatFeeBps(view.state.feeBps)}</span>{" "}
            on accounted assets, settled at each accrual by minting shares to the treasury. Unclaimed
            treasury shares:{" "}
            <span className="tabular-nums text-foreground">{view.state.treasuryShares}</span>. Your
            redeemable value already reflects the fee settled so far; fee accrued since the last
            settlement is charged at the next accrual.
          </div>



          <div className="mt-5 space-y-2">
            <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Deposit amount (ADA)
            </label>
            <div className="flex gap-2">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
              />
              <button
                onClick={() => void run("deposit")}
                disabled={busy !== null || view.state.paused || (Number(amount) || 0) < minAda}
                className="whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy === "deposit" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Deposit"}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Minimum {minAda} ADA{isBootstrapDeposit ? " for the first deposit into this vault" : ""}.
              Shares are minted at the current price; the validator re-derives every figure.
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <button
              onClick={() => void run("withdraw")}
              disabled={busy !== null || totalShares <= 0n}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
            >
              {busy === "withdraw" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Redeem full position"
              )}
            </button>
            <button
              onClick={() => void viewQ.refetch()}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
            {view.state.paused && (
              <span className="text-[11px] text-warning">
                Deposits are closed while paused; redemptions stay open at the last price.
              </span>
            )}
          </div>
        </>
      ) : null}

      {error && (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {txHash && (
        <p className="mt-4 flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Submitted —
          <a
            href={cardanoscanTx(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            {txHash.slice(0, 12)}… <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}
