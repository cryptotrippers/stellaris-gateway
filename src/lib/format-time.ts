/**
 * Shows a moment in the reader's local time and in UTC, e.g.
 * "Mon 3 Nov 2026, 14:30 your time · 03:30 UTC".
 * Call only in the browser after hydration (local time differs from the server).
 */
export function formatLocalAndUtc(input: Date | number | string, timeZone?: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "time not available";
  const local = d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
  const utc = d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `${local} your time · ${utc} UTC`;
}

/** Date `days` after `from`, as a timestamp. */
export function addDaysMs(from: number, days: number): number {
  return from + days * 86_400_000;
}
