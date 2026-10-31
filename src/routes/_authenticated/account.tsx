import { useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { LogOut, Loader2, KeyRound, Wallet } from "lucide-react";
import { AccountFrame } from "@/components/auth/AccountFrame";
import { useAccountSession } from "@/components/auth/AccountSession";
import { useAccountSignOut } from "@/components/auth/useAccountSignOut";
import { WalletLinkCard } from "@/components/wallet/WalletLinkCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { authErrorMessage, withTimeout } from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/_authenticated/account")({
  component: AccountPage,
  head: () => ({
    meta: [
      { title: "Account & wallets · Stellaris Finance" },
      {
        name: "description",
        content: "Manage your Stellaris account access and separately verified wallets.",
      },
      { property: "og:title", content: "Account & wallets · Stellaris Finance" },
      { property: "og:description", content: "Account settings and verified wallet ownership." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
});
function AccountPage() {
  const account = useAccountSession();
  const logout = useAccountSignOut();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (password !== confirm) {
      setMessage("Passwords do not match.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await withTimeout(
        supabase.auth.updateUser({ password, current_password: current }),
      );
      if (error) throw error;
      setCurrent("");
      setPassword("");
      setConfirm("");
      setMessage("Your password has been updated.");
    } catch (err) {
      setMessage(authErrorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <AccountFrame
      title="Your Stellaris account"
      subtitle="Manage account access and keep wallet connection separate from verified ownership."
    >
      <h2 className="text-xl font-semibold tracking-normal">Account access</h2>
      <p className="mt-3 break-all text-sm text-muted-foreground">
        {account.user?.email ?? "Checking your account…"}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/app">Portfolio</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/issuer">Issuer workspace</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/security">Security settings</Link>
        </Button>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/wallet">
            <Wallet />
            Wallet connection
          </Link>
        </Button>
      </div>
      <details className="mt-6 border-y border-border py-4">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          Change password
        </summary>
        <form onSubmit={change} className="mt-4 space-y-4" aria-busy={busy}>
          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
              className="h-12"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-new-password">New password</Label>
            <Input
              id="account-new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="h-12"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-confirm-password">Confirm new password</Label>
            <Input
              id="account-confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              className="h-12"
            />
          </div>
          <Button type="submit" className="min-h-11 w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}Update password
          </Button>
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </form>
      </details>
      <div className="mt-6">
        <WalletLinkCard compact />
      </div>
      <Button
        variant="outline"
        className="mt-6 min-h-11 w-full"
        disabled={logout.busy}
        onClick={() => void logout.signOut()}
      >
        <LogOut />
        {logout.busy ? "Signing out…" : "Sign out of account"}
      </Button>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        Signing out clears account data on this device. It does not sign a transaction or disconnect
        your wallet.
      </p>
      {logout.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {logout.error}
        </p>
      )}
    </AccountFrame>
  );
}
