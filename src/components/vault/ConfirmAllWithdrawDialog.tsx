import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Unlock, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useWallet } from "@/lib/wallet-store";
import {
  checkVaultPreconditions,
  withdrawAdaFromVault,
  type WithdrawResult,
} from "@/lib/vault";
import { APP_NETWORK } from "@/lib/network";
import { VAULT_HOLDINGS_KEY } from "@/hooks/useVaultHoldings";
import { recordVaultTx, useVaultTxHistory, type VaultTxRecord } from "@/lib/vault-tx-history";
import { useTxConfirmation } from "@/hooks/useTxConfirmation";
import { toast } from "sonner";

function scanUrl(network: VaultTxRecord["network"], hash: string) {
  return network === "mainnet"
    ? `https://cardanoscan.io/transaction/${hash}`
    : `https://preprod.cardanoscan.io/transaction/${hash}`;
}
function shortHash(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

/** One row: polls Blockfrost for its confirmation and reports up. */
function PendingRow({
  row,
  onState,
}: {
  row: VaultTxRecord;
  onState: (hash: string, state: "pending" | "confirmed" | "error", confirmations: number) => void;
}) {
  const { data } = useTxConfirmation(row.txHash);
  const state = (data?.state ?? "pending") as "pending" | "confirmed" | "error" | "not_found";
  const normalized: "pending" | "confirmed" | "error" =
    state === "confirmed" ? "confirmed" : state === "error" ? "error" : "pending";

  useEffect(() => {
    onState(row.txHash, normalized, data?.confirmations ?? 0);
  }, [normalized, data?.confirmations, row.txHash, onState]);

  return (
    <li
      className="flex items-start gap-3 rounded-lg border border-border bg-surface/40 p-3"
      aria-live="polite"
    >
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          normalized === "confirmed"
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : normalized === "error"
            ? "bg-destructive/10 text-destructive"
            : "bg-primary/10 text-primary"
        }`}
        aria-hidden="true"
      >
        {normalized === "confirmed" ? (
          <CheckCircle2 className="h-3.5 w-3.5" />
        ) : normalized === "error" ? (
          <AlertCircle className="h-3.5 w-3.5" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <div className="text-xs font-semibold text-foreground">
            Withdraw · {row.amountAda.toFixed(row.amountAda < 1 ? 6 : 2)}{" "}
            {row.network === "mainnet" ? "ADA" : "tADA"}
            {row.utxoCount ? (
              <span className="ml-1 text-muted-foreground">
                · {row.utxoCount} UTxO{row.utxoCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
          <a
            href={scanUrl(row.network, row.txHash)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            {shortHash(row.txHash)} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="mt-1 text-[11px]">
          {normalized === "confirmed" ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              Confirmed on-chain · {data?.confirmations ?? 1} confirmation
              {data?.confirmations === 1 ? "" : "s"}
              {data?.block ? ` · block ${data.block}` : ""}
            </span>
          ) : normalized === "error" ? (
            <span className="text-destructive">
              Couldn't verify · {data?.detail ?? "Blockfrost error"}
            </span>
          ) : (
            <span className="text-muted-foreground">Waiting for block inclusion…</span>
          )}
        </div>
      </div>
    </li>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal that (a) submits a new withdraw tx behind a duplicate-submit guard
 * and (b) tracks the confirmation of every unconfirmed vault withdraw this
 * browser has seen — with per-tx progress and an aggregate progress bar —
 * until they all reach the chain.
 */
export function ConfirmAllWithdrawDialog({ open, onOpenChange }: Props) {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const history = useVaultTxHistory();

  // Track this session's pending rows: rows created since dialog opened plus
  // any prior unconfirmed rows for this wallet on this network.
  const [trackedHashes, setTrackedHashes] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, { state: "pending" | "confirmed" | "error"; conf: number }>>({});
  const submissionInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Seed tracked set on open: include the wallet's recent withdraws.
  useEffect(() => {
    if (!open) return;
    const network = APP_NETWORK === "mainnet" ? "mainnet" : "preprod";
    const seed = history
      .filter(
        (r) =>
          r.kind === "withdraw" &&
          r.network === network &&
          (!wallet.address || r.address === wallet.address),
      )
      .slice(0, 5)
      .map((r) => r.txHash);
    setTrackedHashes((prev) => {
      const next = new Set(prev);
      seed.forEach((h) => next.add(h));
      return next;
    });
    // We intentionally only seed on open transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rows = useMemo(
    () => history.filter((r) => trackedHashes.has(r.txHash)),
    [history, trackedHashes],
  );

  const totals = useMemo(() => {
    const total = rows.length;
    let confirmed = 0;
    let pending = 0;
    let errored = 0;
    rows.forEach((r) => {
      const s = statuses[r.txHash]?.state ?? "pending";
      if (s === "confirmed") confirmed += 1;
      else if (s === "error") errored += 1;
      else pending += 1;
    });
    return { total, confirmed, pending, errored };
  }, [rows, statuses]);

  const pct = totals.total === 0 ? 0 : Math.round((totals.confirmed / totals.total) * 100);
  const allDone = totals.total > 0 && totals.pending === 0;
  const pre = checkVaultPreconditions();
  const canSubmit = pre.ok && !submitting && !submissionInFlight.current;

  function handleStatus(hash: string, state: "pending" | "confirmed" | "error", conf: number) {
    setStatuses((prev) => {
      const cur = prev[hash];
      if (cur && cur.state === state && cur.conf === conf) return prev;
      return { ...prev, [hash]: { state, conf } };
    });
  }

  async function submit() {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r: WithdrawResult = await withdrawAdaFromVault();
      const network = APP_NETWORK === "mainnet" ? "mainnet" : "preprod";
      recordVaultTx({
        txHash: r.txHash,
        kind: "withdraw",
        amountAda: r.amountAda,
        utxoCount: r.utxoCount,
        address: wallet.address ?? "",
        network,
      });
      setTrackedHashes((prev) => new Set(prev).add(r.txHash));
      toast.success(`Withdraw submitted · ${shortHash(r.txHash)}`);
      setTimeout(
        () => queryClient.invalidateQueries({ queryKey: VAULT_HOLDINGS_KEY(wallet.address) }),
        25_000,
      );
    } catch (e) {
      const message = (e as Error).message || "Withdraw failed";
      setSubmitError(message);
      if (message.includes("already been spent")) {
        void queryClient.invalidateQueries({ queryKey: VAULT_HOLDINGS_KEY(wallet.address) });
      }
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        aria-labelledby="confirm-all-title"
        aria-describedby="confirm-all-desc"
      >
        <DialogHeader>
          <DialogTitle id="confirm-all-title" className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Confirm all vault withdrawals
          </DialogTitle>
          <DialogDescription id="confirm-all-desc">
            Submit a new unlock and track every pending withdraw until Cardano confirms them.
            Duplicate submissions are blocked automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Aggregate progress */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {totals.total === 0
                  ? "No transactions to confirm yet"
                  : `${totals.confirmed} of ${totals.total} confirmed`}
                {totals.errored > 0 ? ` · ${totals.errored} needs review` : ""}
              </span>
              <span className="font-mono text-muted-foreground">{pct}%</span>
            </div>
            <Progress
              value={pct}
              aria-label="Overall confirmation progress"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>

          {/* Per-tx list */}
          <ul
            className="max-h-64 space-y-2 overflow-y-auto pr-1"
            aria-label="Pending withdrawal transactions"
          >
            {rows.length === 0 ? (
              <li className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Click "Confirm all" to sign a new withdraw. Its confirmation status will appear
                here.
              </li>
            ) : (
              rows.map((r) => <PendingRow key={r.txHash} row={r} onState={handleStatus} />)
            )}
          </ul>

          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div className="break-words">{submitError}</div>
            </div>
          )}

          {!pre.ok && (
            <p className="text-[11px] text-muted-foreground">{(pre as { reason: string }).reason}</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-busy={submitting}
            aria-disabled={!canSubmit}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Signing…
              </>
            ) : allDone && totals.total > 0 ? (
              <>
                <Unlock className="h-4 w-4" aria-hidden="true" />
                Unlock more
              </>
            ) : (
              <>
                <Unlock className="h-4 w-4" aria-hidden="true" />
                Confirm all
              </>
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
