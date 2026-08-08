import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

/** Header control showing the signed-in account, or a link to sign in. */
export function AccountButton() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) =>
      setEmail(session?.user.email ?? null),
    );
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!email) {
    return (
      <Link
        to="/auth"
        className="hidden sm:inline-flex items-center rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-secondary"
      >
        Sign in
      </Link>
    );
  }

  return (
    <button
      onClick={() => supabase.auth.signOut()}
      title={email}
      className="hidden sm:inline-flex items-center rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-secondary"
    >
      Sign out
    </button>
  );
}
