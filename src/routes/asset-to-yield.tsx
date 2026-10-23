import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { DemoFrame } from "@/components/brand/DemoFrame";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { Button } from "@/components/ui/button";
import { AllocationBreakdown, YieldWaterfall } from "@/components/finance/YieldWaterfall";
import {
  ActualVsForecast,
  DistributionStatusLegend,
  DistributionTimeline,
  PerUnitSummary,
  ScenarioCards,
  SensitivityTable,
} from "@/components/finance/DistributionViews";
import { EscrowFlowDiagram, EscrowStatusPanel, MilestoneReleaseList } from "@/components/finance/EscrowViews";
import { money, pct } from "@/components/finance/format";
import {
  ALPHA_ALLOCATION,
  ALPHA_BASE_SCENARIO,
  ALPHA_DISTRIBUTIONS,
  ALPHA_EXTRA_SCENARIOS,
  ALPHA_FORECAST,
  ALPHA_PER_UNIT,
  ALPHA_RESERVE,
  ALPHA_SENSITIVITY,
  ALPHA_WATERFALL,
  SOLAR_FARM_ALPHA,
} from "@/data/asset-yield.illustrative";

const TITLE = "Asset-to-Yield Engine (demo) · Stellaris";
const DESCRIPTION =
  "See how real-world operating revenue would become approved distributable cash: a revenue waterfall, reserves, per-unit distributions and escrow, shown with an illustrative example.";

export const Route = createFileRoute("/asset-to-yield")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AssetToYield,
});

function AssetToYield() {
  const a = SOLAR_FARM_ALPHA;
  return (
    <MarketingLayout>
      <section className="home-container py-14 md:py-20">
        <div className="flex flex-wrap gap-2">
          <FeatureStatus stage="demo" />
          <FeatureStatus stage="awaiting_backend" />
        </div>
        <div className="mt-4">
          <SectionHeader
            eyebrow="Asset-to-Yield Engine"
            title="From operating revenue to the cash each unit receives."
            description="The engine that calculates real distributions is still being built and verified. Until it exists, this page shows how results will be presented, using one clearly labelled example."
          />
        </div>

        <div className="mt-10">
          <DemoFrame>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Example project</p>
                <h2 className="font-display text-2xl font-semibold text-foreground">{a.name}</h2>
                <p className="text-sm text-muted-foreground">Not a real project. Not platform performance.</p>
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <Fact label="Funding" value={money(a.funding, a.currency)} />
                <Fact label="Units" value={a.units.toLocaleString("en-AU")} />
                <Fact label="Issue price" value={`${money(a.issuePrice, a.currency)} / unit`} />
              </dl>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
              <YieldWaterfall data={ALPHA_WATERFALL} />
              <div className="grid gap-5">
                <PerUnitSummary data={ALPHA_PER_UNIT} />
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <AllocationBreakdown
                items={ALPHA_ALLOCATION}
                currency={a.currency}
                title="Where the revenue goes"
                caption="Operating expenses, debt, tax and fees are combined as one cash deduction in this example — no itemised breakdown was provided."
              />
              <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
                <p className="font-display text-base font-semibold text-foreground">Reserve contribution</p>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <Fact label="Amount" value={money(ALPHA_RESERVE.amount, a.currency)} />
                  <Fact label="Share of revenue" value={pct(ALPHA_RESERVE.shareOfRevenuePct)} />
                  <Fact label="Per unit" value={money(ALPHA_RESERVE.perUnit, a.currency)} />
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">
                  Reserves are cash held back before distribution — for maintenance, replacements
                  and income shortfalls. They are not paid to unit holders in the year they are set aside.
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <ActualVsForecast points={ALPHA_FORECAST} currency={a.currency} />
              <DistributionTimeline events={ALPHA_DISTRIBUTIONS} currency={a.currency} />
            </div>

            <div className="mt-5">
              <p className="mb-3 font-display text-base font-semibold text-foreground">Scenario comparison</p>
              <ScenarioCards
                scenarios={[ALPHA_BASE_SCENARIO, ...ALPHA_EXTRA_SCENARIOS]}
                currency={a.currency}
                pendingNote="Downside and upside scenarios will be produced by the approved calculation engine. No other scenarios are shown so that none are invented."
              />
            </div>
            <div className="mt-5">
              <SensitivityTable
                rows={ALPHA_SENSITIVITY}
                currency={a.currency}
                pendingNote="Sensitivity to revenue, cost and interest-rate changes will appear once the approved engine can calculate it. Waiting for backend."
              />
            </div>
          </DemoFrame>
        </div>

        <div className="mt-14">
          <SectionHeader
            eyebrow="Distribution status"
            title="Forecast is not money in your account."
            description="Every distribution carries one of four labels. Only Paid means cash has actually moved, and only with a confirmed transaction reference."
          />
          <div className="mt-6">
            <DistributionStatusLegend />
          </div>
        </div>

        <div className="mt-14">
          <SectionHeader
            eyebrow="Escrow and releases"
            title="Subscriptions, releases, reserves and distributions kept apart."
            description="The escrow and milestone-release services are proposed. They stay non-operational on this site until they are built and verified."
          />
          <div className="mt-6 grid gap-5">
            <EscrowFlowDiagram />
            <div className="grid gap-5 lg:grid-cols-2">
              <EscrowStatusPanel current={null} />
              <MilestoneReleaseList milestones={[]} />
            </div>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/marketplace">
              Explore assets <ArrowRight />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/trust">Trust Centre</Link>
          </Button>
        </div>
      </section>
    </MarketingLayout>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card px-3 py-2 ring-1 ring-border">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="number-display font-semibold text-foreground">{value}</dd>
    </div>
  );
}
