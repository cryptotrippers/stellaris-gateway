import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Coins, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/StatusBadge";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { useWallet } from "@/lib/wallet-store";
import { formatDepositAmount, type DepositAsset } from "@/lib/deposit-assets.shared";
import { quoteBuy, quoteRedeem, type OfferingDatum } from "@/lib/offering-chain";
import { unitOfDepositAsset } from "@/lib/fraction-vault";
import { buyFractions, loadOffering, redeemFractions } from "@/lib/offering-tx";
import { OFFERING_STATUS_COPY } from "@/lib/offerings.shared";

interface Props {
  assetId: string;
  depositAsset: DepositAsset;
  registryAddress?: string | null;
}

/**
 * Buy or hand back fractions of one asset. Every figure shown before signing —
 * cost, platform fee, what reaches the asset — is derived from the offering's
 * own on-chain state, not from a projection.
 */
export function BuyFractionsCard({ assetId, depositAsset, registryAddress }: Props) {
  const wallet = useWallet();
  const connected = Boolean(wallet.address);
  const unit = useMemo(() => unitOfDepositAsset(depositAsset), [depositAsset]);

  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState<false | "buy" | "redeem">(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const view = useQuery({
    queryKey: ["offering-view", assetId, depositAsset.id, wallet.address],
    enabled: connected,
    retry: 0,
    queryFn: () => loadOffering(assetId, unit, registryAddress ?? null),
  });

  const datum: OfferingDatum | null = view.data?.datum ?? null;
  const amount = (() => {
    try {
      const n = BigInt(qty || "0");
      return n > 0n ? n : 0n;
    } catch {
      return 0n;
    }
  })();

  const buy = datum && amount > 0n ? quoteBuy(datum, amount) : null;
  const redeem = datum && amount > 0n ? quoteRedeem(datum, amount) : null;

  async function run(kind: "buy" | "redeem") {
    setBusy(kind);
    setError(null);
    setTxHash(null);
    try {
      const result =
        kind === "buy"
          ? await buyFractions({ assetId, unit, qty: amount, registryAddress })
          : await redeemFractions({ assetId, unit, qty: amount, registryAddress });
      setTxHash(result.txHash);
      await view.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="card-institutional p-6">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Coins className="h-4 w-4 text-primary" /> Own a piece of this asset
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect a Cardano wallet to buy fractions. Each fraction arrives in your own wallet as a
          token you can hold, send or sell — it is not held for you here.
        </p>
      </div>
    );
  }

  return (
    <div className="card-institutional p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Coins className="h-4 w-4 text-primary" /> Own a piece of this asset
        </h3>
        {datum && (
          <Badge tone={datum.status === "open" ? "success" : "muted"}>
            {OFFERING_STATUS_COPY[datum.status].label}
          </Badge>
        )}
      </div>

      {view.isLoading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading this offering from the chain…
        </p>
      ) : view.isError ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {(view.error as Error).message}
        </p>
      ) : datum ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <Stat label="Price per fraction" value={formatDepositAmount(datum.price, depositAsset, 6)} />
            <Stat
              label="Fractions left"
              value={(BigInt(datum.totalFractions) - BigInt(datum.minted)).toString()}
            />
            <Stat label="You hold" value={(view.data?.myFractions ?? 0n).toString()} />
            <Stat
              label="Backing the asset"
              value={formatDepositAmount(datum.pool, depositAsset, 2)}
            />
          </dl>

          <label className="mt-4 block text-xs text-muted-foreground" htmlFor="fraction-qty">
            How many fractions?
          </label>
          <input
            id="fraction-qty"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />

          {buy && datum.status === "open" && (
            <dl className="mt-3 space-y-1 text-xs">
              <Split label="You pay" value={formatDepositAmount(buy.cost, depositAsset, 6)} strong />
              <Split label="Platform fee" value={formatDepositAmount(buy.fee, depositAsset, 6)} />
              <Split
                label="Goes to the asset"
                value={formatDepositAmount(buy.toPool, depositAsset, 6)}
              />
            </dl>
          )}
          {redeem && datum.status === "redeeming" && (
            <dl className="mt-3 space-y-1 text-xs">
              <Split
                label="Your share of the pot"
                value={formatDepositAmount(redeem.gross, depositAsset, 6)}
              />
              <Split label="Platform fee" value={formatDepositAmount(redeem.fee, depositAsset, 6)} />
              <Split
                label="You receive"
                value={formatDepositAmount(redeem.net, depositAsset, 6)}
                strong
              />
            </dl>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== false || amount <= 0n || datum.status !== "open"}
              onClick={() => run("buy")}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy === "buy" && <Loader2 className="h-4 w-4 animate-spin" />} Buy fractions
            </button>
            {datum.status === "redeeming" && (
              <button
                type="button"
                disabled={busy !== false || amount <= 0n}
                onClick={() => run("redeem")}
                className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground disabled:opacity-50"
              >
                {busy === "redeem" && <Loader2 className="h-4 w-4 animate-spin" />} Hand back
                fractions
              </button>
            )}
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            {OFFERING_STATUS_COPY[datum.status].hint} Fractions are ordinary Cardano tokens: you can
            send or sell them at any time without asking anyone here.
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          This asset has not been opened for fractional ownership on chain yet.
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}
      {txHash && (
        <div className="mt-3 space-y-2">
          <p className="flex items-center gap-2 text-sm text-success">
            <ShieldCheck className="h-4 w-4" /> Submitted to Cardano.
          </p>
          <TxConfirmationBadge txHash={txHash} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function Split({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold text-foreground" : "text-foreground"}>{value}</dd>
    </div>
  );
}
