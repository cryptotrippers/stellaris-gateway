import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { FUNDING_TERMS_SECTIONS, FUNDING_TERMS_VERSION } from "@/lib/onboarding-terms";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Platform Terms · Stellaris" },
      {
        name: "description",
        content:
          "The terms every submitter agrees to when proposing a real-world asset for funding on Stellaris: Preprod status, public accuracy requirements, and how the management fee is enforced.",
      },
      { property: "og:title", content: "Platform Terms · Stellaris" },
      { property: "og:type", content: "article" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <AppShell>
      <Link
        to="/funding"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Funding requests
      </Link>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-foreground">Platform terms</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Version <span className="font-mono">{FUNDING_TERMS_VERSION}</span>. This is what every
        submitter agrees to at <code>/funding/new</code> before a funding request is recorded.
      </p>

      <div className="mt-8 max-w-3xl space-y-6">
        {FUNDING_TERMS_SECTIONS.map((s) => (
          <section key={s.heading} className="card-institutional p-5">
            <h2 className="text-sm font-semibold text-foreground">{s.heading}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
