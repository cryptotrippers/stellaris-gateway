import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cardanoscanTx, lovelaceToAda } from "@/lib/chain-format";
import {
  queueDayIndex,
  REDEMPTION_WINDOW_DAYS,
  type RedemptionEntry,
  type RedemptionQueueFeed,
} from "@/lib/redemption-queue.shared";
import { Ban, CheckCircle2, CircleSlash, Clock, Loader2, RefreshCw } from "lucide-react";

const REFRESH_MS = 30_000;

async function fetchQueue(address: string): Promise<RedemptionQueueFeed> {
  const res = await fetch(`/api/v1/yield/user/${address}/queue`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Queue feed responded ${String(res.status)}`);
  return (await res.json()) as RedemptionQueueFeed;
}

/**
 * A wallet's position in the 7-day redemption queue: position, day-by-day
 * timeline, exact availability time with countdown, fee breakdown and
 * cancel action. Entries come from `/api/v1/yield/user/:address/queue`;
 * when the vault operates no queue the feed says so and nothing is invented.
 */
export function RedemptionQueueStatus({ address }: { address: string | null }) {
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["redemption-queue", address],
    queryFn: () => fetchQueue(address!),
    enabled: !!address,
    refetchInterval: REFRESH_MS,
    retry: 1,
  });

  // 1s tick drives the countdown timers.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const [showAll, setShowAll] = useState(false);

  if (!address) {
    return (
      <section className="card-institutional p-4 text-sm text-muted-foreground">
        Connect a wallet to see its redemption queue.
      </section>
    );
  }

  if (isLoading) return <QueueSkeleton />;

  if (error || !data) {
    return (
      <section className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <div className="font-medium">Queue unavailable</div>
        <p className="mt-1 text-destructive/80">
          The redemption queue could not be read right now. Nothing is estimated in its place.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      </section>
    );
  }

  const active = data.entries.filter((e) => e.status === "processing" || e.status === "ready");
  const history = data.entries.filter((e) => e.status === "completed" || e.status === "cancelled");
  const visible = showAll ? data.entries : active;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">sUSDr</div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Redemption queue
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>{isFetching ? "Updating…" : "Live"}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh queue data"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:text-primary"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {data.entries.length === 0 ? (
        <div className="card-institutional p-4">
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
            {data.unavailableReason ?? "This wallet has no queued redemptions."}
          </p>
        </div>
      ) : (
        <>
          {visible.map((entry) => (
            <QueueEntryCard key={entry.id} entry={entry} now={now} onChanged={() => void refetch()} />
          ))}

          {visible.length === 0 && (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              No redemptions are waiting or ready right now.
            </p>
          )}

          {history.length > 0 && (
            <AlertDialog open={showAll} onOpenChange={setShowAll}>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 self-start rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:text-primary"
                >
                  {showAll ? "Show active only" : `View more queued (${String(data.entries.length)} total)`}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {showAll ? "Hide completed and cancelled redemptions?" : "Show all redemptions?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {showAll
                      ? "Only redemptions still waiting or ready to claim will be listed."
                      : `This lists all ${String(data.entries.length)} redemptions for this wallet, including ${String(history.length)} completed or cancelled.`}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Back</AlertDialogCancel>
                  <AlertDialogAction>{showAll ? "Show active only" : "Show all"}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </>
      )}

      <p className="text-[11px] text-muted-foreground">
        Queue state on {data.network}. Withdrawals unlock within a maximum of{" "}
        {data.windowDays} days from request.
      </p>
    </section>
  );
}

const STATUS_META: Record<
  RedemptionEntry["status"],
  { label: string; className: string; Icon: typeof Clock }
> = {
  processing: { label: "Processing", className: "text-warning border-warning/40 bg-warning/10", Icon: Loader2 },
  ready: { label: "Ready to withdraw", className: "text-success border-success/40 bg-success/10", Icon: CheckCircle2 },
  completed: { label: "Completed", className: "text-muted-foreground border-border bg-secondary/30", Icon: CheckCircle2 },
  cancelled: { label: "Cancelled", className: "text-destructive border-destructive/40 bg-destructive/10", Icon: CircleSlash },
};

function QueueEntryCard({
  entry,
  now,
  onChanged,
}: {
  entry: RedemptionEntry;
  now: number;
  onChanged: () => void;
}) {
  const meta = STATUS_META[entry.status];
  const day = queueDayIndex(entry, now);
  const pctOfQueue =
    entry.queuePosition !== null && entry.queueLength !== null && entry.queueLength > 0
      ? (entry.queuePosition / entry.queueLength) * 100
      : null;

  return (
    <div className="card-institutional flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-foreground">
          {entry.status === "processing" && entry.queuePosition !== null ? (
            <>
              You are <span className="font-semibold">#{entry.queuePosition}</span> in queue
              {entry.queueLength !== null && (
                <span className="text-muted-foreground">
                  {" "}
                  · Queue: {entry.queueLength.toLocaleString()} total
                  {pctOfQueue !== null && ` · ${pctOfQueue < 1 ? "<1" : pctOfQueue.toFixed(0)}% of queue`}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Redemption {entry.id}</span>
          )}
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${meta.className}`}
        >
          <meta.Icon className={`h-3 w-3 ${entry.status === "processing" ? "animate-spin" : ""}`} />
          {meta.label}
        </span>
      </div>

      {(entry.status === "processing" || entry.status === "ready") && (
        <Timeline entry={entry} now={now} day={day} />
      )}

      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Stat label="Amount requested" value={`₳${lovelaceToAda(entry.amountLovelace)}`} />
        <Stat
          label="Fee"
          value={
            entry.feeBps !== null && entry.feeLovelace !== null
              ? `${(entry.feeBps / 100).toFixed(2)}% = ₳${lovelaceToAda(entry.feeLovelace)}`
              : "—"
          }
        />
        <Stat
          label="You receive"
          value={entry.netLovelace !== null ? `₳${lovelaceToAda(entry.netLovelace)}` : "—"}
        />
      </div>

      {entry.status === "completed" && entry.txHash && (
        <a
          href={cardanoscanTx(entry.txHash)}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline"
        >
          View settlement transaction ↗
        </a>
      )}

      {entry.status === "processing" && (
        <div>
          <CancelButton entryId={entry.id} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

/** Day 1→7 progress bar with a red → yellow → green gradient. */
function Timeline({ entry, now, day }: { entry: RedemptionEntry; now: number; day: number }) {
  const progress = useMemo(() => {
    if (entry.availableAt === null) return 0;
    const total = entry.availableAt - entry.requestedAt;
    if (total <= 0) return 1;
    return Math.max(0, Math.min(1, (now - entry.requestedAt) / total));
  }, [entry, now]);

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Day {day} of {REDEMPTION_WINDOW_DAYS}
        </span>
        {entry.availableAt !== null && (
          <span>
            {entry.status === "ready" || now >= entry.availableAt
              ? `Available since ${formatDateTime(entry.availableAt)}`
              : `Available ${formatDateTime(entry.availableAt)} · ${countdown(entry.availableAt - now)}`}
          </span>
        )}
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-secondary/50"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={REDEMPTION_WINDOW_DAYS}
        aria-valuenow={day}
        aria-label="Withdrawal unlock progress"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-destructive via-warning to-success transition-[width] duration-1000"
          style={{ width: `${(progress * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        {Array.from({ length: REDEMPTION_WINDOW_DAYS }, (_, i) => (
          <span key={i} className={i + 1 <= day ? "font-medium text-foreground" : ""}>
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

function CancelButton({ entryId, onChanged }: { entryId: string; onChanged: () => void }) {
  const [pending, setPending] = useState(false);

  const cancel = async () => {
    setPending(true);
    try {
      // Cancellation submits an on-chain tx once the queue contract exists;
      // the feed is re-read afterwards either way.
      const res = await fetch(`/api/v1/yield/user/queue/${entryId}/cancel`, { method: "POST" });
      if (!res.ok && res.status !== 404) throw new Error(`Cancel failed (${String(res.status)})`);
      onChanged();
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
        >
          <Ban className="h-3.5 w-3.5" /> Cancel withdrawal
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this withdrawal?</AlertDialogTitle>
          <AlertDialogDescription>
            The request leaves the queue and your shares stay in the vault. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep withdrawal</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void cancel()}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {pending ? "Cancelling…" : "Yes, cancel it"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

/** "Jan 15, 2027 at 2:30 PM UTC" */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  return `${date} at ${time} UTC`;
}

/** "2d 04:12:33" style countdown, always hh:mm:ss with optional days. */
function countdown(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${String(days)}d ${clock}` : clock;
}

function QueueSkeleton() {
  return (
    <section className="flex flex-col gap-4" aria-busy="true" aria-label="Loading redemption queue">
      <div className="flex items-end justify-between gap-2">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="card-institutional flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-2 w-full" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    </section>
  );
}

export default RedemptionQueueStatus;
