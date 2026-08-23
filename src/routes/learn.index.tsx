import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { LEARN_TOPICS } from "@/lib/learn-content";

const TITLE = "Learn — tokenised real-world assets on Cardano | Stellaris";
const DESCRIPTION =
  "Short, plain-language guides: what a tokenised asset vault is, how deposits and shares work, what governance controls, why this runs on Preprod, and how to connect a Cardano wallet safely.";

export const Route = createFileRoute("/learn/")({
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
  component: LearnIndex,
});

function LearnIndex() {
  return (
    <AppShell>
      <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight text-foreground">
        <BookOpen className="h-6 w-6 text-muted-foreground" /> Learn
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Five short reads that cover everything you need before allocating anything — including the
        parts most platforms leave out.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {LEARN_TOPICS.map((t) => (
          <article key={t.slug} className="card-institutional p-5">
            <h2 className="text-base font-medium text-foreground">
              <Link to="/learn/$topic" params={{ topic: t.slug }} className="hover:text-primary">
                {t.title}
              </Link>
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">{t.summary}</p>
            <Link
              to="/learn/$topic"
              params={{ topic: t.slug }}
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-primary"
            >
              Read · {t.minutes} min <ArrowRight className="h-3 w-3" />
            </Link>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
