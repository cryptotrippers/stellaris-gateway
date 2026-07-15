import { createFileRoute, Link } from "@tanstack/react-router";
import { LayoutDashboard, FileText, Vault, Users, Activity, PlusCircle, ChevronRight } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { Sparkline } from "@/components/charts/Sparkline";
import { PROPOSALS, VAULT_ACTIVITY, formatAda, sparkline } from "@/lib/mock-data";

export const Route = createFileRoute("/governance")({
  head: () => ({
    meta: [
      { title: "Governance · Stellaris Finance" },
      { name: "description", content: "Institutional governance for the Stellaris RealFi protocol. Vote on SIPs, monitor vault health, manage treasury." },
      { property: "og:title", content: "Stellaris Governance Console" },
      { property: "og:description", content: "SIPs, treasury, and vault activity in one institutional-grade dashboard." },
    ],
  }),
  component: GovernancePage,
});

function GovernancePage() {
  return (
    <AppShell>
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <GovSidebar />
        <div>
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Governance Console</div>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Protocol Overview</h1>
            </div>
            <Link to="/governance/new" className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-glow">
              <PlusCircle className="h-4 w-4" /> New Proposal
            </Link>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KPI label="Total Value Locked" value="₳ 128.4M" delta="+4.2%" spark={sparkline(1, 24)} />
            <KPI label="Active Proposals" value="7" delta="+2" spark={sparkline(7, 24)} />
            <KPI label="Vault Health" value="98.6%" delta="Nominal" spark={sparkline(4, 24)} tone="success" />
            <KPI label="Treasury Runway" value="42 mo" delta="Stable" spark={sparkline(11, 24)} />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="card-institutional p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-foreground">Recent Proposals</h2>
                <Link to="/governance" className="text-xs text-primary">View all</Link>
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
        </div>
      </div>
    </AppShell>
  );
}

function GovSidebar() {
  const items = [
    { icon: LayoutDashboard, label: "Overview", active: true },
    { icon: FileText, label: "Proposals" },
    { icon: Vault, label: "Vaults" },
    { icon: Users, label: "Delegates" },
    { icon: Activity, label: "Signals" },
  ];
  return (
    <aside className="card-institutional p-3 h-fit lg:sticky lg:top-24">
      <div className="px-2 py-2 text-[10px] uppercase tracking-widest text-muted-foreground">Governance</div>
      <ul className="space-y-0.5">
        {items.map(it => (
          <li key={it.label}>
            <button className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${it.active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
              <it.icon className="h-4 w-4" /> {it.label}
              {it.active && <ChevronRight className="ml-auto h-3.5 w-3.5" />}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-4 rounded-xl bg-gradient-to-br from-primary/10 to-accent/10 border border-primary/15 p-3">
        <div className="text-[10px] uppercase tracking-widest text-primary">Voting Power</div>
        <div className="number-display mt-1 text-lg font-semibold text-foreground">128,400 sSTL</div>
        <div className="mt-1 text-[11px] text-muted-foreground">Delegated to steward.eth</div>
      </div>
    </aside>
  );
}

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
