import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { isCurrentAuthRead, withTimeout } from "@/lib/auth-flow.shared";

type AccountState = {
  user: User | null;
  loading: boolean;
  error: string | null;
  recovery: boolean;
  finishRecovery: () => void;
};
const INITIAL: AccountState = { user: null, loading: true, error: null, recovery: false, finishRecovery: () => {} };
const AccountContext = createContext<AccountState>(INITIAL);

export function AccountSession({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>(INITIAL);
  const queryClient = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    let active = true;
    let revision = 0;
    let identity: string | null = null;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event === "INITIAL_SESSION") return;
      revision++;
      const next = session?.user ?? null;
      const changed = identity !== (next?.id ?? null);
      identity = next?.id ?? null;
      setState((previous) => ({
        ...previous,
        user: next,
        loading: false,
        error: null,
        recovery: event === "PASSWORD_RECOVERY" || (event !== "SIGNED_OUT" && previous.recovery),
      }));
      // Do not call Auth again inside its subscriber (it holds the Auth lock).
      if (changed || event === "USER_UPDATED")
        queueMicrotask(() => {
          if (!active) return;
          void (async () => {
            if (!next || changed) {
              await queryClient.cancelQueries();
              queryClient.clear();
            }
            if (active) await router.invalidate();
          })().catch(() => {});
        });
    });
    const started = revision;
    void withTimeout(supabase.auth.getUser())
      .then(({ data, error }) => {
        if (!active || !isCurrentAuthRead(started, revision)) return;
        identity = data.user?.id ?? null;
        setState((previous) => ({
          ...previous,
          user: data.user,
          loading: false,
          error:
            error && error.name !== "AuthSessionMissingError"
              ? "Your account session could not be checked. Please sign in again."
              : null,
        }));
      })
      .catch(() => {
        if (active && isCurrentAuthRead(started, revision))
          setState({
            ...INITIAL,
            loading: false,
            error: "Your session check timed out. Please try signing in again.",
          });
      });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient, router]);
  return <AccountContext.Provider value={{ ...state, finishRecovery: () => setState((previous) => ({ ...previous, recovery: false })) }}>{children}</AccountContext.Provider>;
}

export function useAccountSession() {
  return useContext(AccountContext);
}
