import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { formatLocalAndUtc, addDaysMs } from "@/lib/format-time";
import { DataSourceStamp } from "@/components/brand/DataSourceStamp";
import { Clock, Lock, AlertTriangle, Info } from "lucide-react";
import { BRAND } from "@/config/brand";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { STAKE_TIERS, MOCK_BASE_BALANCE, type StakeTierId } from "@/data/staking.mock";

export const Route = createFileRoute("/stake")({
  head: () => ({
    meta: [
      { title: `Stake ${BRAND.staked.ticker} · Stellaris` },
      { name: "description", content: `Stake ${BRAND.base.ticker} for ${BRAND.staked.ticker}: flexible staking with a cooldown, or a locked position at a higher target rate. Rates are variable, not promised.` },
      { property: "og:title", content: `Stake ${BRAND.staked.ticker} · Stellaris` },
      { property: "og:description", content: `Flexible or locked staking for ${BRAND.staked.ticker}, with the cooldown shown before you confirm.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StakePage,
});

/** Browser-only clock so local times never mismatch the server render. */
function useNow() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return now;
}

function StakePage() {
  const [tierId, setTierId] = useState<StakeTierId>("flex");
  const [amount, setAmount] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState(false);
  const now = useNow();
  const addDays = (d: number) => (now === null ? "…" : formatLocalAndUtc(addDaysMs(now, d)));
  const tier = STAKE_TIERS.find(t => t.id === tierId)!;
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0 && n <= MOCK_BASE_BALANCE;
  const yearly = valid ? (n * tier.aprPct) / 100 : 0;

  return (
    <MarketingLayout>
    <div className="mx-auto max-w-3xl px-4 md:px-6 py-10">
      <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs text-warning">
        <AlertTriangle className="h-3.5 w-3.5" /> Testnet preview — illustrative data, nothing is staked
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Stake {BRAND.base.ticker}, earn as {BRAND.staked.ticker}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{BRAND.staked.description}</p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Staking option">
        {STAKE_TIERS.map(t => {
          const active = t.id === tierId;
          const Icon = t.id === "locked" ? Lock : Clock;
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={active}
              onClick={() => { setTierId(t.id); setReviewing(false); setDone(false); }}
              className={`card-institutional p-5 text-left transition-colors ${active ? "border-primary ring-1 ring-primary" : "hover:border-primary/50"}`}
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-primary" />{t.label}</span>
                <span className="text-right">
                  <span className="number-display block text-xl font-semibold text-accent">{t.aprPct.toFixed(1)}%</span>
                  <span className="block text-xs uppercase tracking-widest text-muted-foreground">target, variable</span>
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t.summary}</p>
              <div className="mt-3 text-xs uppercase tracking-widest text-muted-foreground">
                {t.id === "locked" ? `Lock: ${t.cooldownDays} days` : `Cooldown: ${t.cooldownDays} days`}
                {t.multiplier > 1 && ` · ${t.multiplier}× yield`}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-2"><DataSourceStamp source="example rates, not live contract data" illustrative /></div>

      <ul className="mt-6 space-y-2">
        {[
          "Yield is credited gradually over 7 days after each report, so staking just before a report doesn't capture it.",
          `The protocol keeps 12.5% of yield (hard cap 20%), never your principal; half of that goes to the first-loss reserve.`,
          "Staking may require an eligibility check, depending on your country.",
        ].map(note => (
          <li key={note} className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> {note}
          </li>
        ))}
      </ul>

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
          <button onClick={() => setAmount(String(MOCK_BASE_BALANCE))} className="min-h-11 min-w-11 rounded-lg border border-border px-3 text-xs">Max</button>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">Example balance (not your wallet): {MOCK_BASE_BALANCE.toLocaleString()} {BRAND.base.ticker}</div>

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
              <Clock className="h-4 w-4 text-warning" /> {tier.id === "locked" ? `${tier.cooldownDays}-day lock` : `${tier.cooldownDays}-day cooldown`}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {tier.id === "locked"
                ? `Your ${BRAND.base.ticker} is locked for ${tier.cooldownDays} days. Earliest withdrawal: ${addDays(tier.cooldownDays)}. Only you can unlock it once the lock ends.`
                : `When you unstake, funds arrive ${tier.cooldownDays} days after your request (e.g. request today → available ${addDays(tier.cooldownDays)}). During the cooldown your request no longer earns yield but still shares in any loss until you claim.`}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">You stake</dt><dd className="text-right">{n.toLocaleString()} {BRAND.base.ticker}</dd>
              <dt className="text-muted-foreground">Target rate (variable)</dt><dd className="text-right">{tier.aprPct.toFixed(1)}% / yr</dd>
              <dt className="text-muted-foreground">Yearly earnings at the target rate</dt><dd className="text-right">{yearly.toFixed(2)} {BRAND.base.ticker}</dd>
            </dl>
            <div className="mt-2"><DataSourceStamp source="example rates" illustrative /></div>
            <p className="mt-2 text-xs text-muted-foreground">
              Rates are targets, not promises. They vary with the reserve portfolio&apos;s yield and can be lower.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setReviewing(false)} className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm">Back</button>
              <button onClick={() => setDone(true)} className="flex-1 rounded-xl bg-gradient-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground">
                Simulate (no transaction)
              </button>
            </div>
          </div>
        )}

        {done && (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-border bg-secondary/50 p-4 text-sm" role="status">
            <Info className="mt-0.5 h-4 w-4 text-primary" />
            Preview only — no transaction was sent. Staking goes live once the {BRAND.staked.ticker} contract is deployed.
          </div>
        )}
      </div>
    </div>
    </MarketingLayout>
  );
}
