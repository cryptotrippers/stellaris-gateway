import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRight, TrendingUp, Leaf, Sun, Building2, Wind, Wallet } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Sparkline } from "@/components/charts/Sparkline";
import { RiskBadge, Badge } from "@/components/ui/StatusBadge";
import { FundingBar, SectionHeader } from "@/components/ui/funding-bar";
import { ChainStatusCard } from "@/components/chain/ChainStatusCard";
import { MyVaultHoldingsCard } from "@/components/vault/MyVaultHoldingsCard";
import { useVaultAssetIds } from "@/hooks/useVaultAssetIds";
import { ASSETS, formatAda, formatUsd, sparkline } from "@/lib/mock-data";
import { useWallet } from "@/lib/wallet-store";
import { supabase } from "@/integrations/supabase/client";


export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "Your Portfolio · Stellaris Finance" },
      { name: "description", content: "Live view of your fractional real-world asset positions on Cardano — yield, ESG ratings, and compliance status at a glance." },
      { property: "og:title", content: "Your Portfolio · Stellaris" },
      { property: "og:description", content: "Track your RealFi positions, yield, and impact on Cardano." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PortfolioPage,
});

const categoryIcon = {
  "Sustainable Farming": Leaf,
  "Clean Energy": Wind,
  "Real Estate": Building2,
  "Carbon Credits": Leaf,
  "Infrastructure": Sun,
} as const;

type Position = { vault_id: string; amount_ada: number; opened_at: string; tx_hash: string };
type Txn = { type: "deposit" | "withdraw" | "yield"; amount_ada: number; created_at: string; vault_id: string };

function usePortfolioData(walletAddress: string | null) {
  return useQuery({
    queryKey: ["portfolio", walletAddress],
    enabled: !!walletAddress,
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return { positions: [] as Position[], txns: [] as Txn[] };
      const [{ data: positions }, { data: txns }] = await Promise.all([
        supabase.from("vault_positions").select("vault_id,amount_ada,opened_at,tx_hash").eq("user_id", auth.user.id),
        supabase.from("transactions").select("type,amount_ada,created_at,vault_id").eq("user_id", auth.user.id),
      ]);
      return { positions: (positions ?? []) as Position[], txns: (txns ?? []) as Txn[] };
    },
  });
}

function PortfolioPage() {
  const wallet = useWallet();
  const { assetIds: vaultAssetIds } = useVaultAssetIds();
  const { data, isLoading } = usePortfolioData(wallet.connected ? wallet.address : null);

  const positions = data?.positions ?? [];
  const txns = data?.txns ?? [];

  const totalAda = positions.reduce((s, p) => s + Number(p.amount_ada), 0);
  const yieldTxns = txns.filter(t => t.type === "yield");
  const totalYield = yieldTxns.reduce((s, t) => s + Number(t.amount_ada), 0);
  const yieldPct = totalAda > 0 ? (totalYield / totalAda) * 100 : 0;
  const activeVaults = new Set(positions.map(p => p.vault_id)).size;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const yield24h = yieldTxns
    .filter(t => new Date(t.created_at).getTime() >= cutoff)
    .reduce((s, t) => s + Number(t.amount_ada), 0);

  // Blended APY: sum(position.amount * asset.apy) / totalAda
  const blendedApy = totalAda > 0
    ? positions.reduce((s, p) => {
        const asset = ASSETS.find(a => a.id === p.vault_id);
        return s + Number(p.amount_ada) * (asset?.apy ?? 0);
      }, 0) / totalAda
    : 0;

  return (
    <AppShell>
      <section className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="card-institutional bg-gradient-to-br from-primary via-primary to-[oklch(0.28_0.16_264)] p-6 md:p-8 text-primary-foreground overflow-hidden relative">
          <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
          <div className="relative">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-primary-foreground/70">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Total Portfolio Value · Cardano Mainnet
            </div>

            {!wallet.connected ? (
              <div className="mt-6 rounded-2xl border border-white/15 bg-white/5 p-6 backdrop-blur-sm">
                <div className="flex items-center gap-3">
                  <Wallet className="h-6 w-6 text-accent" />
                  <div>
                    <div className="text-base font-semibold">Connect your wallet</div>
                    <div className="text-sm text-primary-foreground/70">Live positions, yield, and APY appear here once a wallet is linked.</div>
                  </div>
                </div>
                <div className="mt-4 text-xs text-primary-foreground/60">Use the Connect Wallet button in the top bar to get started.</div>
              </div>
            ) : (
              <>
                <div className="mt-3 flex items-end gap-3">
                  <div className="number-display text-4xl md:text-5xl font-semibold tracking-tight">
                    {isLoading ? "…" : formatAda(totalAda)}
                  </div>
                  <div className="pb-2 text-sm text-primary-foreground/70">≈ {formatUsd(totalAda)}</div>
                </div>
                <div className="mt-2 flex items-center gap-2 text-sm">
                  <TrendingUp className="h-4 w-4 text-accent" />
                  <span className="text-accent font-medium">+{yieldPct.toFixed(2)}%</span>
                  <span className="text-primary-foreground/60">lifetime yield · {formatAda(totalYield)} earned</span>
                </div>

                <div className="mt-6 -mx-1">
                  <Sparkline data={sparkline(3, 40)} stroke="oklch(0.85 0.12 200)" fill="oklch(0.85 0.12 200)" height={72} />
                </div>

                <div className="mt-6 grid grid-cols-3 gap-3">
                  <MiniStat label="Active Vaults" value={String(activeVaults)} />
                  <MiniStat label="24h Yield" value={`+${formatAda(yield24h)}`} />
                  <MiniStat label="APY (blended)" value={`${blendedApy.toFixed(1)}%`} />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="grid gap-4">
          <ChainStatusCard />
          <MyVaultHoldingsCard
            assetIds={vaultAssetIds}
            showAssetBreakdown
            title="On-chain vault positions"
          />
          <div className="card-institutional p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Compliance Status</h3>
              <Badge tone="accent">Not verified</Badge>
            </div>
            <ul className="mt-4 space-y-2 text-sm">
              <ComplianceRow label="ZK-KYC attestation" ok={false} />
              <ComplianceRow label="Accredited investor attestation" ok={false} />
              <ComplianceRow label="Jurisdictional eligibility" ok={false} />
              <ComplianceRow label="Multi-Factor Authentication" ok={false} />
            </ul>
            <p className="mt-3 text-[11px] text-muted-foreground">
              KYC integration pending. No attestations issued on this account.
            </p>
          </div>
          <div className="card-institutional p-5">
            <h3 className="text-sm font-semibold text-foreground">Quick Actions</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <QuickAction to="/marketplace" label="Browse assets" />
              <QuickAction to="/governance" label="Vote SIPs" />
              <QuickAction to="/security" label="Security" />
              <QuickAction to="/stewardship" label="Impact" />
            </div>
          </div>
        </div>
      </section>

      <section className="mt-10">
        <SectionHeader title="Active Investments" href="/marketplace" hrefLabel="Explore marketplace" />
        {!wallet.connected ? (
          <div className="mt-4 card-institutional p-8 text-center">
            <Wallet className="mx-auto h-8 w-8 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium text-foreground">Connect a wallet to see your positions</div>
            <div className="mt-1 text-xs text-muted-foreground">No demo data is shown until a wallet is linked.</div>
          </div>
        ) : positions.length === 0 ? (
          <div className="mt-4 card-institutional p-8 text-center">
            <div className="number-display text-2xl font-semibold text-foreground">{formatAda(0)}</div>
            <div className="mt-1 text-sm text-muted-foreground">No active vaults yet — browse the marketplace to invest.</div>
            <Link to="/marketplace" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
              Explore assets <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : (
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {positions.map((inv, i) => {
              const asset = ASSETS.find(a => a.id === inv.vault_id);
              if (!asset) return null;
              const Icon = categoryIcon[asset.category];
              const amount = Number(inv.amount_ada);
              return (
                <Link key={`${inv.vault_id}-${inv.tx_hash}`} to="/marketplace/$id" params={{ id: asset.id }} className="card-institutional card-institutional-hover p-5 group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{asset.category}</div>
                        <div className="text-sm font-semibold text-foreground line-clamp-1">{asset.name}</div>
                      </div>
                    </div>
                    <RiskBadge risk={asset.risk} />
                  </div>

                  <div className="mt-5 flex items-end justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Position</div>
                      <div className="number-display text-xl font-semibold text-foreground">{formatAda(amount)}</div>
                    </div>
                    <div className="text-sm font-semibold text-success">APY {asset.apy}%</div>
                  </div>

                  <div className="mt-3">
                    <Sparkline data={sparkline(i * 7 + 2, 28)} stroke="var(--color-primary)" fill="var(--color-primary)" height={38} />
                  </div>

                  <div className="mt-4 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">ESG {asset.esgRating}</span>
                    <span className="inline-flex items-center gap-1 text-primary font-medium">
                      View <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10">
        <SectionHeader title="Featured Opportunities" href="/marketplace" hrefLabel="See all" />
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ASSETS.slice(0, 3).map(asset => {

            const Icon = categoryIcon[asset.category];
            return (
              <Link key={asset.id} to="/marketplace/$id" params={{ id: asset.id }} className="card-institutional card-institutional-hover p-5 flex flex-col">
                <div className="flex items-center justify-between">
                  <Badge tone="primary">{asset.category}</Badge>
                  <span className="text-xs text-muted-foreground">ESG {asset.esgRating}</span>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-primary text-primary-foreground">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{asset.name}</div>
                    <div className="text-xs text-muted-foreground">{asset.location}</div>
                  </div>
                </div>
                <div className="mt-5 flex items-end justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Target APY</div>
                    <div className="number-display text-2xl font-semibold text-primary">{asset.apy}%</div>
                  </div>
                  <RiskBadge risk={asset.risk} />
                </div>
                <FundingBar pct={asset.fundedPct} />
              </Link>
            );
          })}
        </div>
      </section>
    </AppShell>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/10 backdrop-blur-sm border border-white/10 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-primary-foreground/60">{label}</div>
      <div className="number-display text-base font-semibold">{value}</div>
    </div>
  );
}

function ComplianceRow({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-foreground/85">{label}</span>
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? "text-success" : "text-muted-foreground"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-success" : "bg-muted-foreground"}`} />
        {ok ? "Active" : "Pending"}
      </span>
    </li>
  );
}

function QuickAction({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="rounded-xl border border-border bg-secondary/50 px-3 py-2.5 text-sm font-medium text-foreground hover:border-primary/40 hover:bg-secondary transition-colors">
      {label}
    </Link>
  );
}
