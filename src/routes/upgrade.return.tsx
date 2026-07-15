import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/upgrade/return")({
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  head: () => ({
    meta: [{ title: "Welcome to Pro — Stellaris Finance" }],
  }),
  component: UpgradeReturn,
});

function UpgradeReturn() {
  const { session_id: sessionId } = Route.useSearch();

  return (
    <div className="min-h-screen bg-background grid place-items-center px-4">
      <div className="max-w-md w-full rounded-2xl border border-border bg-surface p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-accent/15 mb-4">
          <CheckCircle2 className="h-8 w-8 text-accent" />
        </div>
        {sessionId ? (
          <>
            <h1 className="text-2xl font-bold text-foreground">You're Pro now</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your subscription is active. A receipt has been sent to your email.
            </p>
            <p className="mt-3 text-[11px] font-mono text-muted-foreground break-all">
              {sessionId}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-foreground">Thanks!</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We couldn't find a checkout session, but if you completed payment your account will update shortly.
            </p>
          </>
        )}
        <div className="mt-6 flex flex-col gap-2">
          <Link
            to="/"
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Go to portfolio
          </Link>
          <Link
            to="/developers"
            className="rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-secondary transition-colors"
          >
            Explore developer API
          </Link>
        </div>
      </div>
    </div>
  );
}
