import { createFileRoute } from "@tanstack/react-router";
import { Sparkles, Users, Leaf, TrendingUp, Copy } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/StatusBadge";
import { Sparkline } from "@/components/charts/Sparkline";
import { sparkline } from "@/lib/mock-data";

export const Route = createFileRoute("/stewardship")({
  head: () => ({
    meta: [
      { title: "Stewardship Hub · Stellaris Finance" },
      { name: "description", content: "Impact Stewards manage referrals and track verifiable, on-chain impact metrics for Stellaris RealFi vaults." },
      { property: "og:title", content: "Impact Stewardship · Stellaris" },
      { property: "og:description", content: "Track verifiable impact and grow the Stellaris community." },
    ],
  }),
  component: Stewardship,
});

function Stewardship() {
  const referralCode = "STL-STEWARD-9F2A";
  return (
    <AppShell>
      <div className="flex flex-col gap-1">
        <div className="text-[11px] uppercase tracking-[0.22em] text-primary">Stewardship</div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Impact Stewards Hub</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Bring verified capital to real-world impact. Track referrals, earn rewards, and measure verifiable outcomes.</p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <ImpactKPI icon={Users} label="Referred investors" value="248" delta="+12 this week" />
        <ImpactKPI icon={TrendingUp} label="Capital referred" value="₳ 4.82M" delta="+9.3%" />
        <ImpactKPI icon={Leaf} label="CO₂ offset (attested)" value="18.2 Kt" delta="Verified · Verra" />
        <ImpactKPI icon={Sparkles} label="Steward rewards" value="₳ 24,120" delta="Claimable" accent />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="card-institutional p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Verifiable Impact Trend</h2>
            <Badge tone="success">On-chain attested</Badge>
          </div>
          <div className="mt-4">
            <Sparkline data={sparkline(15, 60)} height={140} stroke="var(--color-success)" fill="var(--color-success)" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniImpact label="SDG 7" text="Affordable clean energy" />
            <MiniImpact label="SDG 13" text="Climate action" />
            <MiniImpact label="SDG 15" text="Life on land" />
          </div>
        </div>

        <div className="card-institutional p-6">
          <h2 className="text-sm font-semibold text-foreground">Your Referral</h2>
          <p className="mt-1 text-xs text-muted-foreground">Share your code. Earn 0.5% of first-year yield per referred deposit.</p>
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-secondary/40 p-3">
            <code className="flex-1 font-mono text-sm text-foreground">{referralCode}</code>
            <button className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>
          <div className="mt-5 space-y-3 text-sm">
            <TierRow tier="Bronze" min="₳ 100K" cur active />
            <TierRow tier="Silver" min="₳ 1M" />
            <TierRow tier="Gold" min="₳ 5M" />
            <TierRow tier="Platinum" min="₳ 20M" />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function ImpactKPI({ icon: Icon, label, value, delta, accent = false }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; delta: string; accent?: boolean }) {
  return (
    <div className="card-institutional p-5">
      <div className="flex items-center gap-2">
        <div className={`grid h-9 w-9 place-items-center rounded-xl ${accent ? "bg-gradient-accent text-accent-foreground" : "bg-primary/10 text-primary"}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      </div>
      <div className="number-display mt-3 text-2xl font-semibold text-foreground">{value}</div>
      <div className={`text-xs ${accent ? "text-accent-foreground" : "text-muted-foreground"}`}>{delta}</div>
    </div>
  );
}
function MiniImpact({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-primary">{label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">{text}</div>
    </div>
  );
}
function TierRow({ tier, min, cur = false, active = false }: { tier: string; min: string; cur?: boolean; active?: boolean }) {
  return (
    <div className={`flex items-center justify-between rounded-lg px-3 py-2 ${active ? "bg-primary/10 border border-primary/25" : "bg-secondary/40"}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${active ? "bg-primary" : "bg-muted-foreground/40"}`} />
        <span className={`text-sm font-medium ${active ? "text-primary" : "text-foreground"}`}>{tier}</span>
        {cur && <span className="text-[10px] uppercase tracking-widest text-primary">Current</span>}
      </div>
      <span className="number-display text-xs text-muted-foreground">{min}</span>
    </div>
  );
}
