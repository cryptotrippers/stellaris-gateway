import { useEffect, useState } from "react";
import { withTimeout } from "@/lib/auth-flow.shared";

/** Auth's public settings endpoint is the source of truth, not a guessed provider list. */
export function useAuthProviders() {
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return;
    void withTimeout(
      fetch(`${url}/auth/v1/settings`, {
        headers: { apikey: key },
        signal: controller.signal,
      }),
      8000,
    )
      .then(async (response) => {
        if (!response.ok) return;
        const settings = await response.json();
        if (active) setGoogle(settings.external?.google === true);
      })
      .catch(() => {
        /* Unknown settings fail closed: email auth remains available. */
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  return { google };
}
