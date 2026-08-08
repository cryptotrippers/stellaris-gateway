import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutDashboard, FileText, Vault, Users, Activity, PlusCircle, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { getProtocolStats } from "@/lib/governance.functions";
import { listAssetVaults, type AssetVaultRow } from "@/lib/asset-vaults.functions";
import { formatAda } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

type ProposalRow = Database["public"]["Tables"]["governance_proposals"]["Row"];
type TreasuryConfigRow = Database["public"]["Tables"]["treasury_config"]["Row"];

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
      <div className="mt-4 rounded-xl border border-dashed border-border p-3">
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Voting Power</div>
        <div className="mt-1 text-sm text-muted-foreground">
          Connect a wallet and delegate to view.
        </div>
      </div>
    </aside>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab() {
  const fetchStats = useServerFn(getProtocolStats);
  const [tvl, setTvl] = useState<number | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [treasury, setTreasury] = useState<TreasuryConfigRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [statsRes, propRes, treasuryRes] = await Promise.all([
        fetchStats().catch(() => ({ totalAda: 0, activeVaults: 0 })),
        supabase
          .from("governance_proposals")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(5),
        supabase.from("treasury_config").select("*"),
      ]);
      if (cancelled) return;
      setTvl(statsRes.totalAda);
      setProposals((propRes.data as ProposalRow[]) ?? []);
      setTreasury((treasuryRes.data as TreasuryConfigRow[]) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchStats]);

  const activeCount = proposals.filter(p => p.status === "active").length;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KPI label="Total Value Locked" value={tvl === null ? "—" : formatAda(tvl)} delta={loading ? "Loading…" : "Live"} />
        <KPI label="Active Proposals" value={loading ? "—" : String(activeCount)} delta={loading ? "Loading…" : "Live"} />
        <KPI label="Vault Health" value="—" delta="Indexer not connected" />
        <KPI label="Treasury Runway" value="—" delta="Treasury not configured" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent Proposals</h2>
            <Link to="/governance" search={{ tab: "proposals" }} className="text-xs text-primary">View all</Link>
          </div>
          {loading ? (
            <div className="mt-6 text-center text-sm text-muted-foreground">Loading proposals…</div>
          ) : proposals.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No proposals yet.
            </div>
          ) : (
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
                  {proposals.map(p => (
                    <tr key={p.id} className="border-t border-border/70 hover:bg-secondary/40 cursor-pointer">
                      <td className="py-3 pr-2 font-mono text-xs text-muted-foreground">{p.sip_number}</td>
                      <td className="py-3 pr-2 font-medium text-foreground">{p.title}</td>
                      <td className="py-3 pr-2"><ProposalStatus status={p.status} /></td>
                      <td className="py-3 pr-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <div className="h-1.5 w-16 rounded-full bg-secondary">
                            <div className="h-full rounded-full bg-success" style={{ width: `${p.votes_for_pct}%` }} />
                          </div>
                          <span className="number-display text-xs text-foreground">{Number(p.votes_for_pct).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="py-3 text-xs text-muted-foreground">{p.ends_at ? new Date(p.ends_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-accent" /> Vault Activity
            </h2>
          </div>
          <div className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
            No on-chain activity indexed yet. Connect Blockfrost to stream vault events.
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Treasury Allocation</h2>
          <Link to="/governance" search={{ tab: "vaults" }} className="text-xs text-primary">Manage</Link>
        </div>
        {treasury.length === 0 ? (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">
            No treasury address configured. Once a multisig treasury is set and indexed on-chain, allocations will appear here.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {treasury.map(t => (
              <div key={t.id} className="card-institutional p-5">
                <div className="text-sm font-semibold text-foreground capitalize">{t.network} treasury</div>
                <div className="mt-2 text-xs text-muted-foreground break-all">{t.treasury_address ?? "Address not yet configured"}</div>
                <div className="mt-2 text-[11px] text-muted-foreground">Buyback: {(t.buyback_pct_bps / 100).toFixed(2)}%</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- Proposals ---------------- */

const STATUS_FILTERS = ["All", "active", "passed", "rejected", "executed", "draft"] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function ProposalsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("All");
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("governance_proposals")
        .select("*")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setProposals((data as ProposalRow[]) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    return proposals.filter(p =>
      (status === "All" || p.status === status) &&
      (q === "" ||
        p.title.toLowerCase().includes(q.toLowerCase()) ||
        p.sip_number.toLowerCase().includes(q.toLowerCase()))
    );
  }, [q, status, proposals]);

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
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${status === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        {loading ? (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">Loading proposals…</div>
        ) : filtered.length === 0 ? (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">
            {proposals.length === 0
              ? "No proposals have been submitted yet. Use New Proposal to create the first SIP."
              : "No proposals match your filters."}
          </div>
        ) : (
          filtered.map(p => (
            <div key={p.id} className="card-institutional card-institutional-hover p-5">
              <div className="flex flex-wrap items-start gap-3 justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-mono">{p.sip_number}</span>
                  </div>
                  <h3 className="mt-1 text-base font-semibold text-foreground">{p.title}</h3>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <ProposalStatus status={p.status} />
                  {p.ends_at && (
                    <span className="text-xs text-muted-foreground">
                      Ends {new Date(p.ends_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <VoteBar label="For" pct={Number(p.votes_for_pct ?? 0)} tone="success" />
                <VoteBar label="Against" pct={Math.max(0, 100 - Number(p.votes_for_pct ?? 0))} tone="destructive" />
              </div>
            </div>
          ))
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
        <span className={`number-display text-sm font-semibold ${text}`}>{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------- Vaults ---------------- */

function VaultsTab() {
  return (
    <div className="card-institutional p-10 text-center">
      <Vault className="mx-auto h-8 w-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold text-foreground">No vaults deployed</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
        Vault contracts are pre-audit on testnet. Once vault script hashes are registered and the
        Blockfrost indexer is wired, live TVL, utilisation and health will appear here — sourced directly
        from on-chain UTxOs.
      </p>
      <Link
        to="/blockfrost-health"
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary"
      >
        View indexer status
      </Link>
    </div>
  );
}

/* ---------------- Delegates ---------------- */

function DelegatesTab() {
  return (
    <div className="card-institutional p-10 text-center">
      <Users className="mx-auto h-8 w-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold text-foreground">Delegation not yet enabled</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
        On-chain delegation follows CIP-1694. Once the governance token and DRep registry are
        deployed, tracked delegates and their voting history will be listed here.
      </p>
    </div>
  );
}

/* ---------------- Signals ---------------- */

function SignalsTab() {
  return (
    <div className="card-institutional p-10 text-center">
      <Activity className="mx-auto h-8 w-8 text-muted-foreground" />
      <h2 className="mt-3 text-base font-semibold text-foreground">No signals available</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
        Oracle-driven risk and market signals will appear here once Charli3 / Orcfax feeds are
        registered in the <span className="font-mono text-foreground">oracle_feeds</span> table and
        the indexer is streaming.
      </p>
    </div>
  );
}

/* ---------------- shared bits ---------------- */

function KPI({ label, value, delta, tone = "primary" }: { label: string; value: string; delta: string; tone?: "primary" | "success" }) {
  return (
    <div className="card-institutional card-institutional-hover p-5">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="number-display mt-1 text-2xl font-semibold text-foreground">{value}</div>
      <div className={`text-xs font-medium ${tone === "success" ? "text-success" : "text-primary"}`}>{delta}</div>
    </div>
  );
}

function ProposalStatus({ status }: { status: string }) {
  const map: Record<string, "accent" | "success" | "destructive" | "primary"> = {
    active: "accent",
    executed: "success",
    rejected: "destructive",
    passed: "success",
    draft: "primary",
  };
  const tone = map[status] ?? "primary";
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={tone}>{label}</Badge>;
}
