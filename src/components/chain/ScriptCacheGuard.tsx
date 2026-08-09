import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Cache-bust guard for contract redeploys.
 *
 * Mounted once at the root. On the first client render it compares the build
 * fingerprint of the validators this bundle ships with against the one the
 * browser last saw. When they differ, every cached query is dropped so no view
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
        queryClient.clear();
        writeStoredScriptBuildId();
        if (previous) {
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
