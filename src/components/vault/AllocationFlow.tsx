import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Layers,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { useWallet } from "@/lib/wallet-store";
import { APP_NETWORK, EXPECTED_WALLET_NETWORK_ID } from "@/lib/network";
import { NetworkSwitchHelp } from "@/components/wallet/NetworkSwitchHelp";
import { cardanoscanTx } from "@/lib/chain-format";
import { listDepositAssets } from "@/lib/deposit-assets.functions";
import {
  DEPOSIT_STATUS_COPY,
  formatDepositAmount,
  type DepositAsset,
} from "@/lib/deposit-assets.shared";
import { createStellarisYieldAdapter } from "@/lib/adapters/stellaris-yield.adapter";
import type { RwaVaultAccounting, RwaVaultDescriptor } from "@/lib/rwa-adapter";

type Step = "denomination" | "amount" | "confirm" | "done";

/**
 * Deposit → allocation flow.
 *
 * Pick a supported denomination from the open registry, size the deposit, let
 * the adapter confirm the vault is live and quote the share price, then submit
 * the transaction that mints Stellaris-style fractional shares. Every figure is
 * read through the `RwaVaultAdapter` interface, never hard-coded.
 */
export function AllocationFlow({ assetId }: { assetId: string }) {
  const wallet = useWallet();
  const walletReady = wallet.connected && wallet.networkId === EXPECTED_WALLET_NETWORK_ID;

  const [step, setStep] = useState<Step>("denomination");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [amount, setAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [mintedShares, setMintedShares] = useState<bigint | null>(null);

  const registryQ = useQuery<DepositAsset[]>({
    queryKey: ["deposit-assets"],
    queryFn: () => listDepositAssets(),
    staleTime: 300_000,
  });

  const options = useMemo(
    () => (registryQ.data ?? []).filter((a) => a.network === APP_NETWORK),
    [registryQ.data],
  );
  const selected = options.find((a) => a.id === selectedId) ?? null;

  const adapter = useMemo(
    () => (selected ? createStellarisYieldAdapter(selected) : null),
    [selected],
  );

  // Adapter confirmation: the vault must be registered, un-paused, and able to
  // quote a share price before any transaction is offered.
  const confirmQ = useQuery<{ descriptor: RwaVaultDescriptor | null; accounting: RwaVaultAccounting }>({
    queryKey: ["allocation-adapter", assetId, selected?.id, wallet.address],
    enabled: step === "confirm" && !!adapter && walletReady,
    retry: 0,
    queryFn: async () => {
      const a = adapter!;
      const descriptor = await a.describe(assetId);
      if (!descriptor) throw new Error("No vault is registered for this project yet.");
      const accounting = await a.readAccounting(assetId);
      return { descriptor, accounting };
    },
  });

  const accounting = confirmQ.data?.accounting ?? null;
  const baseAmount = selected
    ? BigInt(Math.round((Number(amount) || 0) * 10 ** selected.decimals))
    : 0n;
  const projectedShares =
    accounting && accounting.sharePrice > 0
      ? BigInt(Math.floor(Number(baseAmount) / accounting.sharePrice))
      : null;

  const canAllocate =
    !!adapter &&
    !!accounting &&
    !accounting.paused &&
    baseAmount > 0n &&
    !busy &&
    walletReady;

  async function allocate() {
    if (!adapter?.deposit) return;
    setBusy(true);
    setError(null);
    try {
      const r = await adapter.deposit(assetId, baseAmount);
      setTxHash(r.txHash);
      setMintedShares(projectedShares);
      setStep("done");
    } catch (e) {
      setError((e as Error).message || "Allocation failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep("denomination");
    setTxHash(null);
    setMintedShares(null);
    setError(null);
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-primary">
            Deposit → allocation
          </div>
          <h3 className="mt-1 text-sm font-semibold text-foreground">
            Allocate capital into fractional shares
          </h3>
        </div>
        <Badge tone="muted">
          <Layers className="h-3 w-3" /> Open adapter
        </Badge>
      </div>

      <ol className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {(["denomination", "amount", "confirm", "done"] as Step[]).map((s, i) => (
          <li
            key={s}
            className={`rounded-full border px-2.5 py-1 ${
              step === s ? "border-primary text-primary" : "border-border"
            }`}
          >
            {i + 1}. {s === "denomination" ? "Denomination" : s === "amount" ? "Amount" : s === "confirm" ? "Adapter check" : "Shares"}
          </li>
        ))}
      </ol>

      {!walletReady && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Connect a wallet on the app&apos;s network to allocate.
          </p>
          <NetworkSwitchHelp />
        </div>
      )}

      {step === "denomination" && (
        <div className="mt-5 space-y-2">
          {registryQ.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the deposit-asset registry…
            </p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No deposit assets are registered on this network yet.
            </p>
          ) : (
            options.map((a) => {
              const usable = a.status !== "planned";
              return (
                <button
                  key={a.id}
                  disabled={!usable}
                  onClick={() => {
                    setSelectedId(a.id);
                    setStep("amount");
                  }}
                  className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-colors ${
                    usable
                      ? "border-border hover:border-primary"
                      : "cursor-not-allowed border-border/60 opacity-60"
                  }`}
                >
                  <div>
                    <div className="text-sm font-semibold text-foreground">
                      {a.symbol} · {a.display_name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {a.issuer_name} — {DEPOSIT_STATUS_COPY[a.status].hint}
                    </div>
                  </div>
                  <Badge tone={a.status === "live" ? "success" : a.status === "test" ? "muted" : "warning"}>
                    {DEPOSIT_STATUS_COPY[a.status].label}
                  </Badge>
                </button>
              );
            })
          )}
        </div>
      )}

      {step === "amount" && selected && (
        <div className="mt-5 space-y-3">
          <label className="text-[11px] uppercase tracking-widest text-muted-foreground">
            Deposit amount ({selected.symbol})
          </label>
          <div className="flex gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold tabular-nums outline-none focus:border-primary"
            />
            <button
              onClick={() => setStep("confirm")}
              disabled={baseAmount <= 0n}
              className="inline-flex items-center gap-1 rounded-xl bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              Continue <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {formatDepositAmount(baseAmount, selected, 6)} will be committed to this project&apos;s
            vault. {APP_NETWORK === "preprod" ? "Preprod test funds — not real money." : null}
          </p>
          <button onClick={() => setStep("denomination")} className="text-[11px] underline text-muted-foreground">
            Change denomination
          </button>
        </div>
      )}

      {step === "confirm" && selected && (
        <div className="mt-5 space-y-3">
          {confirmQ.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adapter is confirming the vault on
              chain…
            </p>
          ) : confirmQ.isError ? (
            <p className="flex items-start gap-2 text-sm text-warning">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {(confirmQ.error as Error).message}
            </p>
          ) : accounting ? (
            <>
              <div className="rounded-lg border border-border bg-secondary/20 p-3 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-1 font-semibold text-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Adapter confirmed
                </div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  <div>Share price: <span className="tabular-nums text-foreground">{accounting.sharePrice.toFixed(6)}</span></div>
                  <div>Epoch: <span className="tabular-nums text-foreground">{accounting.epoch}</span></div>
                  <div>Total shares: <span className="tabular-nums text-foreground">{accounting.totalShares.toString()}</span></div>
                  <div>Status: <span className="text-foreground">{accounting.paused ? "Paused" : "Open"}</span></div>
                </div>
              </div>
              <div className="rounded-lg border border-border p-3 text-sm">
                Depositing{" "}
                <span className="font-semibold">{formatDepositAmount(baseAmount, selected, 6)}</span>{" "}
                mints approximately{" "}
                <span className="font-semibold tabular-nums">
                  {projectedShares?.toString() ?? "—"}
                </span>{" "}
                fractional shares. The exact figure is set by the validator at settlement.
              </div>
              {accounting.paused && (
                <p className="text-[11px] text-warning">
                  This vault is paused — deposits are closed until operators unpause it.
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setStep("amount")}
                  className="rounded-xl border border-border px-4 py-2 text-sm"
                >
                  Back
                </button>
                <button
                  onClick={allocate}
                  disabled={!canAllocate}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-primary py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Confirm in your wallet…
                    </>
                  ) : (
                    <>Allocate &amp; mint shares</>
                  )}
                </button>
              </div>
            </>
          ) : null}

          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      )}

      {step === "done" && txHash && (
        <div className="mt-5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          <div className="flex items-center gap-1 font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Allocation submitted
          </div>
          <div className="mt-1">
            {mintedShares ? `≈ ${mintedShares.toString()} fractional shares` : "Shares"} will appear
            in your position once the transaction confirms.
          </div>
          <a
            href={cardanoscanTx(txHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-medium hover:underline"
          >
            View on Cardanoscan <ExternalLink className="h-3 w-3" />
          </a>
          <div>
            <button onClick={reset} className="mt-2 underline">
              Allocate again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
