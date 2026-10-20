import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import { MarketingNav } from "@/components/layout/MarketingNav";
import { MarketingFooter } from "@/components/layout/MarketingFooter";

// Streaming chat is client-only: never painted by SSR (see AssistantChat).
const AssistantChat = lazy(() => import("@/components/assistant/AssistantChat"));

export const Route = createFileRoute("/ask")({
  head: () => ({
    meta: [
      { title: "Ask Stellaris · Questions about reserves, staking and exit rules" },
      {
        name: "description",
        content:
          "Ask a plain-English question about how Stellaris works: the reserve model, staking cooldowns, who absorbs a loss first, and what is still pending. Preprod testnet preview.",
      },
      { property: "og:title", content: "Ask Stellaris" },
      {
        property: "og:description",
        content:
          "A helper that answers only from what this site already publishes — reserves, staking rules, protections and what is still pending.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AskPage,
});

function AskPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="home-page flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav />
      <main className="home-container flex flex-1 flex-col gap-6 py-12">
        <header className="max-w-2xl">
          <p className="home-eyebrow">Ask Stellaris</p>
          <h1 className="mt-3 font-display text-3xl font-semibold leading-tight md:text-4xl">
            Ask anything about how this works
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground md:text-base">
            The helper answers only from what this site already publishes — the reserve model,
            staking rules, who absorbs a loss first, and what is still pending. If something
            isn&apos;t published yet, it says so rather than guessing. Not financial advice.
          </p>
        </header>

        {mounted && (
          <Suspense
            fallback={
              <div className="home-card flex h-[62vh] min-h-[420px] items-center justify-center text-sm text-muted-foreground">
                Loading the assistant…
              </div>
            }
          >
            <AssistantChat />
          </Suspense>
        )}

        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          This is a testnet preview. Nothing here is financial, legal or tax advice, and no
          real-money offering is available. Rates shown on this site are illustrative targets, not
          promises. For the full picture see{" "}
          <Link to="/terms" className="text-primary underline-offset-4 hover:underline">
            terms &amp; risk
          </Link>
          .
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}
