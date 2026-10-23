import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Building2, FileCheck2, Layers, ShieldCheck } from "lucide-react";
import { MarketingLayout } from "@/components/layout/MarketingLayout";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { Button } from "@/components/ui/button";
import { IssuerEnquiryForm } from "@/components/issuers/IssuerEnquiryForm";
import energyImage from "@/assets/home-energy.jpg";

export const Route = createFileRoute("/for-issuers")({
  head: () => ({
    meta: [
      { title: "For Issuers · Stellaris Real-World Asset Onboarding" },
      {
        name: "description",
        content:
          "Explore real-world asset onboarding with Stellaris: issuer eligibility, evidence, governance and Cardano Preprod testing. Submit a private project enquiry.",
      },
      { property: "og:title", content: "For Issuers · Stellaris" },
      {
        property: "og:description",
        content:
          "Bring an asset project to an evidence-led onboarding process. Explore eligibility and enquire about Cardano Preprod testing, without a promise of funding.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ForIssuersPage,
});

function ForIssuersPage() {
  return (
    <MarketingLayout>
      <section className="relative isolate overflow-hidden">
        <img
          src={energyImage}
          alt="Rooftop solar panels, an example of a real-world asset category"
          className="absolute inset-0 -z-20 h-full w-full object-cover"
        />
        <div className="home-hero-veil absolute inset-0 -z-10" />
        <div className="home-container py-14 md:py-16">
          <p className="home-eyebrow">Stellaris · For Issuers</p>
          <h1 className="mt-4 max-w-xl text-4xl font-semibold leading-tight md:text-5xl">
            Real-world asset onboarding.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground">
            For asset owners, project developers and operators exploring fractional ownership on
            Cardano. Start with the asset, the evidence and the legal structure.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="#enquire">
                Discuss your project <ArrowRight />
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/pipeline">View the project pipeline</Link>
            </Button>
          </div>
          <p className="mt-6 max-w-lg text-xs leading-relaxed text-muted-foreground">
            Cardano Preprod only. No real-money fundraising is available. An enquiry does not
            guarantee eligibility, a listing or funding. Image is illustrative.
          </p>
        </div>
      </section>

      <section className="home-container home-section">
        <SectionHeader
          eyebrow="From asset to evidence"
          title="A clearer path for your project"
          description="Keep issuer documentation, project review and on-chain testing connected — without treating a submitted claim as an approval."
        />
        <div className="mt-10 grid gap-8 md:grid-cols-3">
          {[
            {
              Icon: Building2,
              title: "Issuer & asset profile",
              text: "Record the entity, project jurisdiction, legal wrapper and underlying asset before a proposal reaches governance.",
            },
            {
              Icon: FileCheck2,
              title: "Evidence-led review",
              text: "Organise title or lease evidence, licences where applicable, insurance, revenue agreements and impact methodology.",
            },
            {
              Icon: Layers,
              title: "Preprod testing",
              text: "Explore the existing funding, governance and vault workflows with test assets. Mainnet access remains gated.",
            },
          ].map(({ Icon, title, text }) => (
            <article key={title} className="border-t border-border pt-6">
              <Icon className="h-6 w-6 text-teal" />
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="protocol">
        <div className="home-container home-section">
          <p className="text-xs font-semibold uppercase text-gold">Eligibility & process</p>
          <h2 className="mt-4 text-3xl font-semibold">Evidence first. Approval is separate.</h2>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Legal suitability depends on the asset, structure and jurisdiction. Stellaris does not
            claim regulatory approval or that every project can be accepted.
          </p>
          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [
                "Initial enquiry",
                "Describe the asset, organisation, jurisdiction and stage. No wallet or sensitive documents needed.",
              ],
              [
                "Issuer & legal review",
                "Establish who owns or operates the asset and what legal wrapper and approvals would be needed.",
              ],
              [
                "Evidence & proposal",
                "Submit a formal funding request with documentation. Verification status and governance consideration remain distinct.",
              ],
              [
                "Governance & testing",
                "Approval precedes operator setup on Preprod. A vault transaction is not proof of legal ownership or regulatory permission.",
              ],
            ].map(([title, text], i) => (
              <li key={title} className="border-t border-border pt-5">
                <span className="text-sm font-semibold text-aqua">0{i + 1}</span>
                <h3 className="mt-4 text-base font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex items-start gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
            <ShieldCheck className="h-5 w-5 shrink-0 text-aqua" />
            <p>
              No guaranteed raise, returns or acceptance. Do not send funds as part of an enquiry.
            </p>
          </div>
        </div>
      </section>

      <section id="enquire" className="home-container home-section scroll-mt-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <SectionHeader
              eyebrow="Start a conversation"
              title="Tell us about your asset"
              description="A private initial enquiry for asset owners and operators. Formal requests and evidence follow a separate process."
            />
            <div className="mt-8 border-t border-border pt-6">
              <p className="text-sm font-semibold">Ready to prepare a formal request?</p>
              <Button asChild variant="link" className="mt-2 px-0">
                <Link to="/funding/new">
                  Open issuer onboarding <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
          <IssuerEnquiryForm />
        </div>
        <div className="mt-12 flex flex-wrap justify-between gap-4 border-t border-border pt-5 text-xs text-muted-foreground">
          <Link to="/terms" className="hover:underline">
            Terms & risk disclosures
          </Link>
          <Link to="/issuer-leads" className="hover:underline">
            Issuer enquiry management · administrators
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
