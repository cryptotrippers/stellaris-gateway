import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Shield, Leaf, ChevronRight, CheckCircle2, Loader2, ExternalLink } from "lucide-react";
import { Badge, RiskBadge } from "@/components/ui/StatusBadge";
import { ASSETS, formatAda, formatUsd, sparkline } from "@/lib/mock-data";
import { Sparkline } from "@/components/charts/Sparkline";
import { useWallet } from "@/lib/wallet-store";
import { FundingBar } from "@/components/ui/funding-bar";
import { ShareRow } from "@/components/landing/ShareRow";

export const Route = createFileRoute("/marketplace/$id")({
  loader: ({ params }) => {
    const asset = ASSETS.find(a => a.id === params.id);
    if (!asset) throw notFound();
    return { asset };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Asset not found · Stellaris" }, { name: "robots", content: "noindex" }] };
    const a = loaderData.asset;
    return {
      meta: [
        { title: `${a.name} · Stellaris Finance` },
        { name: "description", content: `${a.category} · ${a.apy}% APY · ${a.risk} risk. ${a.description}` },
        { property: "og:title", content: `${a.name} — ${a.apy}% APY` },
        { property: "og:description", content: a.description },
      ],
    };
  },
  notFoundComponent: () => (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-2xl font-semibold text-foreground">Asset not found</h1>
      <p className="mt-2 text-muted-foreground">This vault may have been delisted.</p>
      <Link to="/marketplace" className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Back to marketplace</Link>
    </div>
  ),
  errorComponent: () => <div className="py-24 text-center text-muted-foreground">Something went wrong loading this asset.</div>,
  component: AssetDetail,
});

function AssetDetail() {
  const { asset } = Route.useLoaderData();
  return (
    <div>
      <Link to="/marketplace" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Marketplace
      </Link>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">{asset.category}</Badge>
            <RiskBadge risk={asset.risk} />
            <Badge tone="success">ESG {asset.esgRating}</Badge>
            <Badge tone="accent"><Shield className="h-3 w-3" /> Audited</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">{asset.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{asset.issuer} · {asset.location}</p>

          <div className="mt-5">
            <ShareRow
              url={`/marketplace/${asset.id}`}
              text={`I'm eyeing ${asset.name} — ${asset.apy}% APY, ESG ${asset.esgRating}, on Cardano.`}
              eventName="asset_share_click"
              label="Share this asset"
            />
          </div>


          <div className="mt-6 card-institutional p-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <BigStat label="Target APY" value={`${asset.apy}%`} accent />
              <BigStat label="Maturity" value={`${asset.maturityMonths}mo`} />
              <BigStat label="Min. Investment" value={formatAda(asset.minInvestmentAda)} />
              <BigStat label="ESG Rating" value={asset.esgRating} />
            </div>
            <div className="mt-6">
              <Sparkline data={sparkline(9, 60)} height={90} />
            </div>
          </div>

          <div className="mt-6 card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground">About this vault</h2>
            <p className="mt-3 text-sm leading-relaxed text-foreground/85">{asset.description}</p>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <DetailRow label="Issuer" value={asset.issuer} />
              <DetailRow label="Jurisdiction" value={asset.location} />
              <DetailRow label="Settlement" value="Cardano Mainnet · ADA" />
              <DetailRow label="Custody" value="Institutional (Fireblocks)" />
              <DetailRow label="Auditor" value="Certik · Runtime Verification" />
              <DetailRow label="Oracle" value="Charli3 · pricing feed" />
            </div>
          </div>

          <div className="mt-6 card-institutional p-6">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Leaf className="h-4 w-4 text-success" /> Verifiable Impact
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <ImpactStat label="CO₂ offset" value="12.4Kt / yr" />
              <ImpactStat label="Beneficiaries" value="62,000" />
              <ImpactStat label="UN SDG alignment" value="7 · 13" />
            </div>
            <a href="#" className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary">
              View on-chain attestation <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>

        {/* Invest panel */}
        <aside className="lg:sticky lg:top-24 h-fit">
          <InvestPanel />
        </aside>
      </div>
    </div>
  );

  function InvestPanel() {
    const wallet = useWallet();
    const [amount, setAmount] = useState<string>(String(asset.minInvestmentAda));
    const [step, setStep] = useState<"amount" | "connect" | "review" | "processing" | "success">("amount");
    const navigate = useNavigate();
    const n = Number(amount) || 0;
    const projectedYield = (n * asset.apy / 100) * (asset.maturityMonths / 12);
    const canProceed = n >= asset.minInvestmentAda;

    const nextFromAmount = () => setStep(wallet.connected ? "review" : "connect");

    return (
      <div className="card-institutional p-6 shadow-elegant">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Invest in this vault</div>
          <Badge tone="primary">{asset.fundedPct}% funded</Badge>
        </div>
        <FundingBar pct={asset.fundedPct} />

        {/* Stepper */}
        <ol className="mt-5 flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
          {["Amount", "Wallet", "Review", "Done"].map((s, i) => {
            const idx = ["amount", "connect", "review", "success"].indexOf(step);
            const done = idx > i || step === "success";
            const active = idx === i;
            return (
              <li key={s} className="flex items-center gap-1">
                <span className={`h-1.5 w-6 rounded-full ${done ? "bg-primary" : active ? "bg-accent" : "bg-border"}`} />
                <span className={active ? "text-foreground font-semibold" : ""}>{s}</span>
              </li>
            );
          })}
        </ol>

        {step === "amount" && (
          <div className="mt-5">
            <label className="text-xs font-medium text-muted-foreground">Amount (ADA)</label>
            <div className="mt-1 flex items-center rounded-xl border border-border bg-surface px-3 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
              <span className="text-lg text-muted-foreground">₳</span>
              <input
                value={amount}
                onChange={e => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="w-full bg-transparent px-2 py-3 text-lg font-semibold number-display outline-none"
              />
              <button onClick={() => setAmount(String(asset.minInvestmentAda * 10))} className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">10×</button>
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
              <span>Min. {formatAda(asset.minInvestmentAda)}</span>
              <span>≈ {formatUsd(n)}</span>
            </div>

            <div className="mt-5 rounded-xl bg-secondary/60 p-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Projected yield ({asset.maturityMonths}mo)</span>
                <span className="number-display font-semibold text-success">+{formatAda(projectedYield)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Blended APY</span>
                <span className="font-semibold text-foreground">{asset.apy}%</span>
              </div>
            </div>

            <button
              disabled={!canProceed}
              onClick={nextFromAmount}
              className="mt-5 w-full inline-flex items-center justify-center gap-1 rounded-xl bg-gradient-primary py-3 text-sm font-semibold text-primary-foreground shadow-glow disabled:opacity-50 disabled:cursor-not-allowed hover:-translate-y-0.5 transition-transform"
            >
              Continue <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {step === "connect" && (
          <div className="mt-5 text-center">
            <p className="text-sm text-muted-foreground">Connect your Cardano wallet to continue. We support Lace, Eternl, and WalletConnect.</p>
            <p className="mt-4 text-xs text-muted-foreground">Use the “Connect Wallet” button in the top bar, then return here.</p>
            <button onClick={() => setStep("amount")} className="mt-4 text-xs text-primary hover:underline">Back</button>
          </div>
        )}

        {step === "review" && (
          <div className="mt-5">
            <h4 className="text-sm font-semibold text-foreground">Review & sign</h4>
            <dl className="mt-3 space-y-2 text-sm">
              <ReviewRow k="Vault" v={asset.name} />
              <ReviewRow k="Amount" v={formatAda(n)} />
              <ReviewRow k="Projected yield" v={`+${formatAda(projectedYield)}`} />
              <ReviewRow k="Network fee" v="~₳ 0.17" />
              <ReviewRow k="Timelock" v="24h withdrawal" />
            </dl>
            <div className="mt-4 rounded-lg bg-accent/10 border border-accent/25 px-3 py-2 text-[11px] text-foreground/85">
              <Shield className="inline h-3.5 w-3.5 mr-1 text-accent" />
              A 24h timelock is applied to all withdrawals for institutional-grade security.
            </div>
            <button
              onClick={() => { setStep("processing"); setTimeout(() => setStep("success"), 1600); }}
              className="mt-5 w-full inline-flex items-center justify-center rounded-xl bg-gradient-primary py-3 text-sm font-semibold text-primary-foreground shadow-glow"
            >
              Sign transaction
            </button>
            <button onClick={() => setStep("amount")} className="mt-2 w-full text-xs text-muted-foreground hover:text-foreground">Back</button>
          </div>
        )}

        {step === "processing" && (
          <div className="mt-8 flex flex-col items-center gap-3 py-6">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Waiting for on-chain confirmation…</p>
          </div>
        )}

        {step === "success" && (
          <div className="mt-6 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <h4 className="mt-3 text-lg font-semibold text-foreground">Investment confirmed</h4>
            <p className="mt-1 text-sm text-muted-foreground">You’ve invested {formatAda(n)} in {asset.name}.</p>
            <button
              onClick={() => navigate({ to: "/app" })}
              className="mt-5 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground"
            >
              View portfolio
            </button>
          </div>
        )}
      </div>
    );
  }
}

function BigStat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`number-display mt-1 text-2xl font-semibold ${accent ? "text-primary" : "text-foreground"}`}>{value}</div>
    </div>
  );
}
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-secondary/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
function ImpactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="number-display mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}
function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 pb-2 last:border-b-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium text-foreground">{v}</span>
    </div>
  );
}
