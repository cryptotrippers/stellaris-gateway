/** Display-only number formatting for the financial visuals. */
export function money(amount: number, currency: string, opts: { compact?: boolean } = {}): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    maximumFractionDigits: 0,
    notation: opts.compact ? "compact" : "standard",
  }).format(amount);
}

export function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}
