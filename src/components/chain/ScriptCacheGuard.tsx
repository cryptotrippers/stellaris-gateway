import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Cache-bust guard for contract redeploys.
 *
 * Mounted once at the root. On the first client render it compares the build
 * fingerprint of the validators this bundle ships with against the one the
 * browser last saw. When they differ, every cached query is reset and refetched so no view
 * can keep rendering an address derived from the previous scripts.
 *
 * The identity module is imported dynamically so the pinned blueprints never
 * enter the SSR/root bundle.
 */
export function ScriptCacheGuard() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { SCRIPT_BUILD_ID, readStoredScriptBuildId, writeStoredScriptBuildId } = await import(
        "@/lib/script-identity"
      );
      if (cancelled) return;
      const previous = readStoredScriptBuildId();
      if (previous !== SCRIPT_BUILD_ID) {
        writeStoredScriptBuildId();
        // A first visit has nothing cached from older scripts. When the scripts did change,
        // reset rather than clear: clear() orphans in-flight queries, leaving their pages on a
        // loading state forever, while reset discards data and refetches with observers intact.
        if (previous) {
          void queryClient.resetQueries();
          console.info(
            `[script-cache] validators changed (${previous} → ${SCRIPT_BUILD_ID}); cleared cached chain data.`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  return null;
}
