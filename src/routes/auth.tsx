import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { useAccountSession } from "@/components/auth/AccountSession";
import { useAuthProviders } from "@/components/auth/useAuthProviders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  authErrorMessage,
  hasAuthReturn,
  safeAuthReturn,
  withTimeout,
} from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): { mode?: "signup" | "signin"; redirect?: string } => ({
    mode: search.mode === "signup" ? ("signup" as const) : ("signin" as const),
    redirect: safeAuthReturn(search.redirect ?? search.returnTo),
  }),
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Your account · Stellaris Finance" },
      {
        name: "description",
        content:
          "Sign in or create your Stellaris account. Account access and Cardano Preprod wallet connection are separate.",
      },
      { property: "og:title", content: "Your account · Stellaris Finance" },
      {
        property: "og:description",
        content: "Secure account access for the Stellaris Preprod experience.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function AuthPage() {
  const { mode = "signin", redirect = "/app" } = Route.useSearch();
  const navigate = useNavigate();
  const account = useAccountSession();
  const providers = useAuthProviders();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [returning, setReturning] = useState(false);
  const lock = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const signup = mode === "signup";

  useEffect(() => {
    setError(null);
    setSent(false);
    setPassword("");
  }, [mode]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (hasAuthReturn(window.location.search, window.location.hash)) {
      setReturning(true);
      void navigate({
        to: "/auth/callback",
        search: {
          redirect,
          code: new URLSearchParams(window.location.search).get("code") ?? undefined,
          error: new URLSearchParams(window.location.search).get("error") ?? undefined,
          error_code: new URLSearchParams(window.location.search).get("error_code") ?? undefined,
          type: new URLSearchParams(window.location.search).get("type") ?? undefined,
        },
        hash: window.location.hash.slice(1),
        replace: true,
      });
    } else if (account.recovery && account.user) {
      void navigate({ to: "/reset-password", replace: true });
    } else if (!account.loading && account.user && !sent && !busy) {
      void navigate({ to: redirect, replace: true });
    }
  }, [account.loading, account.user, account.recovery, navigate, redirect, sent, busy]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (signup) {
        const { data, error } = await withTimeout(
          supabase.auth.signUp({
            email: email.trim(),
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
            },
          }),
        );
        if (error) throw error;
        if (data.session) await navigate({ to: redirect, replace: true });
        else setSent(true);
      } else {
        const { error } = await withTimeout(
          supabase.auth.signInWithPassword({ email: email.trim(), password }),
        );
        if (error) throw error;
        await navigate({ to: redirect, replace: true });
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (lock.current || !email.trim()) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const { error } = await withTimeout(
        supabase.auth.resend({
          type: "signup",
          email: email.trim(),
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(redirect)}`,
          },
        }),
      );
      if (error) throw error;
      setSent(true);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function google() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      sessionStorage.setItem("stellaris:auth:return", redirect);
      const result = await withTimeout(
        lovable.auth.signInWithOAuth("google", {
          redirect_uri: `${window.location.origin}/auth/callback`,
        }),
        60_000,
      );
      if (result.error) throw result.error;
      if (!result.redirected) {
        const { data, error } = await withTimeout(supabase.auth.getUser());
        if (error || !data.user)
          throw error ?? new Error("Sign-in did not complete. Please try again.");
        sessionStorage.removeItem("stellaris:auth:return");
        await navigate({ to: redirect, replace: true });
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <AccountFrame
      title={sent ? "Check your inbox" : signup ? "Create your account" : "Welcome back"}
      subtitle={
        sent
          ? "Confirm your email to finish setting up your Stellaris account."
          : "A clear view of your projects, documents and account — with your wallet always in your control."
      }
    >
      {returning ? (
        <p role="status">Opening your secure return…</p>
      ) : (
        <>
          <div className="mb-7 flex border-b border-border" aria-label="Account access">
            <Button
              asChild
              variant="ghost"
              className="min-h-11 flex-1 rounded-none"
              aria-current={!signup ? "page" : undefined}
            >
              <Link to="/auth" search={{ mode: "signin", redirect }}>
                Sign in
              </Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              className="min-h-11 flex-1 rounded-none"
              aria-current={signup ? "page" : undefined}
            >
              <Link to="/auth" search={{ mode: "signup", redirect }}>
                Create account
              </Link>
            </Button>
          </div>
          {sent ? (
            <div className="space-y-5">
              <Mail className="h-8 w-8 text-teal" aria-hidden="true" />
              <h2 className="text-xl font-semibold tracking-normal">Verify your email</h2>
              <p role="status" className="break-words text-sm leading-6 text-muted-foreground">
                If this address can receive a confirmation, we’ve sent a link to{" "}
                <strong className="text-foreground">{email}</strong>. Check your spam folder too.
                You are not signed in until your email is confirmed.
              </p>
              <Button
                onClick={resend}
                disabled={busy}
                variant="outline"
                className="min-h-11 w-full"
              >
                {busy ? <Loader2 className="animate-spin" /> : <Mail />} Resend confirmation
              </Button>
              <Button asChild variant="link" className="min-h-11">
                <Link to="/auth" search={{ mode: "signin", redirect }}>
                  Return to sign in
                </Link>
              </Button>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold tracking-normal">
                {signup ? "Start with your email" : "Sign in to Stellaris"}
              </h2>
              <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={busy}>
                <div className="space-y-2">
                  <Label htmlFor="account-email">Email address</Label>
                  <Input
                    id="account-email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-12"
                    placeholder="you@example.com"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-password">Password</Label>
                  <div className="relative">
                    <Input
                      id="account-password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={signup ? "new-password" : "current-password"}
                      required
                      minLength={signup ? 8 : undefined}
                      maxLength={128}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="h-12 pr-12"
                      disabled={busy}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1 h-10 w-10"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  {signup && (
                    <p className="text-xs text-muted-foreground">
                      Use at least 8 characters. A unique password is recommended.
                    </p>
                  )}
                </div>
                {!signup && (
                  <Button asChild variant="link" className="min-h-11 p-0">
                    <Link to="/forgot-password">Forgot password?</Link>
                  </Button>
                )}
                <Button type="submit" disabled={busy || account.loading} className="h-12 w-full">
                  {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                  {busy ? "Please wait…" : signup ? "Create account" : "Sign in"}
                </Button>
              </form>
              {providers.google && (
                <>
                  <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />
                    or
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <Button
                    onClick={google}
                    disabled={busy || account.loading}
                    variant="outline"
                    className="h-12 w-full"
                  >
                    Continue with Google
                  </Button>
                </>
              )}
              {!signup && (
                <Button
                  onClick={resend}
                  disabled={busy || !email.trim()}
                  variant="link"
                  className="mt-3 min-h-11 px-0 text-xs"
                >
                  Need a new email confirmation?
                </Button>
              )}
            </>
          )}
          {(error || account.error) && (
            <p
              ref={errorRef}
              tabIndex={-1}
              role="alert"
              className="mt-5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error || account.error}
            </p>
          )}
          <div className="mt-8 flex items-start gap-2 border-t border-border pt-5 text-xs leading-6 text-muted-foreground">
            <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-teal" />
            No wallet signature is required to sign in.
          </div>
          <Button asChild variant="link" className="mt-2 min-h-11 px-0">
            <Link to="/wallet">
              Manage wallet connection <ArrowRight />
            </Link>
          </Button>
        </>
      )}
    </AccountFrame>
  );
}
