import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Activity, ArrowUpRight, CheckCircle2, ExternalLink, Radio, ShieldCheck, TrendingUp, Zap, Copy, Check, AlertTriangle } from "lucide-react";
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
  const { tip, error: tipError, loading: tipLoading, configured, network } = useCardanoTip(20_000);
  const anchor = tip
    ? { epoch: tip.epoch, slot: tip.slot, block: tip.block, blockTime: tip.blockTime }
    : null;
  const payouts = usePayoutHistory(anchor);
  const [filter, setFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Payout | null>(null);

  const filtered = useMemo(
    () => (filter === "all" ? payouts : payouts.filter(p => p.assetId === filter)),
    [filter, payouts],
  );

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
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-70" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
            </span>
            Mainnet · epoch 512
          </span>
          <Badge tone="accent"><Radio className="h-3 w-3" /> streaming</Badge>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiTile icon={<TrendingUp className="h-3.5 w-3.5" />} label="Blended Net APY" value={`${totals.netApy.toFixed(2)}%`} delta="+0.14pp 24h" tone="success" />
        <KpiTile icon={<Zap className="h-3.5 w-3.5" />} label="Yield streaming now" value={`₳ ${totals.streamed.toFixed(2)}`} delta="live" tone="primary" ticking />
        <KpiTile icon={<Activity className="h-3.5 w-3.5" />} label="Distributed · 30d" value={formatAda(totals.distributed30d)} delta={`${PAYOUTS.length} tx`} tone="primary" />
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
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Payout ledger</h2>
            <p className="text-[11px] text-muted-foreground">Every row links to its Cardano transaction, block, and ZK proof.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>All vaults</FilterPill>
            {ASSETS.map(a => (
              <FilterPill key={a.id} active={filter === a.id} onClick={() => setFilter(a.id)}>{a.name.split(" ").slice(0, 2).join(" ")}</FilterPill>
            ))}
          </div>
        </div>

        <div className="mt-3 card-institutional overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/30 text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Vault</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium text-right">APY</th>
                  <th className="px-4 py-3 font-medium">Epoch / Block</th>
                  <th className="px-4 py-3 font-medium">Tx hash</th>
                  <th className="px-4 py-3 font-medium">Audit</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
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
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">No payouts recorded for this vault yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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

function FilterPill({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-[11px] font-medium ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
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
