import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Sparkles, Zap, ArrowLeft } from "lucide-react";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";

export const Route = createFileRoute("/upgrade")({
  head: () => ({
    meta: [
      { title: "Upgrade to Pro — Stellaris Finance" },
      { name: "description", content: "Unlock advanced analytics, full API access, and governance perks with Stellaris Pro." },
      { property: "og:title", content: "Upgrade to Stellaris Pro" },
      { property: "og:description", content: "Advanced analytics, API access, and governance perks — $19/month." },
    ],
  }),
  component: UpgradePage,
});

type Interval = "monthly" | "yearly";

const BASIC_FEATURES = [
  "Portfolio & marketplace access",
  "Standard yield engine",
  "Community governance voting",
  "Wallet & staking",
];

const PRO_FEATURES = [
  "Everything in Basic",
  "Full REST & GraphQL API access",
  "Advanced analytics & exports",
  "Priority governance proposals",
  "Real-time yield alerts & webhooks",
  "Priority support",
];

function UpgradePage() {
  const [interval, setInterval] = useState<Interval>("monthly");
  const [checkingOut, setCheckingOut] = useState(false);

  const priceId = interval === "monthly" ? "pro_monthly" : "pro_yearly";
  const returnUrl = typeof window !== "undefined"
    ? `${window.location.origin}/upgrade/return?session_id={CHECKOUT_SESSION_ID}`
    : undefined;

  return (
    <div className="min-h-screen bg-background">
      <PaymentTestModeBanner />
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-6 md:py-14">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        {!checkingOut ? (
          <>
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent-foreground mb-4">
                <Sparkles className="h-3.5 w-3.5 text-accent" />
                Upgrade your account
              </div>
              <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
                Go Pro on Stellaris
              </h1>
              <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
                Unlock the full API, advanced analytics, and priority governance access. Cancel anytime.
              </p>

              <div className="mt-6 inline-flex rounded-full border border-border bg-surface p-1">
                <IntervalToggle active={interval === "monthly"} onClick={() => setInterval("monthly")}>
                  Monthly
                </IntervalToggle>
                <IntervalToggle active={interval === "yearly"} onClick={() => setInterval("yearly")}>
                  Yearly <span className="ml-1 text-accent">−17%</span>
                </IntervalToggle>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <PlanCard
                name="Basic"
                tagline="Your current plan"
                price="Free"
                priceSuffix=""
                features={BASIC_FEATURES}
                current
              />
              <PlanCard
                name="Pro"
                tagline="Advanced tools for serious users"
                price={interval === "monthly" ? "$19" : "$190"}
                priceSuffix={interval === "monthly" ? "/month" : "/year"}
                features={PRO_FEATURES}
                highlighted
                ctaLabel="Upgrade to Pro"
                onCta={() => setCheckingOut(true)}
              />
            </div>

            <p className="mt-6 text-center text-xs text-muted-foreground">
              Secure checkout by Stripe. Prices in USD. Applicable taxes calculated at checkout.
            </p>
          </>
        ) : (
          <div>
            <button
              onClick={() => setCheckingOut(false)}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to plans
            </button>
            <div className="rounded-2xl border border-border bg-surface p-4 md:p-6">
              <h2 className="text-xl font-semibold text-foreground mb-1">
                Complete your upgrade
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Stellaris Pro — {interval === "monthly" ? "$19/month" : "$190/year"}
              </p>
              <StripeEmbeddedCheckout priceId={priceId} returnUrl={returnUrl} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IntervalToggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function PlanCard({
  name, tagline, price, priceSuffix, features, highlighted, current, ctaLabel, onCta,
}: {
  name: string;
  tagline: string;
  price: string;
  priceSuffix: string;
  features: string[];
  highlighted?: boolean;
  current?: boolean;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div
      className={`relative rounded-2xl border p-6 ${
        highlighted
          ? "border-accent/60 bg-gradient-to-b from-accent/10 to-surface shadow-lg shadow-accent/10"
          : "border-border bg-surface"
      }`}
    >
      {highlighted && (
        <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-semibold text-accent-foreground">
          <Zap className="h-3 w-3" />
          RECOMMENDED
        </div>
      )}
      <h3 className="text-lg font-semibold text-foreground">{name}</h3>
      <p className="text-sm text-muted-foreground mt-0.5">{tagline}</p>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-foreground">{price}</span>
        {priceSuffix && <span className="text-sm text-muted-foreground">{priceSuffix}</span>}
      </div>

      <ul className="mt-5 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-foreground/90">
            <Check className={`h-4 w-4 mt-0.5 shrink-0 ${highlighted ? "text-accent" : "text-muted-foreground"}`} />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {current ? (
          <button
            disabled
            className="w-full rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-muted-foreground cursor-default"
          >
            Current plan
          </button>
        ) : (
          <button
            onClick={onCta}
            className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {ctaLabel}
          </button>
        )}
      </div>
    </div>
  );
}
