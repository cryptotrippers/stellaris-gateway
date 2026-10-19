import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingNav } from "@/components/layout/MarketingNav";
import { MarketingFooter } from "@/components/layout/MarketingFooter";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { StatusPill } from "@/components/brand/StatusPill";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About Stellaris Finance · Real-world assets on Cardano" },
      {
        name: "description",
        content:
          "Stellaris Finance is building a transparent gateway to real-world assets on Cardano. Currently a Preprod testnet preview.",
      },
      { property: "og:title", content: "About Stellaris Finance" },
      {
        property: "og:description",
        content: "What Stellaris is building, where it stands today and what is still pending.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AboutPage,
});

const STAGE = [
  { label: "Smart contracts on Cardano Preprod (test network)", status: "published" as const },
  { label: "Independent security audit", status: "pending" as const },
  { label: "Live, real-money offerings", status: "pending" as const },
  { label: "Team and company details on this page", status: "pending" as const },
];

function AboutPage() {
  return (
    <div className="home-page min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main className="home-container space-y-16 py-16">
        <SectionHeader
          eyebrow="About"
          title="Know what you hold. Understand what backs it. See where the risks sit."
          description="Stellaris Finance is building a transparent gateway to real-world assets on Cardano. That promise is something we aim to earn through structure, documentation and verification, product by product."
        />
        <section aria-labelledby="stage">
          <h2 id="stage" className="font-display text-xl font-semibold">
            Where we are today
          </h2>
          <ul className="mt-5 divide-y divide-border rounded-2xl border border-border bg-surface">
            {STAGE.map((s) => (
              <li key={s.label} className="flex items-center justify-between gap-4 px-5 py-4 text-sm">
                <span>{s.label}</span>
                <StatusPill status={s.status} />
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-2xl border border-border bg-surface p-6">
          <h2 className="font-display text-xl font-semibold">Talk to us</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Have an asset you'd like to bring on chain? Start with the{" "}
            <Link to="/funding" className="font-medium text-primary underline-offset-4 hover:underline">
              issuer page
            </Link>
            . For how the platform works and its risks, see{" "}
            <Link to="/transparency" className="font-medium text-primary underline-offset-4 hover:underline">
              Transparency
            </Link>
            .
          </p>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
