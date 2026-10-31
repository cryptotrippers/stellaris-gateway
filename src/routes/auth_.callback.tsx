import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, CircleAlert } from "lucide-react";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { useAccountSession } from "@/components/auth/AccountSession";
import { Button } from "@/components/ui/button";
import { safeAuthReturn } from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/auth_/callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeAuthReturn(search.redirect),
    error: typeof search.error === "string" ? search.error : undefined,
    code: typeof search.code === "string" ? search.code : undefined,
    error_code: typeof search.error_code === "string" ? search.error_code : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
  }),
  component: AuthCallbackPage,
  head: () => ({
    meta: [
      { title: "Confirm account access · Stellaris Finance" },
      { name: "description", content: "Complete your secure Stellaris account return." },
      { property: "og:title", content: "Confirm account access · Stellaris Finance" },
      {
        property: "og:description",
        content: "Complete account confirmation or securely return to sign in.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});
function AuthCallbackPage() {
  const account = useAccountSession();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [failed, setFailed] = useState(false);
  const completed = useRef(false);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (search.error || search.error_code || fragment.has("error") || fragment.has("error_code")) {
      setFailed(true);
      // Remove sensitive fragments and codes after the client has processed its return.
      window.history.replaceState(window.history.state, "", "/auth/callback");
      return;
    }
    const timer = setTimeout(() => setFailed(true), 20_000);
    return () => clearTimeout(timer);
  }, [search.error, search.error_code]);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (
      failed ||
      search.error ||
      search.error_code ||
      fragment.has("error") ||
      fragment.has("error_code") ||
      account.loading ||
      !account.user ||
      completed.current
    )
      return;
    completed.current = true;
    let destination = search.redirect;
    try {
      const saved = sessionStorage.getItem("stellaris:auth:return");
      if (saved) destination = safeAuthReturn(saved);
      sessionStorage.removeItem("stellaris:auth:return");
    } catch {
      /* A blocked storage API falls back to the validated query. */
    }
    void navigate({ to: account.recovery ? "/reset-password" : destination, replace: true });
  }, [
    account.loading,
    account.user,
    account.recovery,
    failed,
    navigate,
    search.redirect,
    search.error,
    search.error_code,
  ]);
  const unavailable = failed || (!account.loading && !account.user);
  return (
    <AccountFrame
      title={unavailable ? "Let’s try again" : "Confirming your account"}
      subtitle="Your secure return is checked before any account access is granted."
    >
      {unavailable ? (
        <div className="space-y-5">
          <CircleAlert className="h-8 w-8 text-teal" aria-hidden="true" />
          <h2 className="text-xl font-semibold tracking-normal">
            This sign-in link is unavailable
          </h2>
          <p role="alert" className="text-sm leading-6 text-muted-foreground">
            It may have expired, already been used, or the sign-in was cancelled. Sign in again or
            request a fresh confirmation link.
          </p>
          <Button asChild className="min-h-11 w-full">
            <Link to="/auth" search={{ mode: "signin", redirect: search.redirect }}>
              Return to sign in
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-11 w-full">
            <Link to="/forgot-password">Request password recovery</Link>
          </Button>
        </div>
      ) : (
        <p role="status" className="flex items-center gap-3 text-sm">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
          Checking secure account access…
        </p>
      )}
    </AccountFrame>
  );
}
