import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { findTopic, LEARN_TOPICS } from "@/lib/learn-content";

export const Route = createFileRoute("/learn/$topic")({
  head: ({ params }) => {
    const topic = findTopic(params.topic);
    const title = topic ? `${topic.title} | Stellaris Learn` : "Unavailable | Stellaris Learn";
    const description =
      topic?.summary ??
      "Plain-language guides to tokenised real-world asset vaults on Cardano.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        ...(topic ? [] : [{ name: "robots", content: "noindex" }]),
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "article" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  loader: ({ params }) => {
    if (!findTopic(params.topic)) throw notFound();
  },
  notFoundComponent: TopicNotFound,
  component: TopicPage,
});

function TopicPage() {
  const { topic: slug } = Route.useParams();
  const topic = findTopic(slug)!;
  const others = LEARN_TOPICS.filter((t) => t.slug !== topic.slug).slice(0, 3);

  return (
    <AppShell>
      <Link
        to="/learn"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> All guides
      </Link>

      <article className="mt-4 max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{topic.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {topic.summary} · {topic.minutes} min read
        </p>

        {topic.sections.map((s) => (
          <section key={s.heading} className="mt-8">
            <h2 className="text-base font-medium text-foreground">{s.heading}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </article>

      <section className="mt-12 max-w-3xl">
        <h2 className="text-sm font-medium text-foreground">Keep reading</h2>
        <ul className="mt-3 space-y-2">
          {others.map((t) => (
            <li key={t.slug}>
              <Link
                to="/learn/$topic"
                params={{ topic: t.slug }}
                className="text-sm text-primary hover:underline"
              >
                {t.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </AppShell>
  );
}

function TopicNotFound() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold text-foreground">Guide not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That guide does not exist.{" "}
        <Link to="/learn" className="text-primary underline">
          See all guides
        </Link>
        .
      </p>
    </AppShell>
  );
}
