import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { authErrorMessage, withTimeout } from "@/lib/auth-flow.shared";

export function useAccountSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await queryClient.cancelQueries();
      queryClient.clear();
      const { error } = await withTimeout(supabase.auth.signOut());
      if (error) throw error;
      await navigate({ to: "/auth", search: { mode: "signin", redirect: "/app" }, replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { signOut, busy, error };
}
