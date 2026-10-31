import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { safeAuthReturn, withTimeout } from "@/lib/auth-flow.shared";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    // Client-only gate; private server functions retain their own authorization.
    let user = null;
    try {
      const result = await withTimeout(supabase.auth.getUser());
      user = result.data.user;
    } catch {
      /* An unreadable session is not authenticated. */
    }
    if (!user)
      throw redirect({
        to: "/auth",
        search: { mode: "signin", redirect: safeAuthReturn(location.href) },
      });
  },
  component: Outlet,
});
