import { ClientOnly, createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ArrowDownUp, Coins, Layers, Lock, Timer, ShieldCheck } from "lucide-react";
import { BRAND } from "@/config/brand";
import { TRANSPARENCY as T } from "@/data/transparency.mock";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { StatusPill } from "@/components/brand/StatusPill";
import { TesseraLiveDashboard } from "@/components/brand/TesseraLiveDashboard";
import { TesseraKeeperPanel } from "@/components/tessera/TesseraKeeperPanel";

const B = BRAND.base.ticker;
const S = BRAND.staked.ticker;

export const Route = createFileRoute("/tessera")({
  head: () => ({
    meta: [
      { title: `${BRAND.productName} (${B} / ${S}) · Stellaris` },
      {
        name: "description",
        content: `Live read-only ${BRAND.productName} Cardano Preprod deployment: reserve, ${S} vault and redemption queue, plus an illustrative token explainer. Test tokens have no monetary value.`,
      },
      { property: "og:title", content: `${BRAND.productName} · Stellaris` },
      {
        property: "og:description",
        content: `Live Cardano Preprod test data for ${B} and ${S}, with a separately labelled illustrative reserve and token explainer. No monetary value.`,
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TesseraPage,
});

const METER_CLS: Record<string, string> = {
  liquid: "",
  "short-ig": "home-meter-short-ig",
  credit: "home-meter-credit",
  rwa: "home-meter-rwa",
};

function TesseraPage() {
  return (
    <MarketingLayout>
      <TesseraLiveDashboard />
      <ClientOnly fallback={null}>
        <TesseraKeeperPanel />
      </ClientOnly>
      {/* Hero */}
      <section className="home-dark-section">
        <div className="home-container home-section">
          <div className="flex flex-wrap items-center gap-2">
            <p className="home-eyebrow">{BRAND.productName}</p>
            <StatusPill status="illustrative" />
          </div>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-semibold leading-tight md:text-5xl">
            A dollar-referenced token with reserves you can inspect.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed opacity-80">
            {B} aims to hold 1 USD of value per token. Staking it as {S} shares in the reserve
            portfolio's yield — at a target, variable rate that can fall. This is a testnet
            explainer: every figure below is illustrative, separate from the live Preprod data
            above, and no real money is involved.
          </p>
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {[
              { t: B, n: BRAND.base.name, d: BRAND.base.description, Icon: Coins },
              { t: S, n: BRAND.staked.name, d: BRAND.staked.description, Icon: Layers },
            ].map(({ t, n, d, Icon }) => (
              <div key={t} className="home-arch-layer">
                <span className="home-arch-num">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-display text-lg font-semibold">
                    {t} <span className="text-sm font-normal opacity-70">· {n}</span>
                  </p>
                  <p className="mt-1 text-sm leading-relaxed opacity-80">{d}</p>
                </div>
                <span />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reserve composition */}
      <section className="home-container home-section">
        <SectionHeader
          eyebrow="Reserve composition"
          title="Four sleeves, each with a target band"
          description={`Reserves are split across four sleeves. Liquid assets come first so redemptions can be met without selling credit or marketplace assets. Figures as of ${new Date(T.asOf).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} (UTC), illustrative.`}
        />
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {T.sleeves.map((s) => {
            const inBand = s.sharePct >= s.targetMinPct && s.sharePct <= s.targetMaxPct;
            return (
              <div key={s.id} className="home-card p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="font-display text-lg font-semibold">{s.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.detail}</p>
                  </div>
                  <div className="text-right">
                    <p className="number-display font-display text-2xl font-semibold text-teal">
                      {s.sharePct}%
                    </p>
                    <StatusPill status="illustrative" />
                  </div>
                </div>
                <meter
                  className={`home-meter mt-5 ${METER_CLS[s.id] ?? ""}`}
                  min={0}
                  max={100}
                  value={s.sharePct}
                  aria-label={`${s.name} share`}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Target band {s.targetMinPct}–{s.targetMaxPct}% ·{" "}
                  {inBand ? "within band" : "outside band"}
                </p>
              </div>
            );
          })}
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="home-card p-6">
            <p className="text-xs text-muted-foreground">Overcollateralisation</p>
            <StatusPill status="illustrative" className="mt-2" />
            <p className="mt-1 font-display text-2xl font-semibold">{T.overcollateral.ratioPct}%</p>
            <p className="text-xs text-muted-foreground">
              Target {T.overcollateral.targetMinPct}–{T.overcollateral.targetMaxPct}%
            </p>
          </div>
          <div className="home-card p-6">
            <p className="text-xs text-muted-foreground">Protocol first-loss reserve</p>
            <StatusPill status="illustrative" className="mt-2" />
            <p className="mt-1 font-display text-2xl font-semibold">{T.firstLoss.levelPct}%</p>
            <p className="text-xs text-muted-foreground">
              Target {T.firstLoss.targetPct}% of supply
            </p>
          </div>
        </div>
        <Link
          to="/transparency"
          className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-teal hover:underline"
        >
          Full transparency report <ArrowRight className="h-4 w-4" />
        </Link>
      </section>

      {/* Token mechanics */}
      <section className="border-y border-border bg-surface">
        <div className="home-container home-section">
          <SectionHeader
            eyebrow="Token mechanics"
            title={`How ${B} moves`}
            description={`${B} uses ${BRAND.decimals} decimals and does not earn yield on its own. Planned flows below are not live on mainnet.`}
          />
          <ol className="home-steps mt-10 grid gap-6 md:grid-cols-3">
            {[
              {
                h: "Mint",
                d: `Deposited value enters the reserve and an equal amount of ${B} is issued, referenced 1:1 to USD.`,
              },
              {
                h: "Hold or transfer",
                d: `${B} is a standard Cardano native token. Holding it earns nothing; its purpose is a stable unit of account.`,
              },
              {
                h: "Redeem",
                d: `Redemptions are processed through a daily queue and paid from cash, money-market funds and short investment-grade holdings — never by selling credit or marketplace assets.`,
              },
            ].map((s, i) => (
              <li key={s.h} className="home-step home-card p-6">
                <span className="home-step-num">{i + 1}</span>
                <h3 className="mt-4 font-display text-lg font-semibold">{s.h}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <ArrowDownUp className="h-4 w-4 text-teal" aria-hidden="true" />
            Stake {B} to receive {S}; unstake {S} to return to {B}.
          </div>
        </div>
      </section>

      {/* sTSRA */}
      <section className="home-container home-section">
        <SectionHeader
          eyebrow={`Staked ${BRAND.productName}`}
          title={`What ${S} is, and how it earns`}
          description={`${S} is a claim on staked ${B} plus its share of reserve yield. Rates are always a target and variable; stakers also share in losses before ${B} holders.`}
        />
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="home-card p-6">
            <div className="flex items-center gap-2">
              <Timer className="h-5 w-5 text-teal" />
              <h3 className="font-display text-lg font-semibold">Flexible</h3>
            </div>
            <StatusPill status="illustrative" className="mt-3" />
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              4.5% illustrative target, variable. Unstaking starts a 7-day cooldown (protocol bounds
              7–14 days). No yield accrues while cooling down, but the position still shares losses.
            </p>
          </div>
          <div className="home-card p-6">
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-teal" />
              <h3 className="font-display text-lg font-semibold">Locked</h3>
            </div>
            <StatusPill status="illustrative" className="mt-3" />
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              A 30-day position (not a separate token) with a 1.25× yield weight, capped at 1.5×.
              Only the owner can unlock once the term ends.
            </p>
          </div>
        </div>
        <ul className="mt-6 grid gap-3 text-sm text-muted-foreground md:grid-cols-3">
          <li className="home-card p-5">
            <StatusPill status="illustrative" className="mb-2" />
            <p>Yield is credited gradually over 7 days, not in one lump.</p>
          </li>
          <li className="home-card p-5">
            <StatusPill status="illustrative" className="mb-2" />
            <p>
              The protocol keeps 12.5% of yield (capped at 20%); half goes to the first-loss
              reserve. It never takes principal.
            </p>
          </li>
          <li className="home-card p-5">
            Staking may require an eligibility check before it is available.
          </li>
        </ul>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/stake"
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Try the staking preview <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/transparency"
            className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:border-teal"
          >
            <ShieldCheck className="h-4 w-4 text-teal" /> How your money is protected
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
