import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { Timeline } from "@/components/brand/Timeline";
import { FeatureStatus } from "@/components/brand/FeatureStatus";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({
    meta: [
      { title: "How It Works · Stellaris Finance" },
      {
        name: "description",
        content:
          "How real-world asset projects move from enquiry through review, funding, operations and exit on Stellaris. Testnet preview.",
      },
      { property: "og:title", content: "How It Works · Stellaris Finance" },
      {
        property: "og:description",
        content: "The Stellaris project lifecycle, its review gates and what is live today.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HowItWorks,
});

const STAGES = [
  { title: "Enquiry", text: "An issuer describes the project and organisation.", stage: "verified" as const },
  { title: "Issuer KYB", text: "The organisation's identity and control are checked.", stage: "awaiting_backend" as const, gate: "Gate A: Issuer verified" },
  { title: "Private data room", text: "Evidence is shared privately with reviewers.", stage: "awaiting_backend" as const },
  { title: "Independent review", text: "Legal, technical and financial evidence is assessed.", stage: "awaiting_backend" as const },
  { title: "Offering documents", text: "Rights, fees, risks and exit terms are written down.", stage: "awaiting_legal" as const, gate: "Gate B: Listing approval" },
  { title: "Fundraising", text: "Participants subscribe; funds are held until conditions are met.", stage: "awaiting_backend" as const },
  { title: "Milestone releases", text: "Capital is released only against approved milestones.", stage: "awaiting_backend" as const, gate: "Gate C: Funding conditions met · Gate D: Milestone release approved" },
  { title: "Operating and reporting", text: "The asset reports income, costs and material events.", stage: "awaiting_backend" as const },
  { title: "Exit", text: "Units are redeemed or the project winds down under its terms.", stage: "awaiting_legal" as const },
];

function HowItWorks() {
  return (
    <MarketingLayout>
      <section className="home-container py-14 md:py-20">
        <SectionHeader
          eyebrow="How it works"
          title="From real-world project to reviewed, reported asset."
          description="Each project follows the same nine stages. Gates are decided on the server by reviewers, never by the page. Labels show what is actually live on the Cardano Preprod testnet today."
        />
        <div className="mt-10 max-w-3xl rounded-2xl border border-border bg-card p-6 md:p-8">
          <Timeline
            items={STAGES.map((s) => ({
              title: s.title,
              description: s.text,
              state: "upcoming",
              gate: s.gate,
              meta: <FeatureStatus stage={s.stage} />,
            }))}
          />
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          <Button asChild>
            <Link to="/marketplace">
              Explore assets <ArrowRight />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/for-issuers">For issuers</Link>
          </Button>
        </div>
      </section>
    </MarketingLayout>
  );
}
