import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, FileText, Vault, Users, Activity, PlusCircle, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { getProtocolStats } from "@/lib/governance.functions";
import { listAssetVaults, type AssetVaultRow } from "@/lib/asset-vaults.functions";
import { ProposalCard } from "@/components/governance/ProposalCard";
import { VaultGovernanceCard } from "@/components/governance/VaultGovernanceCard";
import { useGovernanceData } from "@/hooks/useGovernanceData";
import { DERIVED_STATUS_LABEL, derivedStatus } from "@/lib/governance-votes.shared";
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
  const gov = useGovernanceData();
  const [tvl, setTvl] = useState<number | null>(null);
  const [treasury, setTreasury] = useState<TreasuryConfigRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [statsRes, treasuryRes] = await Promise.all([
        fetchStats().catch(() => ({ totalAda: 0, activeVaults: 0 })),
        supabase.from("treasury_config").select("*"),
      ]);
      if (cancelled) return;
      setTvl(statsRes.totalAda);
      setTreasury((treasuryRes.data as TreasuryConfigRow[]) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchStats]);

  const recent = gov.proposals.slice(0, 5);
  const openCount = gov.proposals.filter(p => derivedStatus(p) === "voting_open").length;

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KPI label="Total Value Locked" value={tvl === null ? "—" : formatAda(tvl)} delta={loading ? "Loading…" : "Live"} />
        <KPI
          label="Proposals Open for Voting"
          value={gov.proposalsLoading ? "—" : String(openCount)}
          delta={gov.proposalsLoading ? "Loading…" : "Derived from voting windows"}
        />
        <KPI label="Vault Health" value="—" delta="Indexer not connected" />
        <KPI label="Treasury Runway" value="—" delta="Treasury not configured" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="card-institutional p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent Proposals</h2>
            <Link to="/governance" search={{ tab: "proposals" }} className="text-xs text-primary">View all</Link>
          </div>
          {gov.proposalsLoading ? (
            <div className="mt-6 text-center text-sm text-muted-foreground">Loading proposals…</div>
          ) : recent.length === 0 ? (
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
                  {recent.map(p => {
                    const forPct = gov.tallies[p.id]?.forPct ?? null;
                    return (
                      <tr key={p.id} className="border-t border-border/70 hover:bg-secondary/40">
                        <td className="py-3 pr-2 font-mono text-xs text-muted-foreground">{p.sip_number}</td>
                        <td className="py-3 pr-2 font-medium text-foreground">{p.title}</td>
                        <td className="py-3 pr-2"><ProposalStatus status={derivedStatus(p)} /></td>
                        <td className="py-3 pr-2 text-right">
                          {forPct === null ? (
                            <span className="text-xs text-muted-foreground">
                              {gov.talliesLoading ? "…" : "No votes"}
                            </span>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <div className="h-1.5 w-16 rounded-full bg-secondary">
                                <div className="h-full rounded-full bg-success" style={{ width: `${forPct}%` }} />
                              </div>
                              <span className="number-display text-xs text-foreground">{forPct.toFixed(0)}%</span>
                            </div>
                          )}
                        </td>
                        <td className="py-3 text-xs text-muted-foreground">{p.ends_at ? new Date(p.ends_at).toLocaleDateString() : "—"}</td>
                      </tr>
                    );
                  })}
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

const STATUS_FILTERS = ["All", "voting_open", "awaiting_finalisation", "passed", "rejected", "executed", "draft"] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function ProposalsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("All");
  const gov = useGovernanceData();

  const filtered = useMemo(() => {
    return gov.proposals.filter(p =>
      (status === "All" || derivedStatus(p) === status) &&
      (q === "" ||
        p.title.toLowerCase().includes(q.toLowerCase()) ||
        p.sip_number.toLowerCase().includes(q.toLowerCase()) ||
        (p.asset_id ?? "").toLowerCase().includes(q.toLowerCase()))
    );
  }, [q, status, gov.proposals]);

  return (
    <>
      <div className="card-institutional p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search SIP, title or asset…"
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
              {s === "All" ? "All" : DERIVED_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        {gov.proposalsLoading ? (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">Loading proposals…</div>
        ) : gov.proposalsError ? (
          <div className="card-institutional p-6 text-sm text-destructive">
            Could not load proposals: {gov.proposalsError.message}
          </div>
        ) : filtered.length === 0 ? (
          <div className="card-institutional p-10 text-center text-sm text-muted-foreground">
            {gov.proposals.length === 0
              ? "No proposals have been submitted yet. Use New Proposal to create the first SIP."
              : "No proposals match your filters."}
          </div>
        ) : (
          filtered.map(p => (
            <ProposalCard
              key={p.id}
              proposal={p}
              tally={gov.tallies[p.id]}
              talliesLoading={gov.talliesLoading}
              myVote={gov.myVotes[p.id]}
              myWeightAda={gov.weightFor(p.asset_id)}
              signedIn={gov.signedIn}
              chainTime={p.executed_tx_hash ? gov.chainTimes[p.executed_tx_hash] : undefined}
              voting={gov.votingId === p.id}
              voteError={gov.votingId === p.id || gov.myVotes[p.id] ? gov.voteError : null}
              onVote={(choice) => gov.vote(p.id, choice)}
            />
          ))
        )}
      </div>
    </>
  );
}

/* ---------------- Vaults ---------------- */

function VaultsTab() {
  const gov = useGovernanceData();
  const vaultsQ = useQuery({
    queryKey: ["governance", "asset-vaults"],
    queryFn: () => listAssetVaults(),
    staleTime: 60_000,
  });

  if (vaultsQ.isLoading) {
    return <div className="card-institutional p-10 text-center text-sm text-muted-foreground">Loading registered vaults…</div>;
  }
  if (vaultsQ.error) {
    return <div className="card-institutional p-6 text-sm text-destructive">Could not load vault registry: {(vaultsQ.error as Error).message}</div>;
  }
  if ((vaultsQ.data ?? []).length === 0) {
    return (
      <div className="card-institutional p-10 text-center">
        <Vault className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">No vaults registered</h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
          Vault governance controls remain inactive until an asset vault is bootstrapped and its
          script address, committee, and bootstrap transaction are recorded.
        </p>
        <Link to="/blockfrost-health" className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary">
          View indexer status
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(vaultsQ.data ?? []).map((vault: AssetVaultRow) => (
        <VaultGovernanceCard key={vault.id} vault={vault} proposals={gov.proposals} />
      ))}
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

function ProposalStatus({ status }: { status: DerivedStatus }) {
  const map: Record<DerivedStatus, "accent" | "success" | "destructive" | "primary"> = {
    draft: "primary",
    voting_open: "accent",
    awaiting_finalisation: "primary",
    passed: "success",
    rejected: "destructive",
    executed: "success",
  };
  return <Badge tone={map[status]}>{DERIVED_STATUS_LABEL[status]}</Badge>;
}
