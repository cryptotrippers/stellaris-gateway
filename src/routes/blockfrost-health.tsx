import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { Activity, RefreshCw, CheckCircle2, AlertCircle, XCircle, HelpCircle } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { getBlockfrostHealth, getPreprodTip, type BlockfrostHealthStatus } from "@/lib/blockfrost.functions";

const healthQuery = queryOptions({
  queryKey: ["preprod", "blockfrost-health"],
  queryFn: () => getBlockfrostHealth(),
  refetchInterval: 30_000,
  staleTime: 15_000,
  retry: 0,
});

const tipQuery = queryOptions({
  queryKey: ["preprod", "tip"],
  queryFn: () => getPreprodTip(),
  refetchInterval: 30_000,
  staleTime: 15_000,
  retry: 0,
});

export const Route = createFileRoute("/blockfrost-health")({
  head: () => ({
    meta: [
      { title: "Blockfrost Health · Stellaris" },
      { name: "description", content: "Live status of the Blockfrost Preprod connection powering the RealFi testnet flow." },
      { property: "og:title", content: "Blockfrost Health · Stellaris" },
      { property: "og:description", content: "Current status, last check time, and failure details for the Cardano Preprod / Blockfrost integration." },
    ],
  }),
  loader: ({ context }) => Promise.all([
    context.queryClient.ensureQueryData(healthQuery).catch(() => null),
    context.queryClient.ensureQueryData(tipQuery).catch(() => null),
  ]),
  component: BlockfrostHealthPage,
});

const STATUS_META: Record<BlockfrostHealthStatus, { label: string; tone: "success" | "destructive" | "warning" | "muted"; title: string; hint: string; Icon: typeof CheckCircle2 }> = {
  ok:            { label: "Operational",  tone: "success",     title: "Blockfrost Preprod is operational",     hint: "The project ID is valid and /network responded successfully.", Icon: CheckCircle2 },
  missing:       { label: "Not configured", tone: "destructive", title: "BLOCKFROST_PREPROD_PROJECT_ID is not set", hint: "Add a Preprod project ID from blockfrost.io as a server secret.", Icon: XCircle },
  wrong_network: { label: "Wrong network", tone: "destructive", title: "Project ID is for the wrong Cardano network", hint: "Create a Cardano preprod project and update the secret.", Icon: XCircle },
  invalid:       { label: "Invalid key",   tone: "destructive", title: "Blockfrost rejected the project ID",     hint: "Regenerate the key in your Blockfrost dashboard.", Icon: XCircle },
  unreachable:   { label: "Unreachable",   tone: "warning",     title: "Blockfrost is temporarily unreachable",  hint: "Transient network / rate-limit issue. Retry shortly.", Icon: AlertCircle },
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString()} · ${d.toLocaleDateString()}`;
}

function fmtRel(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function BlockfrostHealthPage() {
  const healthQ = useQuery(healthQuery);
  const tipQ = useQuery(tipQuery);
  const health = healthQ.data;
  const meta = health ? STATUS_META[health.status] : null;
  const Icon = meta?.Icon ?? HelpCircle;

  const refreshAll = () => {
    healthQ.refetch();
    tipQ.refetch();
  };

  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Diagnostics</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Blockfrost Health</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live status of the Blockfrost Preprod connection that powers the{" "}
            <Link to="/testnet" className="text-primary hover:underline">RealFi testnet</Link> flow.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && (
            <Badge tone={meta.tone}>
              <Icon className="h-3 w-3" /> {meta.label}
            </Badge>
          )}
          <button
            onClick={refreshAll}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            <RefreshCw className={`h-3 w-3 ${healthQ.isFetching || tipQ.isFetching ? "animate-spin" : ""}`} />
            Recheck
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Status card */}
        <div className="card-institutional p-6">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Current status
          </h2>

          {healthQ.isLoading && !health && (
            <div className="mt-4 text-sm text-muted-foreground">Checking…</div>
          )}

          {healthQ.error && !health && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              Health check failed to run: {(healthQ.error as Error).message}
            </div>
          )}

          {health && meta && (
            <>
              <div
                className={`mt-4 flex items-start gap-3 rounded-lg border p-3 text-sm ${
                  meta.tone === "success"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : meta.tone === "destructive"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold">{meta.title}</div>
                  <div className="mt-0.5 text-xs opacity-90 break-words">{health.detail}</div>
                  <div className="mt-1 text-[11px] opacity-80">{meta.hint}</div>
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Status" value={meta.label} />
                <Stat label="Expected network" value={health.expectedNetwork} />
                <Stat label="Detected network" value={health.detectedNetwork ?? "—"} />
                <Stat label="Last checked" value={fmtRel(health.checkedAt)} />
                <Stat label="Checked at" value={fmtTime(health.checkedAt)} />
                <Stat label="Auto-refresh" value="30s" />
              </dl>
            </>
          )}
        </div>

        {/* Live probe / tip */}
        <div className="card-institutional p-6">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Live probe
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">Result of the most recent <code className="font-mono">/blocks/latest</code> fetch.</p>

          {tipQ.error && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              <div className="font-semibold">Chain tip fetch failed</div>
              <div className="mt-1 break-words">{(tipQ.error as Error).message}</div>
            </div>
          )}

          {tipQ.data && (
            <dl className="mt-4 space-y-3">
              <Stat label="Epoch" value={String(tipQ.data.epoch)} />
              <Stat label="Block height" value={tipQ.data.block.toLocaleString()} />
              <Stat label="Fetched" value={`${fmtRel(tipQ.data.fetchedAt)} · ${new Date(tipQ.data.fetchedAt).toLocaleTimeString()}`} />
            </dl>
          )}

          {!tipQ.data && !tipQ.error && (
            <div className="mt-4 text-sm text-muted-foreground">No tip data yet.</div>
          )}
        </div>
      </div>

      <div className="mt-4 card-institutional p-6">
        <h2 className="text-sm font-semibold text-foreground">Troubleshooting</h2>
        <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
          <li><span className="font-semibold text-foreground">missing</span> — set <code className="font-mono">BLOCKFROST_PREPROD_PROJECT_ID</code> to a Preprod project ID from blockfrost.io.</li>
          <li><span className="font-semibold text-foreground">wrong_network</span> — the key belongs to mainnet or preview. Create a Cardano <em>preprod</em> project and replace the secret.</li>
          <li><span className="font-semibold text-foreground">invalid</span> — key was rejected (403). Regenerate it in the Blockfrost dashboard.</li>
          <li><span className="font-semibold text-foreground">unreachable</span> — transient network or rate-limit issue. Retry, then check <a className="text-primary hover:underline" href="https://status.blockfrost.io" target="_blank" rel="noreferrer">status.blockfrost.io</a>.</li>
        </ul>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span>Endpoint: <code className="font-mono">cardano-preprod.blockfrost.io/api/v0</code></span>
        <Link to="/testnet" className="text-primary hover:underline">Back to testnet →</Link>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground break-words">{value}</div>
    </div>
  );
}
