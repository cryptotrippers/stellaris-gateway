import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, ShieldCheck, ArrowDown } from "lucide-react";
import { BRAND } from "@/config/brand";
import { TRANSPARENCY as T } from "@/data/transparency.mock";

export const Route = createFileRoute("/transparency")({
  head: () => ({
    meta: [
      { title: `${BRAND.productName} transparency · Stellaris` },
      { name: "description", content: `Daily NAV, reserve sleeves, first-loss reserve and overcollateralisation behind ${BRAND.base.ticker} and ${BRAND.staked.ticker}.` },
      { property: "og:title", content: `${BRAND.productName} transparency · Stellaris` },
      { property: "og:description", content: `How ${BRAND.productName} reserves are held and how your money is protected.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TransparencyPage,
});

const usd = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function TransparencyPage() {
  const latest = T.navHistory[T.navHistory.length - 1];
  const prev = T.navHistory[T.navHistory.length - 2];
  const maxNav = Math.max(...T.navHistory.map(p => p.nav));
  const minNav = Math.min(...T.navHistory.map(p => p.nav));
  const totalExposure = T.originators.reduce((s, o) => s + o.exposureUsd, 0);
  const oc = T.overcollateral;
  const ocOk = oc.ratioPct >= oc.targetMinPct && oc.ratioPct <= oc.targetMaxPct;

  return (
    <div className="mx-auto max-w-[1200px] px-4 md:px-6 py-10 space-y-8">
      <div>
        <div className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" /> Testnet preview — illustrative data
        </div>
        <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">{BRAND.productName} transparency</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          What backs {BRAND.base.ticker} and {BRAND.staked.ticker}. As of {new Date(T.asOf).toUTCString()}.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="card-institutional p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Daily NAV per {BRAND.staked.ticker}</div>
          <div className="number-display mt-1 text-3xl font-semibold">${latest.nav.toFixed(4)}</div>
          <div className="text-xs text-muted-foreground">{latest.nav >= prev.nav ? "+" : ""}{((latest.nav / prev.nav - 1) * 100).toFixed(3)}% vs previous day</div>
          <div className="mt-1 text-xs text-muted-foreground">{BRAND.base.ticker} is fixed at $1; only {BRAND.staked.ticker} accrues yield.</div>
          <div className="mt-4 flex h-16 items-end gap-1">
            {T.navHistory.map(p => (
              <div key={p.date} title={`${p.date}: $${p.nav.toFixed(4)}`} className="flex-1 rounded-t bg-primary/70"
                style={{ height: `${20 + ((p.nav - minNav) / (maxNav - minNav || 1)) * 80}%` }} />
            ))}
          </div>
        </div>
        <div className="card-institutional p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">First-loss reserve</div>
          <div className="number-display mt-1 text-3xl font-semibold">{T.firstLoss.levelPct.toFixed(1)}%</div>
          <div className="text-xs text-muted-foreground">Target {T.firstLoss.targetPct}% of reserves</div>
          <Bar value={T.firstLoss.levelPct} max={T.firstLoss.targetPct} />
        </div>
        <div className="card-institutional p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Overcollateralisation</div>
          <div className={`number-display mt-1 text-3xl font-semibold ${ocOk ? "text-success" : "text-warning"}`}>{oc.ratioPct.toFixed(1)}%</div>
          <div className="text-xs text-muted-foreground">Target {oc.targetMinPct}–{oc.targetMaxPct}% · reserves {usd(T.totalReservesUsd)} vs supply {usd(T.supplyUsd)}</div>
        </div>
      </section>

      <section className="card-institutional p-5">
        <h2 className="text-lg font-semibold">Reserve sleeves</h2>
        <div className="mt-4 space-y-5">
          {T.sleeves.map(s => {
            const inBand = s.sharePct >= s.targetMinPct && s.sharePct <= s.targetMaxPct;
            return (
              <div key={s.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{s.name}</div>
                    <div className="text-xs text-muted-foreground">{s.detail}</div>
                  </div>
                  <div className="text-sm">
                    <span className="number-display font-semibold">{s.sharePct}%</span>
                    <span className="text-muted-foreground"> · target {s.targetMinPct}–{s.targetMaxPct}%</span>
                    <span className={`ml-2 text-xs ${inBand ? "text-success" : "text-warning"}`}>{inBand ? "in band" : "outside band"}</span>
                  </div>
                </div>
                <div className="relative mt-2 h-2.5 rounded-full bg-secondary">
                  <div className="absolute inset-y-0 rounded-full bg-primary/20" style={{ left: `${s.targetMinPct}%`, width: `${s.targetMaxPct - s.targetMinPct}%` }} />
                  <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${s.sharePct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card-institutional p-5 overflow-x-auto">
        <h2 className="text-lg font-semibold">Exposure per originator</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-2">Originator</th><th>Sleeve</th><th className="text-right">Exposure</th><th className="text-right">% of reserves</th></tr>
          </thead>
          <tbody>
            {T.originators.map(o => (
              <tr key={o.name} className="border-t border-border">
                <td className="py-2">{o.name}</td><td className="text-muted-foreground">{o.sleeve}</td>
                <td className="text-right number-display">{usd(o.exposureUsd)}</td>
                <td className="text-right number-display">{((o.exposureUsd / T.totalReservesUsd) * 100).toFixed(1)}%</td>
              </tr>
            ))}
            <tr className="border-t border-border font-semibold"><td className="py-2">Total</td><td /><td className="text-right">{usd(totalExposure)}</td><td /></tr>
          </tbody>
        </table>
      </section>

      <Protection />
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="mt-4 h-2.5 rounded-full bg-secondary">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  );
}

function Protection() {
  const stack = [
    { t: "Originator collateral and covenants", d: "Each originator posts collateral and is bound by covenants. Losses hit them first." },
    { t: "Protocol first-loss reserve", d: `The protocol pays before stakers. This reserve absorbs losses before any ${BRAND.staked.ticker} holder is touched.`, key: true },
    { t: "Overcollateral buffer", d: "Reserves are held above 100% of supply; the surplus absorbs the next layer of losses." },
    { t: `${BRAND.staked.ticker} stakers`, d: `Stakers earn the yield and sit ahead of ${BRAND.base.ticker} holders in the loss order.` },
    { t: `${BRAND.base.ticker} holders`, d: "Last in line — protected by every layer above." },
  ];
  const redemption = ["Cash", "Money-market fund tokens", "Short investment-grade assets"];
  return (
    <section className="card-institutional p-5 md:p-8">
      <h2 className="text-2xl font-semibold tracking-tight">How your money is protected</h2>
      <p className="mt-1 text-sm text-muted-foreground">If something goes wrong, losses are absorbed in this order — first loss at the top.</p>
      <ol className="mt-6 space-y-2">
        {stack.map((s, i) => (
          <li key={s.t}>
            <div className={`flex gap-4 rounded-xl border p-4 ${s.key ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-border bg-surface"}`}>
              <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold ${s.key ? "bg-gradient-primary text-primary-foreground" : "bg-secondary"}`}>{i + 1}</div>
              <div>
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {s.t}
                  {s.key && <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-foreground"><ShieldCheck className="h-3 w-3" /> Our key difference</span>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{s.d}</p>
              </div>
            </div>
            {i < stack.length - 1 && <ArrowDown className="mx-auto my-1 h-4 w-4 text-muted-foreground" />}
          </li>
        ))}
      </ol>

      <h3 className="mt-10 text-lg font-semibold">Redemption order</h3>
      <p className="mt-1 text-sm text-muted-foreground">When you redeem {BRAND.base.ticker}, we pay from the most liquid assets first:</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-3">
        {redemption.map((r, i) => (
          <li key={r} className="rounded-xl border border-border bg-surface p-4 text-sm"><span className="number-display mr-2 text-primary">{i + 1}.</span>{r}</li>
        ))}
      </ol>
      <p className="mt-4 rounded-xl border border-success/40 bg-success/5 p-4 text-sm">
        Credit and marketplace assets are <strong>never sold</strong> to meet redemptions.
      </p>
    </section>
  );
}
