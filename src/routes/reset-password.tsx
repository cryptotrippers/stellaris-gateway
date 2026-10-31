import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, KeyRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { useAccountSession } from "@/components/auth/AccountSession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authErrorMessage, withTimeout } from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
  head: () => ({ meta: [
    { title: "Choose a new password · Stellaris Finance" }, { name: "description", content: "Update your Stellaris password using an authorized recovery link." },
    { property: "og:title", content: "Choose a new password · Stellaris Finance" }, { property: "og:description", content: "Secure password recovery for your Stellaris account." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }, { name: "robots", content: "noindex" },
  ] }),
});
function ResetPasswordPage() {
  const account = useAccountSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (query.has("error") || fragment.has("error") || fragment.has("error_code")) setExpired(true);
    const timer = setTimeout(() => setExpired(true), 20_000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (account.recovery && account.user) {
      setExpired(false);
      window.history.replaceState(window.history.state, "", "/reset-password");
    }
  }, [account.recovery, account.user]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current || !account.recovery || !account.user) return;
    if (password !== confirm) { setError("Passwords do not match."); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      // The Auth server verifies the recovery session. No current_password on recovery.
      const { error } = await withTimeout(supabase.auth.updateUser({ password }));
      if (error) throw error;
      setDone(true); setPassword(""); setConfirm("");
    } catch (err) { setError(authErrorMessage(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  const authorized = account.recovery && !!account.user && !expired;
  return <AccountFrame title="A fresh start" subtitle="Choose a new, unique password with your secure recovery link. No wallet signature is involved.">
    {done ? <div className="space-y-5"><h2 className="text-xl font-semibold tracking-normal">Password updated</h2><p role="status" className="text-sm text-muted-foreground">Your new password is ready. You can continue to your account.</p><Button onClick={() => void navigate({ to: "/app", replace: true })} className="min-h-11 w-full">Continue to account</Button></div> : authorized ? <>
      <h2 className="text-xl font-semibold tracking-normal">Choose your new password</h2>
      <form onSubmit={submit} className="mt-6 space-y-5" aria-busy={busy}>
        <div className="space-y-2"><Label htmlFor="new-password">New password</Label><Input id="new-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} className="h-12" /><p className="text-xs text-muted-foreground">At least 8 characters.</p></div>
        <div className="space-y-2"><Label htmlFor="confirm-password">Confirm new password</Label><Input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} className="h-12" /></div>
        <Button type="submit" disabled={busy} className="h-12 w-full">{busy ? <Loader2 className="animate-spin" /> : <KeyRound />}{busy ? "Updating…" : "Update password"}</Button>
      </form>{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    </> : account.loading && !expired ? <p role="status" className="flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin" />Checking recovery link…</p> : <div className="space-y-5"><h2 className="text-xl font-semibold tracking-normal">Request a new recovery link</h2><p role="alert" className="text-sm leading-6 text-muted-foreground">This link is missing, expired or already used. A valid recovery email is required before you can change your password.</p><Button asChild className="min-h-11 w-full"><Link to="/forgot-password">Send a new recovery link</Link></Button><Button asChild variant="link" className="min-h-11"><Link to="/auth" search={{ mode: "signin", redirect: "/app" }}>Return to sign in</Link></Button></div>}
  </AccountFrame>;
}
