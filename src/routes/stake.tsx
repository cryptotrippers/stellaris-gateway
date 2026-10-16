import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Clock, Lock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { BRAND } from "@/config/brand";
import { STAKE_TIERS, MOCK_BASE_BALANCE, type StakeTierId } from "@/data/staking.mock";

export const Route = createFileRoute("/stake")({
  head: () => ({
    meta: [
      { title: `Stake ${BRAND.staked.ticker} · Stellaris` },
      { name: "description", content: `Stake ${BRAND.base.ticker} for ${BRAND.staked.ticker}: a 7-day unstake tier or a 30-day lock at a higher rate.` },
      { property: "og:title", content: `Stake ${BRAND.staked.ticker} · Stellaris` },
      { property: "og:description", content: `Two staking tiers for ${BRAND.staked.ticker}, with the cooldown shown before you confirm.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StakePage,
});

function addDays(d: number) {
  const t = new Date();
  t.setDate(t.getDate() + d);
  return t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function StakePage() {
  const [tierId, setTierId] = useState<StakeTierId>("flex7");
  const [amount, setAmount] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState(false);
  const tier = STAKE_TIERS.find(t => t.id === tierId)!;
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0 && n <= MOCK_BASE_BALANCE;
  const yearly = valid ? (n * tier.aprPct) / 100 : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 md:px-6 py-10">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs text-warning">
        <AlertTriangle className="h-3.5 w-3.5" /> Testnet preview — illustrative data, nothing is staked
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Stake {BRAND.base.ticker}, earn as {BRAND.staked.ticker}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{BRAND.staked.description}</p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {STAKE_TIERS.map(t => {
          const active = t.id === tierId;
          const Icon = t.id === "lock30" ? Lock : Clock;
          return (
            <button
              key={t.id}
              onClick={() => { setTierId(t.id); setReviewing(false); setDone(false); }}
              className={`card-institutional p-5 text-left transition-colors ${active ? "border-primary ring-1 ring-primary" : "hover:border-primary/50"}`}
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" />{t.label}</span>
                <span className="number-display text-xl font-semibold text-accent">{t.aprPct.toFixed(1)}%</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t.summary}</p>
              <div className="mt-3 text-[11px] uppercase tracking-widest text-muted-foreground">Cooldown: {t.cooldownDays} days</div>
            </button>
          );
        })}
      </div>

      <div className="mt-6 card-institutional p-5">
        <label className="text-sm font-medium" htmlFor="stake-amt">Amount ({BRAND.base.ticker})</label>
        <div className="mt-2 flex gap-2">
          <input
            id="stake-amt"
            inputMode="decimal"
            value={amount}
            onChange={e => { setAmount(e.target.value); setReviewing(false); setDone(false); }}
            placeholder="0.00"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          <button onClick={() => setAmount(String(MOCK_BASE_BALANCE))} className="rounded-lg border border-border px-3 text-xs">Max</button>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">Preview balance: {MOCK_BASE_BALANCE.toLocaleString()} {BRAND.base.ticker}</div>

        {!reviewing && (
          <button
            disabled={!valid}
            onClick={() => setReviewing(true)}
            className="mt-4 w-full rounded-xl bg-gradient-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            Review stake
          </button>
        )}

        {reviewing && valid && !done && (
          <div className="mt-4 rounded-xl border border-warning/40 bg-warning/5 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock className="h-4 w-4 text-warning" /> {tier.cooldownDays}-day cooldown
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {tier.id === "lock30"
                ? `Your ${BRAND.base.ticker} is locked for ${tier.cooldownDays} days. Earliest withdrawal: ${addDays(tier.cooldownDays)}.`
                : `When you unstake, funds arrive ${tier.cooldownDays} days after your request (e.g. request today → available ${addDays(tier.cooldownDays)}).`}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">You stake</dt><dd className="text-right">{n.toLocaleString()} {BRAND.base.ticker}</dd>
              <dt className="text-muted-foreground">Illustrative rate</dt><dd className="text-right">{tier.aprPct.toFixed(1)}% / yr</dd>
              <dt className="text-muted-foreground">Illustrative yearly earnings</dt><dd className="text-right">{yearly.toFixed(2)} {BRAND.base.ticker}</dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setReviewing(false)} className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm">Back</button>
              <button onClick={() => setDone(true)} className="flex-1 rounded-xl bg-gradient-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
                I understand — confirm
              </button>
            </div>
          </div>
        )}

        {done && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-success/40 bg-success/5 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
            Preview only — no transaction was sent. Staking goes live once the {BRAND.staked.ticker} contract is deployed.
          </div>
        )}
      </div>
    </div>
  );
}
