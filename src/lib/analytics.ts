// Lightweight analytics stub. Wire to Plausible/PostHog/etc later by
// replacing the body of trackEvent — call sites stay identical.
export type TrackProps = Record<string, string | number | boolean | undefined>;

export function trackEvent(name: string, props?: TrackProps): void {
  if (typeof window === "undefined") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  try {
    if (typeof w.plausible === "function") w.plausible(name, { props });
    else if (w.posthog && typeof w.posthog.capture === "function") w.posthog.capture(name, props);
    else if (import.meta.env.DEV) console.debug("[analytics]", name, props ?? {});
  } catch {
    /* swallow — analytics must never break UX */
  }
}
