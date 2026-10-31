/**
 * Keeper panel for /tessera: Requests that are payable now, and a button any
 * connected Preprod wallet can use to settle them (it earns the settle tips).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";
import { TxConfirmationBadge } from "@/components/vault/TxConfirmationBadge";
import { useWallet } from "@/lib/wallet-store";
import { getTesseraLive } from "@/lib/tessera-live.functions";
import { classifyTesseraError } from "@/lib/tessera-tx";
import { SETTLE_BATCH, formatUnits, requestsOf } from "@/lib/tessera-ui.shared";
import { TESSERA_LIVE_KEY } from "./TesseraActions";

export function TesseraKeeperPanel() {
  const wallet = useWallet();
  const qc = useQueryClient();
  const live = useQuery({
    queryKey: TESSERA_LIVE_KEY,
    queryFn: () => getTesseraLive(),
    refetchInterval: 60_000,
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const payable = live.data
    ? requestsOf(live.data, "all", Date.now()).filter((r) => r.payable)
    : [];
  const batch = payable.slice(0, SETTLE_BATCH);
  const tip = live.data ? BigInt(live.data.queue.config.settleTip) : 0n;

  async function settle() {
    setBusy(true);
    setError(null);
    setHash(null);
    try {
      const { runTesseraAction } = await import("@/lib/tessera-session");
      const r = await runTesseraAction({ kind: "settle", requests: batch.map((x) => x.utxo) });
      setHash(r.txHash);
      void qc.invalidateQueries({ queryKey: ["tessera"] });
    } catch (e) {
      setError(classifyTesseraError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="home-container home-section" aria-label="Use Tessera">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card-institutional p-5">
          <h2 className="text-sm font-semibold text-foreground">Use it on Preprod</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stake test TSRA for sTSRA, unstake through a Ticket, or redeem TSRA for test tUSD — with
            a Preprod wallet.
          </p>
          <Link to="/stake" className="mt-3 inline-block text-sm text-primary hover:underline">
            Stake, unstake or redeem →
          </Link>
        </div>
        <div className="card-institutional p-5">
          <h2 className="text-sm font-semibold text-foreground">Keeper</h2>
          {live.isLoading ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the queue…
            </p>
          ) : payable.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              No Requests are waiting to be paid.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {payable.length} Request(s) are payable now (
                {formatUnits(
                  payable.reduce((a, r) => a + BigInt(r.qty), 0n),
                  2,
                )}{" "}
                TSRA). Anyone can pay them out from the queue and earn{" "}
                {formatUnits(tip * BigInt(batch.length), 2)} ADA in tips.
              </p>
              <button
                type="button"
                disabled={!wallet.connected || busy}
                onClick={() => void settle()}
                className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Settle {batch.length}
              </button>
              {!wallet.connected && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Connect a Preprod wallet first.
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="mt-2 flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
            </p>
          )}
          {hash && <TxConfirmationBadge txHash={hash} />}
        </div>
      </div>
    </section>
  );
}
