import { useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Mail, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, withTimeout } from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
  head: () => ({ meta: [
    { title: "Reset access · Stellaris Finance" }, { name: "description", content: "Request a secure password recovery email for your Stellaris account." },
    { property: "og:title", content: "Reset access · Stellaris Finance" }, { property: "og:description", content: "Recover access to your Stellaris account." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
});
function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      const { error } = await withTimeout(supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` }));
      if (error) throw error;
      setSent(true);
    } catch (err) { setError(authErrorMessage(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <AccountFrame title="Recover your account" subtitle="Request a secure email link to choose a new password. Your wallet connection is unaffected.">
    <h2 className="text-xl font-semibold tracking-normal">{sent ? "Check your email" : "Forgot your password?"}</h2>
    {sent && <p role="status" className="mt-4 break-words text-sm leading-6 text-muted-foreground">If an account exists for {email}, a recovery link has been sent. Open the newest email link in this browser. Check spam if it hasn’t arrived.</p>}
    <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={busy}>
      <div className="space-y-2"><Label htmlFor="recovery-email">Email address</Label><Input id="recovery-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className="h-12" /></div>
      <Button type="submit" disabled={busy} className="h-12 w-full">{busy ? <Loader2 className="animate-spin" /> : <Mail />}{busy ? "Sending…" : sent ? "Send a new link" : "Send recovery link"}</Button>
    </form>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    <Button asChild variant="link" className="mt-5 min-h-11 px-0"><Link to="/auth" search={{ mode: "signin", redirect: "/app" }}>Return to sign in</Link></Button>
  </AccountFrame>;
}
