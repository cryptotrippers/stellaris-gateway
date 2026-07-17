import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutDashboard, FileText, Vault, Users, Activity, PlusCircle, ChevronRight, Search, Radio, TrendingUp, TrendingDown, Shield, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { Sparkline } from "@/components/charts/Sparkline";
import { PROPOSALS, VAULT_ACTIVITY, formatAda, sparkline } from "@/lib/mock-data";
import { supabase } from "@/integrations/supabase/client";
import { getProtocolStats } from "@/lib/governance.functions";
import type { Database } from "@/integrations/supabase/types";

type ProposalRow = Database["public"]["Tables"]["governance_proposals"]["Row"];

type GovTab = "overview" | "proposals" | "vaults" | "delegates" | "signals";
const TABS: GovTab[] = ["overview", "proposals", "vaults", "delegates", "signals"];

export const Route = createFileRoute("/governance")({
  validateSearch: (search: Record<string, unknown>): { tab?: GovTab } => {
    const t = search.tab;
    return { tab: typeof t === "string" && (TABS as string[]).includes(t) ? (t as GovTab) : undefined };
  },
  head: () => ({
    meta: [
      { title: "Governance · Stellaris Finance" },
      { name: "description", content: "Institutional governance for the Stellaris RealFi protocol. Vote on SIPs, monitor vaults, delegate voting power, and read on-chain signals." },
      { property: "og:title", content: "Stellaris Governance Console" },
      { property: "og:description", content: "SIPs, vaults, delegates and market signals in one institutional-grade dashboard." },
    ],
  }),
  component: GovernancePage,
});

const TAB_META: Record<GovTab, { label: string; icon: typeof LayoutDashboard; heading: string }> = {
  overview: { label: "Overview", icon: LayoutDashboard, heading: "Protocol Overview" },
  proposals: { label: "Proposals", icon: FileText, heading: "Proposals" },
  vaults: { label: "Vaults", icon: Vault, heading: "Vaults" },
  delegates: { label: "Delegates", icon: Users, heading: "Delegates" },
  signals: { label: "Signals", icon: Activity, heading: "On-chain Signals" },
};

function GovernancePage() {
  const { tab } = Route.useSearch();
  const active: GovTab = tab ?? "overview";

  return (
    <AppShell>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <GovSidebar active={active} />
        <div>
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Governance Console</div>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">{TAB_META[active].heading}</h1>
            </div>
            <Link to="/governance/new" className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">
              <PlusCircle className="h-4 w-4" /> New Proposal
            </Link>
          </div>

          <div className="mt-6">
            {active === "overview" && <OverviewTab />}
            {active === "proposals" && <ProposalsTab />}
            {active === "vaults" && <VaultsTab />}
            {active === "delegates" && <DelegatesTab />}
            {active === "signals" && <SignalsTab />}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function GovSidebar({ active }: { active: GovTab }) {
  return (
    <aside className="card-institutional p-3 h-fit lg:sticky lg:top-24">
      <div className="px-2 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Governance</div>
      <ul className="space-y-0.5">
        {TABS.map(t => {
          const Icon = TAB_META[t].icon;
          const isActive = active === t;
          return (
            <li key={t}>
              <Link
                to="/governance"
                search={{ tab: t }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
              >
                <Icon className="h-4 w-4" /> {TAB_META[t].label}
                {isActive && <ChevronRight className="ml-auto h-3.5 w-3.5" />}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/15 p-3">
        <div className="text-[10px] uppercase tracking-widest text-primary">Voting Power</div>
        <div className="number-display mt-1 text-lg font-semibold text-foreground">128,400 sSTL</div>
        <div className="mt-1 text-[11px] text-muted-foreground">Delegated to steward.eth</div>
      </div>
    </aside>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab() {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KPI label="Total Value Locked" value="₳ 128.4M" delta="+4.2%" spark={sparkline(1, 24)} />
        <KPI label="Active Proposals" value="7" delta="+2" spark={sparkline(7, 24)} />
        <KPI label="Vault Health" value="98.6%" delta="Nominal" spark={sparkline(4, 24)} tone="success" />
        <KPI label="Treasury Runway" value="42 mo" delta="Stable" spark={sparkline(11, 24)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent Proposals</h2>
            <Link to="/governance" search={{ tab: "proposals" }} className="text-xs text-primary">View all</Link>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                  <th className="pb-2 font-medium">SIP</th>
                  <th className="pb-2 font-medium">Title</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">For</th>
                  <th className="pb-2 font-medium">Ends</th>
                </tr>
              </thead>
              <tbody>
                {PROPOSALS.map(p => (
                  <tr key={p.id} className="border-t border-border/70 hover:bg-secondary/40 cursor-pointer">
                    <td className="py-3 pr-2 font-mono text-xs text-muted-foreground">{p.id}</td>
                    <td className="py-3 pr-2 font-medium text-foreground">{p.title}</td>
                    <td className="py-3 pr-2"><ProposalStatus status={p.status} /></td>
                    <td className="py-3 pr-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <div className="h-1.5 w-16 rounded-full bg-secondary">
                          <div className="h-full rounded-full bg-success" style={{ width: `${p.forPct}%` }} />
                        </div>
                        <span className="number-display text-xs text-foreground">{p.forPct}%</span>
                      </div>
                    </td>
                    <td className="py-3 text-xs text-muted-foreground">{p.endsIn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2"><Activity className="h-4 w-4 text-accent" /> Vault Activity</h2>
            <Badge tone="accent">Live</Badge>
          </div>
          <ul className="mt-3 space-y-1">
            {VAULT_ACTIVITY.map(v => (
              <li key={v.id} className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:border-border hover:bg-secondary/30">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary text-[10px] font-semibold">{v.kind[0]}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground truncate">{v.kind} · {v.asset}</div>
                  <div className="text-[11px] text-muted-foreground truncate">{v.who} · {v.time}</div>
                </div>
                <div className="number-display text-sm font-semibold text-foreground shrink-0">{v.amount}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <TreasuryCard title="Reserve Vault" amount={formatAda(48_200_000)} pct={62} />
        <TreasuryCard title="Insurance Fund" amount={formatAda(18_400_000)} pct={24} />
        <TreasuryCard title="Ecosystem Grants" amount={formatAda(9_800_000)} pct={13} />
      </div>
    </>
  );
}

/* ---------------- Proposals ---------------- */

const STATUS_FILTERS = ["All", "Voting", "Queued", "Executed", "Defeated"] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function ProposalsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("All");

  const filtered = useMemo(() => {
    return PROPOSALS.filter(p =>
      (status === "All" || p.status === status) &&
      (q === "" || p.title.toLowerCase().includes(q.toLowerCase()) || p.id.toLowerCase().includes(q.toLowerCase()))
    );
  }, [q, status]);

  return (
    <>
      <div className="card-institutional p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search SIP or title…"
            className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${status === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        {filtered.map(p => {
          const against = p.againstPct;
          const quorumMet = p.forPct + against >= p.quorumPct;
          return (
            <div key={p.id} className="card-institutional card-institutional-hover p-5">
              <div className="flex flex-wrap items-start gap-3 justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-mono">{p.id}</span>
                    <span>·</span>
                    <span>{p.category}</span>
                    <span>·</span>
                    <span>by {p.author}</span>
                  </div>
                  <h3 className="mt-1 text-base font-semibold text-foreground">{p.title}</h3>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ProposalStatus status={p.status} />
                  {p.endsIn !== "—" && <span className="text-xs text-muted-foreground">Ends in {p.endsIn}</span>}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <VoteBar label="For" pct={p.forPct} tone="success" />
                <VoteBar label="Against" pct={against} tone="destructive" />
                <div className="rounded-lg border border-border p-3">
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Quorum</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="number-display text-lg font-semibold text-foreground">{p.quorumPct}%</span>
                    <span className={`text-[11px] font-medium ${quorumMet ? "text-success" : "text-warning"}`}>
                      {quorumMet ? "Met" : "Pending"}
                    </span>
                  </div>
                </div>
              </div>

              {p.status === "Voting" && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <button className="rounded-lg bg-success/15 text-success px-3 py-1.5 text-xs font-semibold hover:bg-success/25 transition-colors">Vote For</button>
                  <button className="rounded-lg bg-destructive/15 text-destructive px-3 py-1.5 text-xs font-semibold hover:bg-destructive/25 transition-colors">Vote Against</button>
                  <button className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors">Abstain</button>
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">
            No proposals match your filters.
          </div>
        )}
      </div>
    </>
  );
}

function VoteBar({ label, pct, tone }: { label: string; pct: number; tone: "success" | "destructive" }) {
  const bar = tone === "success" ? "bg-success" : "bg-destructive";
  const text = tone === "success" ? "text-success" : "text-destructive";
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className={`number-display text-sm font-semibold ${text}`}>{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------- Vaults ---------------- */

interface VaultRow {
  id: string;
  name: string;
  category: string;
  tvl: number;
  utilization: number;
  apy: number;
  health: number;
  status: "Nominal" | "Watch" | "Paused";
}

const VAULTS: VaultRow[] = [
  { id: "V-01", name: "Andean Coffee Yield", category: "Agri", tvl: 24_800_000, utilization: 78, apy: 9.4, health: 99, status: "Nominal" },
  { id: "V-02", name: "Nordic Wind III", category: "Energy", tvl: 41_200_000, utilization: 86, apy: 7.8, health: 97, status: "Nominal" },
  { id: "V-03", name: "Iberian Solar Notes", category: "Energy", tvl: 12_600_000, utilization: 64, apy: 8.2, health: 92, status: "Watch" },
  { id: "V-04", name: "Kenyan Carbon Basket", category: "Carbon", tvl: 6_900_000, utilization: 41, apy: 11.6, health: 88, status: "Watch" },
  { id: "V-05", name: "Reserve Vault (Treasury)", category: "Reserve", tvl: 48_200_000, utilization: 12, apy: 4.1, health: 100, status: "Nominal" },
  { id: "V-06", name: "Legacy Iberian H2", category: "Energy", tvl: 1_200_000, utilization: 0, apy: 0, health: 0, status: "Paused" },
];

function VaultsTab() {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <KPI label="Vaults Live" value={String(VAULTS.filter(v => v.status !== "Paused").length)} delta="+1 this month" spark={sparkline(3, 24)} />
        <KPI label="Aggregate TVL" value={formatAda(VAULTS.reduce((a, v) => a + v.tvl, 0))} delta="+4.2%" spark={sparkline(5, 24)} />
        <KPI label="Avg. Health" value="96.1%" delta="Nominal" spark={sparkline(2, 24)} tone="success" />
      </div>

      <div className="mt-6 card-institutional p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">All Vaults</h2>
          <Badge tone="accent">Live</Badge>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="pb-2 font-medium">Vault</th>
                <th className="pb-2 font-medium">Category</th>
                <th className="pb-2 font-medium text-right">TVL</th>
                <th className="pb-2 font-medium text-right">Utilization</th>
                <th className="pb-2 font-medium text-right">APY</th>
                <th className="pb-2 font-medium text-right">Health</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {VAULTS.map(v => (
                <tr key={v.id} className="border-t border-border/70 hover:bg-secondary/40">
                  <td className="py-3 pr-2">
                    <div className="font-medium text-foreground">{v.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{v.id}</div>
                  </td>
                  <td className="py-3 pr-2 text-muted-foreground">{v.category}</td>
                  <td className="py-3 pr-2 text-right number-display text-foreground">{formatAda(v.tvl)}</td>
                  <td className="py-3 pr-2 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <div className="h-1.5 w-16 rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${v.utilization}%` }} />
                      </div>
                      <span className="number-display text-xs text-foreground">{v.utilization}%</span>
                    </div>
                  </td>
                  <td className="py-3 pr-2 text-right number-display text-success">{v.apy.toFixed(1)}%</td>
                  <td className="py-3 pr-2 text-right number-display text-foreground">{v.health}%</td>
                  <td className="py-3">
                    <Badge tone={v.status === "Nominal" ? "success" : v.status === "Watch" ? "accent" : "destructive"}>{v.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ---------------- Delegates ---------------- */

interface Delegate {
  handle: string;
  ens: string;
  power: number;    // sSTL
  delegators: number;
  participation: number; // %
  aligned: number;       // % votes aligned with executed outcomes
  focus: string;
}

const DELEGATES: Delegate[] = [
  { handle: "steward.eth", ens: "steward.eth", power: 4_820_000, delegators: 312, participation: 98, aligned: 94, focus: "Risk & treasury" },
  { handle: "risk.core", ens: "risk.core.stl", power: 3_140_000, delegators: 187, participation: 99, aligned: 91, focus: "Risk parameters" },
  { handle: "treasury.dao", ens: "treasury.dao", power: 2_610_000, delegators: 254, participation: 96, aligned: 89, focus: "Treasury allocation" },
  { handle: "core.dev", ens: "core.dev.stl", power: 1_920_000, delegators: 141, participation: 100, aligned: 92, focus: "Protocol upgrades" },
  { handle: "impact.lab", ens: "impact.lab", power: 1_180_000, delegators: 208, participation: 93, aligned: 86, focus: "Sustainability" },
  { handle: "member.7723", ens: "member.7723", power: 640_000, delegators: 42, participation: 74, aligned: 67, focus: "Independent" },
];

function DelegatesTab() {
  const [delegatedTo, setDelegatedTo] = useState<string>("steward.eth");
  const totalPower = DELEGATES.reduce((a, d) => a + d.power, 0);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <KPI label="Your Voting Power" value="128,400 sSTL" delta="Delegated" spark={sparkline(6, 24)} />
        <KPI label="Delegates Tracked" value={String(DELEGATES.length)} delta="Top 6 by power" spark={sparkline(8, 24)} />
        <KPI label="Aggregate Delegation" value={formatAda(totalPower)} delta="On protocol" spark={sparkline(9, 24)} />
      </div>

      <div className="mt-6 grid gap-3">
        {DELEGATES.map(d => {
          const isYours = delegatedTo === d.handle;
          return (
            <div key={d.handle} className={`card-institutional card-institutional-hover p-5 ${isYours ? "ring-1 ring-primary/40" : ""}`}>
              <div className="flex flex-wrap items-center gap-4">
                <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-primary text-primary-foreground text-sm font-semibold shrink-0">
                  {d.handle.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{d.handle}</span>
                    {isYours && <Badge tone="primary">Your delegate</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">{d.focus} · {d.delegators} delegators</div>
                </div>
                <div className="flex flex-wrap items-center gap-5 text-right">
                  <Stat label="Voting Power" value={formatAda(d.power)} />
                  <Stat label="Participation" value={`${d.participation}%`} tone={d.participation >= 90 ? "success" : "muted"} />
                  <Stat label="Aligned" value={`${d.aligned}%`} tone={d.aligned >= 85 ? "success" : "muted"} />
                  <button
                    onClick={() => setDelegatedTo(d.handle)}
                    disabled={isYours}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${isYours ? "bg-secondary text-muted-foreground cursor-default" : "bg-primary text-primary-foreground hover:opacity-90"}`}
                  >
                    {isYours ? "Delegated" : "Delegate"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Stat({ label, value, tone = "muted" }: { label: string; value: string; tone?: "muted" | "success" }) {
  return (
    <div className="min-w-[92px]">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display text-sm font-semibold ${tone === "success" ? "text-success" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

/* ---------------- Signals ---------------- */

interface Signal {
  id: string;
  title: string;
  kind: "Risk" | "Market" | "Protocol" | "Impact";
  severity: "info" | "watch" | "alert";
  detail: string;
  time: string;
  trend: "up" | "down";
  metric: string;
}

const SIGNALS: Signal[] = [
  { id: "S-114", title: "Coffee futures spike 3.4%", kind: "Market", severity: "watch", detail: "Andean Coffee Vault collateral value revalued +2.1M ADA.", time: "12m ago", trend: "up", metric: "+3.4%" },
  { id: "S-113", title: "Iberian Solar utilization dropped below 65%", kind: "Risk", severity: "watch", detail: "Utilization decline may trigger APY rebalancing on next epoch boundary.", time: "48m ago", trend: "down", metric: "-4.8%" },
  { id: "S-112", title: "ZK-KYC bridge finalized", kind: "Protocol", severity: "info", detail: "SIP-039 executed. Midnight bridge now serving 1,240 KYC checks.", time: "2h ago", trend: "up", metric: "1.2k" },
  { id: "S-111", title: "Carbon basket verified", kind: "Impact", severity: "info", detail: "Kenyan Carbon Basket third-party audit confirmed 18,240t CO₂ retired.", time: "5h ago", trend: "up", metric: "18.2kt" },
  { id: "S-110", title: "Reserve vault below 12% deployment", kind: "Risk", severity: "alert", detail: "Treasury allocation trailing target. Consider new SIP.", time: "8h ago", trend: "down", metric: "12%" },
];

function SignalsTab() {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3">
        <KPI label="Signals (24h)" value="14" delta="+3 vs. yesterday" spark={sparkline(4, 24)} />
        <KPI label="Open Alerts" value="1" delta="Requires action" spark={sparkline(2, 24)} tone="success" />
        <KPI label="Model Confidence" value="92%" delta="Nominal" spark={sparkline(10, 24)} tone="success" />
      </div>

      <div className="mt-6 grid gap-3">
        {SIGNALS.map(s => {
          const sevTone: "primary" | "accent" | "destructive" =
            s.severity === "info" ? "primary" : s.severity === "watch" ? "accent" : "destructive";
          const TrendIcon = s.trend === "up" ? TrendingUp : TrendingDown;
          const KindIcon = s.kind === "Risk" ? Shield : s.kind === "Market" ? TrendingUp : s.kind === "Protocol" ? Zap : Radio;
          return (
            <div key={s.id} className="card-institutional card-institutional-hover p-5">
              <div className="flex items-start gap-4">
                <div className={`grid h-10 w-10 place-items-center rounded-lg shrink-0 ${s.severity === "alert" ? "bg-destructive/15 text-destructive" : s.severity === "watch" ? "bg-accent/15 text-accent" : "bg-primary/10 text-primary"}`}>
                  <KindIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{s.id}</span>
                    <Badge tone={sevTone}>{s.severity.toUpperCase()}</Badge>
                    <span className="text-[11px] text-muted-foreground">{s.kind}</span>
                    <span className="text-[11px] text-muted-foreground">· {s.time}</span>
                  </div>
                  <h3 className="mt-1 text-sm font-semibold text-foreground">{s.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{s.detail}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className={`inline-flex items-center gap-1 text-sm font-semibold ${s.trend === "up" ? "text-success" : "text-destructive"}`}>
                    <TrendIcon className="h-4 w-4" />
                    <span className="number-display">{s.metric}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ---------------- shared bits ---------------- */

function KPI({ label, value, delta, spark, tone = "primary" }: { label: string; value: string; delta: string; spark: number[]; tone?: "primary" | "success" }) {
  return (
    <div className="card-institutional card-institutional-hover p-5">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="number-display mt-1 text-2xl font-semibold text-foreground">{value}</div>
      <div className={`text-xs font-medium ${tone === "success" ? "text-success" : "text-primary"}`}>{delta}</div>
      <div className="mt-3">
        <Sparkline data={spark} stroke={tone === "success" ? "var(--color-success)" : "var(--color-primary)"} fill={tone === "success" ? "var(--color-success)" : "var(--color-primary)"} height={36} />
      </div>
    </div>
  );
}

function ProposalStatus({ status }: { status: "Voting" | "Executed" | "Defeated" | "Queued" }) {
  const map = { Voting: "accent", Executed: "success", Defeated: "destructive", Queued: "primary" } as const;
  return <Badge tone={map[status]}>{status}</Badge>;
}

function TreasuryCard({ title, amount, pct }: { title: string; amount: string; pct: number }) {
  return (
    <div className="card-institutional p-5">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="number-display mt-2 text-2xl font-semibold text-foreground">{amount}</div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Allocation</span>
        <span>{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full bg-gradient-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
