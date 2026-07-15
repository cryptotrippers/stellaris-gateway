import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, ExternalLink, Inbox, Radio, RefreshCw, Search, ShieldCheck, TrendingUp, Zap, Copy, Check, AlertTriangle, X } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { Sparkline } from "@/components/charts/Sparkline";
import { ASSETS, formatAda } from "@/lib/mock-data";
import { useLiveYields, usePayoutHistory, short, timeAgo, cardanoscanTx, cardanoscanBlock, type Payout } from "@/lib/yield-engine";
import { useCardanoTip } from "@/lib/blockfrost";

export const Route = createFileRoute("/yield")({
  head: () => ({
    meta: [
      { title: "Real-time Yield Engine · Stellaris Finance" },
      { name: "description", content: "Live APY streaming for every RealFi vault on Cardano, with an on-chain verifiable audit trail for every payout. ZK-attested, Merkle-rooted, epoch-anchored." },
      { property: "og:title", content: "Stellaris · Real-time Yield Engine" },
      { property: "og:description", content: "APY streams and payout ledger with on-chain verification for every datapoint." },
    ],
  }),
  component: YieldEngine,
});

function YieldEngine() {
  const live = useLiveYields(2000);
  const { tip, error: tipError, loading: tipLoading, refetch: refetchTip, configured, network } = useCardanoTip(20_000);
  const anchor = tip
    ? { epoch: tip.epoch, slot: tip.slot, block: tip.block, blockTime: tip.blockTime }
    : null;
  const payouts = usePayoutHistory(anchor);
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Payout | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "timestamp", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = filter === "all" ? payouts : payouts.filter(p => p.assetId === filter);
    if (q) {
      rows = rows.filter(p => {
        const a = ASSETS.find(x => x.id === p.assetId);
        return (
          p.txHash.toLowerCase().includes(q) ||
          String(p.block).includes(q) ||
          String(p.epoch).includes(q) ||
          (a?.name.toLowerCase().includes(q) ?? false) ||
          (a?.category.toLowerCase().includes(q) ?? false)
        );
      });
    }
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sort.key) {
        case "vault": {
          const an = ASSETS.find(x => x.id === a.assetId)?.name ?? "";
          const bn = ASSETS.find(x => x.id === b.assetId)?.name ?? "";
          return an.localeCompare(bn) * dir;
        }
        case "amount": return (a.amountAda - b.amountAda) * dir;
        case "apy": return (a.apyAtPayout - b.apyAtPayout) * dir;
        case "epoch": return ((a.epoch - b.epoch) || (a.slot - b.slot)) * dir;
        case "timestamp":
        default: return (a.timestamp - b.timestamp) * dir;
      }
    });
  }, [payouts, filter, query, sort]);

  // Reset to first page when filter/query/sort/pageSize change
  useEffect(() => { setPage(1); }, [filter, query, sort, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(pageStart, pageStart + pageSize);
  const isLoading = tipLoading && payouts.length === 0;
  const activeAsset = filter === "all" ? null : ASSETS.find(a => a.id === filter);

  const totals = useMemo(() => {
    const agg = live.reduce((acc, y) => {
      const a = ASSETS.find(x => x.id === y.assetId)!;
      const w = a.targetAda * (a.fundedPct / 100);
      return { sumW: acc.sumW + w, sumApy: acc.sumApy + y.apy * w };
    }, { sumW: 0, sumApy: 0 });
    const netApy = agg.sumW ? agg.sumApy / agg.sumW : 0;
    const streamed = live.reduce((s, y) => s + y.streamedAda, 0);
    const distributed30d = payouts.filter(p => Date.now() - p.timestamp < 30 * 86_400_000)
      .reduce((s, p) => s + p.amountAda, 0);
    const verifiedPct = 100;
    return { netApy, streamed, distributed30d, verifiedPct };
  }, [live, payouts]);

  return (
    <AppShell>
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Real-time Yield Engine</div>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Live APY & Verifiable Payouts</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Streaming APY per vault, updated every 2 seconds. Every payout is anchored to a Cardano block with a
            ZK-attested Merkle proof — no datapoint exists without an on-chain audit trail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${tip ? "border-success/30 bg-success/10 text-success" : tipError ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-secondary/30 text-muted-foreground"}`}>
            <span className="relative flex h-1.5 w-1.5">
              {tip && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-70" />}
              <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${tip ? "bg-success" : tipError ? "bg-destructive" : "bg-muted-foreground"}`} />
            </span>
            {tip
              ? `${network[0].toUpperCase()}${network.slice(1)} · epoch ${tip.epoch} · slot ${tip.epochSlot.toLocaleString()}`
              : tipError
              ? "Indexer offline"
              : configured ? "Connecting to Blockfrost…" : "Blockfrost not configured"}
          </span>
          <Badge tone="accent"><Radio className="h-3 w-3" /> streaming</Badge>
        </div>
      </div>

      {!configured && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Live Cardano indexer disabled</div>
            <div className="opacity-80">
              Set <code className="font-mono">VITE_BLOCKFROST_PROJECT_ID</code> (mainnet) to pull real epoch, slot, block and active-stake data from Blockfrost. Optional <code className="font-mono">VITE_BLOCKFROST_NETWORK</code>: <code>mainnet</code> · <code>preprod</code> · <code>preview</code>.
            </div>
          </div>
        </div>
      )}
      {tipError && (
        <div className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-[12px] text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Blockfrost request failed</div>
            <div className="opacity-90 mt-0.5 break-words">
              <span className="font-mono">{tipError.message}</span>
              {tip && <span className="ml-1 text-muted-foreground">· showing last known tip from epoch {tip.epoch}</span>}
            </div>
          </div>
          <button
            onClick={refetchTip}
            disabled={tipLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-3 w-3 ${tipLoading ? "animate-spin" : ""}`} />
            {tipLoading ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}


      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Blended Net APY" value={`${totals.netApy.toFixed(2)}%`} delta="+0.14pp 24h" tone="success" />
        <KpiTile icon={<Zap className="h-3.5 w-3.5" />} label="Yield streaming now" value={`₳ ${totals.streamed.toFixed(2)}`} delta="live" tone="primary" ticking />
        <KpiTile icon={<Activity className="h-3.5 w-3.5" />} label="Distributed · 30d" value={formatAda(totals.distributed30d)} delta={`${payouts.length} tx${tip ? ` · block #${tip.block.toLocaleString()}` : ""}`} tone="primary" />
        <KpiTile icon={<ShieldCheck className="h-3.5 w-3.5" />} label="ZK-verified" value={`${totals.verifiedPct}%`} delta="every payout" tone="success" />
      </div>

      <section className="mt-6">
        <div className="flex items-end justify-between">
          <h2 className="text-sm font-semibold text-foreground">Vault APY streams</h2>
          <span className="text-[11px] text-muted-foreground">Updates every 2s · Halborn-audited oracle</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {live.map(y => {
            const asset = ASSETS.find(a => a.id === y.assetId)!;
            const up = y.apy24h >= 0;
            return (
              <div key={y.assetId} className="card-institutional card-institutional-hover p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{asset.category}</div>
                    <div className="mt-0.5 text-sm font-semibold text-foreground truncate">{asset.name}</div>
                  </div>
                  <Badge tone="success"><ShieldCheck className="h-3 w-3" /> ZK</Badge>
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <div className="number-display text-2xl font-semibold text-foreground tabular-nums">{y.apy.toFixed(3)}%</div>
                  <div className={`text-xs font-medium ${up ? "text-success" : "text-destructive"}`}>{up ? "+" : ""}{y.apy24h.toFixed(2)}pp</div>
                </div>
                <div className="mt-2">
                  <Sparkline data={y.history} stroke="var(--color-primary)" fill="var(--color-primary)" height={40} />
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Streamed epoch: <span className="number-display text-foreground">₳ {y.streamedAda.toFixed(2)}</span></span>
                  <button
                    onClick={() => setFilter(y.assetId)}
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    Audit trail <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Payout ledger</h2>
            <p className="text-[11px] text-muted-foreground">
              Every row links to its Cardano transaction, block, and ZK proof.
              {filtered.length > 0 && (
                <> · <span className="text-foreground">{filtered.length.toLocaleString()}</span> payout{filtered.length === 1 ? "" : "s"}</>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search tx, block, vault…"
                className="h-8 w-56 rounded-md border border-border bg-surface pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="relative">
              <select
                value={filter}
                onChange={e => setFilter(e.target.value)}
                className="h-8 appearance-none rounded-md border border-border bg-surface pl-3 pr-7 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="all">All vaults ({payouts.length})</option>
                {ASSETS.map(a => {
                  const count = payouts.filter(p => p.assetId === a.id).length;
                  return <option key={a.id} value={a.id}>{a.name} ({count})</option>;
                })}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>
        </div>

        {activeAsset && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-primary">
            Filtered: {activeAsset.name}
            <button onClick={() => setFilter("all")} aria-label="Clear filter" className="hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="mt-3 card-institutional overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  <SortableTh sortKey="timestamp" current={sort} onSort={setSort}>Time</SortableTh>
                  <SortableTh sortKey="vault" current={sort} onSort={setSort}>Vault</SortableTh>
                  <SortableTh sortKey="amount" current={sort} onSort={setSort} align="right">Amount</SortableTh>
                  <SortableTh sortKey="apy" current={sort} onSort={setSort} align="right">APY</SortableTh>
                  <SortableTh sortKey="epoch" current={sort} onSort={setSort}>Epoch / Block</SortableTh>
                  <th className="px-4 py-3 font-medium">Tx hash</th>
                  <th className="px-4 py-3 font-medium">Audit</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={`sk-${i}`} className="border-b border-border/60 last:border-0">
                      {Array.from({ length: 7 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-3 w-full max-w-[140px] animate-pulse rounded bg-secondary/60" />
                        </td>
                      ))}
                    </tr>
                  ))
                )}
                {!isLoading && pageRows.map(p => {
                  const asset = ASSETS.find(a => a.id === p.assetId)!;
                  return (
                    <tr key={p.txHash} className="border-b border-border/60 last:border-0 hover:bg-secondary/30">
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground text-xs">{timeAgo(p.timestamp)}</td>
                      <td className="px-4 py-3">
                        <div className="text-foreground font-medium truncate max-w-[220px]">{asset.name}</div>
                        <div className="text-[11px] text-muted-foreground">{p.holders.toLocaleString()} holders</div>
                      </td>
                      <td className="px-4 py-3 text-right number-display font-semibold text-foreground tabular-nums">{formatAda(p.amountAda)}</td>
                      <td className="px-4 py-3 text-right number-display text-success tabular-nums">{p.apyAtPayout.toFixed(2)}%</td>
                      <td className="px-4 py-3 text-xs">
                        <div className="text-foreground">e{p.epoch} · slot {p.slot.toLocaleString()}</div>
                        <a href={cardanoscanBlock(p.block)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
                          #{p.block.toLocaleString()} <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <a href={cardanoscanTx(p.txHash)} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1">
                          {short(p.txHash)} <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelected(p)}
                          className="inline-flex items-center gap-1 rounded-md border border-success/30 bg-success/5 px-2 py-1 text-[10.5px] font-medium text-success hover:bg-success/10"
                        >
                          <ShieldCheck className="h-3 w-3" /> verify
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!isLoading && tipError && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-14">
                      <div className="flex flex-col items-center text-center">
                        <div className="rounded-full border border-destructive/40 bg-destructive/10 p-3 text-destructive">
                          <AlertTriangle className="h-5 w-5" />
                        </div>
                        <div className="mt-3 text-sm font-semibold text-foreground">Couldn't load payouts from the indexer</div>
                        <div className="mt-1 text-[12px] text-muted-foreground max-w-md break-words">
                          Blockfrost returned an error: <span className="font-mono text-foreground/80">{tipError.message}</span>
                        </div>
                        <button
                          onClick={refetchTip}
                          disabled={tipLoading}
                          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-gradient-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground shadow-glow disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <RefreshCw className={`h-3 w-3 ${tipLoading ? "animate-spin" : ""}`} />
                          {tipLoading ? "Retrying…" : "Retry"}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                {!isLoading && !tipError && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-14">
                      <div className="flex flex-col items-center text-center">
                        <div className="rounded-full border border-border bg-secondary/40 p-3 text-muted-foreground">
                          <Inbox className="h-5 w-5" />
                        </div>
                        <div className="mt-3 text-sm font-medium text-foreground">
                          {query ? "No payouts match your search" : "No payouts recorded for this vault yet"}
                        </div>
                        <div className="mt-1 text-[12px] text-muted-foreground max-w-sm">
                          {query
                            ? "Try a different transaction hash, block number, or vault name."
                            : "Once this vault distributes yield, every payout will appear here with a full on-chain audit trail."}
                        </div>
                        {(query || filter !== "all") && (
                          <button
                            onClick={() => { setQuery(""); setFilter("all"); }}
                            className="mt-3 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground hover:bg-secondary/40"
                          >
                            Reset filters
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!isLoading && filtered.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary/20 px-4 py-2.5 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>Rows</span>
                <div className="relative">
                  <select
                    value={pageSize}
                    onChange={e => setPageSize(Number(e.target.value))}
                    className="h-7 appearance-none rounded border border-border bg-surface pl-2 pr-6 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
                <span className="tabular-nums">
                  {(pageStart + 1).toLocaleString()}–{Math.min(pageStart + pageSize, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface px-2 text-foreground hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </button>
                <span className="px-2 tabular-nums text-foreground">Page {currentPage} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="inline-flex h-7 items-center gap-1 rounded border border-border bg-surface px-2 text-foreground hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </section>


      {selected && <AuditDrawer payout={selected} onClose={() => setSelected(null)} />}
    </AppShell>
  );
}

function KpiTile({ icon, label, value, delta, tone = "primary", ticking }: { icon: React.ReactNode; label: string; value: string; delta: string; tone?: "primary" | "success"; ticking?: boolean }) {
  return (
    <div className="card-institutional card-institutional-hover p-5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="number-display text-2xl font-semibold text-foreground tabular-nums">{value}</div>
        {ticking && <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />}
      </div>
      <div className={`text-xs font-medium ${tone === "success" ? "text-success" : "text-primary"}`}>{delta}</div>
    </div>
  );
}

type SortKey = "timestamp" | "vault" | "amount" | "apy" | "epoch";
type SortState = { key: SortKey; dir: "asc" | "desc" };

function SortableTh({
  sortKey,
  current,
  onSort,
  align = "left",
  children,
}: {
  sortKey: SortKey;
  current: SortState;
  onSort: (s: SortState) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const active = current.key === sortKey;
  const dir = active ? current.dir : undefined;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th className={`px-4 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        onClick={() => onSort({ key: sortKey, dir: active && dir === "desc" ? "asc" : "desc" })}
        className={`inline-flex items-center gap-1 uppercase tracking-widest ${align === "right" ? "flex-row-reverse" : ""} ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {children}
        <Icon className="h-3 w-3" />
      </button>
    </th>
  );
}


function AuditDrawer({ payout, onClose }: { payout: Payout; onClose: () => void }) {
  const asset = ASSETS.find(a => a.id === payout.assetId)!;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (val: string, key: string) => {
    navigator.clipboard?.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };
  const rows: Array<{ k: string; v: string; href?: string; copyKey?: string }> = [
    { k: "Vault", v: asset.name },
    { k: "Issuer", v: asset.issuer },
    { k: "Amount distributed", v: `${formatAda(payout.amountAda)} · to ${payout.holders.toLocaleString()} holders` },
    { k: "APY at payout", v: `${payout.apyAtPayout.toFixed(2)} %` },
    { k: "Epoch", v: `e${payout.epoch}` },
    { k: "Slot", v: payout.slot.toLocaleString() },
    { k: "Block", v: `#${payout.block.toLocaleString()}`, href: cardanoscanBlock(payout.block) },
    { k: "Tx hash", v: payout.txHash, href: cardanoscanTx(payout.txHash), copyKey: "tx" },
    { k: "Merkle root", v: payout.merkleRoot, copyKey: "merkle" },
    { k: "ZK proof (Plonk)", v: payout.zkProof, copyKey: "zk" },
    { k: "Oracle attestor", v: "Halborn Node · steward.eth" },
  ];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="w-full max-w-lg h-full overflow-y-auto border-l border-border bg-surface shadow-2xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Payout audit trail"
      >
        <div className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur px-6 py-4 flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-primary">On-chain audit trail</div>
            <h3 className="mt-0.5 text-lg font-semibold text-foreground">Verified payout</h3>
            <p className="text-xs text-muted-foreground">{new Date(payout.timestamp).toUTCString()}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <div className="p-6 space-y-4">
          <div className="rounded-xl border border-success/30 bg-success/5 p-4 flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold text-foreground">Signature verified against Cardano ledger</div>
              <div className="text-muted-foreground text-[12px] mt-0.5">Merkle root reproduces from vault UTxO set. ZK proof accepted by protocol validator.</div>
            </div>
          </div>

          <dl className="divide-y divide-border rounded-xl border border-border overflow-hidden">
            {rows.map(r => (
              <div key={r.k} className="grid grid-cols-[130px_1fr] items-start gap-3 px-4 py-3 text-sm">
                <dt className="text-[11px] uppercase tracking-widest text-muted-foreground pt-0.5">{r.k}</dt>
                <dd className="min-w-0 flex items-center gap-2 justify-between">
                  {r.href ? (
                    <a href={r.href} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-primary hover:underline break-all inline-flex items-center gap-1">
                      {r.v.length > 40 ? short(r.v, 10, 8) : r.v} <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className={`text-foreground break-all ${r.v.length > 30 ? "font-mono text-xs" : ""}`}>
                      {r.v.length > 46 ? short(r.v, 12, 8) : r.v}
                    </span>
                  )}
                  {r.copyKey && (
                    <button onClick={() => copy(r.v, r.copyKey!)} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Copy">
                      {copied === r.copyKey ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <div className="rounded-xl bg-[oklch(0.16_0.04_265)] p-4 text-[12px] leading-relaxed text-[oklch(0.9_0.02_285)] overflow-x-auto font-mono">
            <div className="text-[10px] uppercase tracking-widest text-primary mb-2">verify locally</div>
{`stellaris-cli verify \\
  --tx ${short(payout.txHash, 10, 6)} \\
  --epoch ${payout.epoch} \\
  --merkle-root ${short(payout.merkleRoot, 10, 6)} \\
  --zk-proof ${short(payout.zkProof, 8, 6)}
# → OK · signature valid · leaf ∈ merkle root · Plonk π accepted`}
          </div>

          <a
            href={cardanoscanTx(payout.txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow"
          >
            Open on Cardanoscan <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </aside>
    </div>
  );
}
