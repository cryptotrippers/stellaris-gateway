import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowRight, Info } from "lucide-react";
import heroImg from "@/assets/marketplace-hero.jpg";
import { Button } from "@/components/ui/button";
import { TESTNET_DISCLOSURE } from "@/components/brand/DisclosureBanner";

/** "Tangible future" hero: photography with a navy wash and live product status. */
export function MarketplaceHero({
  listings,
  demos,
  loading,
}: {
  listings: number;
  demos: number;
  loading: boolean;
}) {
  return (
    <section className="protocol relative isolate overflow-hidden rounded-3xl border border-border">
      <img
        src={heroImg}
        alt=""
        width={1920}
        height={1088}
        className="absolute inset-0 -z-10 h-full w-full object-cover"
      />
      <div
        className="absolute inset-0 -z-10 bg-gradient-to-r from-background via-background/85 to-background/10"
        aria-hidden="true"
      />
      <div className="px-6 py-14 md:px-12 md:py-20 lg:py-24">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-aqua">
          Real-world assets · Powered by Cardano
        </p>
        <h1 className="mt-4 max-w-2xl font-display text-4xl font-semibold leading-[1.08] text-foreground md:text-5xl lg:text-[3.5rem]">
          Discover the real-world assets behind tomorrow&apos;s opportunities.
        </h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          Explore the people, projects and financial structures behind tokenised real-world assets.
          Understand ownership, risks and income before taking part.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg" className="h-12 px-6">
            <a href="#assets">
              Explore Assets <ArrowDown />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-12 px-6">
            <Link to="/how-it-works">
              How It Works <ArrowRight />
            </Link>
          </Button>
        </div>

        <dl className="mt-10 grid max-w-3xl gap-3 sm:grid-cols-3">
          <StatusTile label="Network" value="Cardano Preprod" sub="Testnet — test ADA only" />
          <StatusTile label="Real-money offerings" value="None open" sub="Waiting for legal approval" />
          <StatusTile
            label="Listings in registry"
            value={loading ? "…" : String(listings)}
            sub={loading ? "Reading the registry" : `${demos} of them demo listings`}
          />
        </dl>
        <p className="mt-6 flex max-w-2xl items-start gap-2 rounded-xl border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
          {TESTNET_DISCLOSURE}
        </p>
      </div>
    </section>
  );
}

function StatusTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/70 px-4 py-3 backdrop-blur-sm">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-display text-lg font-semibold text-foreground">{value}</dd>
      <dd className="text-xs text-muted-foreground">{sub}</dd>
    </div>
  );
}
