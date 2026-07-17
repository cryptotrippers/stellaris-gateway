/**
 * Formatting helpers extracted from the retired mock-data module.
 * These are pure presentation utilities — no fabricated data.
 */

export function formatAda(n: number): string {
  if (!Number.isFinite(n)) return "₳ 0";
  if (n >= 1_000_000) return `₳ ${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `₳ ${(n / 1_000).toFixed(1)}K`;
  return `₳ ${n.toFixed(0)}`;
}

export function formatUsd(ada: number, rate = 0.42): string {
  if (!Number.isFinite(ada)) return "$0";
  const usd = ada * rate;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

export function lovelaceToAda(lovelace: number | bigint): number {
  const n = typeof lovelace === "bigint" ? Number(lovelace) : lovelace;
  return n / 1_000_000;
}

/**
 * Deterministic pseudo-sparkline series generated from a seed.
 * Only for decorative/placeholder chart geometry when we explicitly want
 * a shape (never for numbers displayed to the user as data).
 */
export function sparkline(seed: number, points = 24): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < points; i++) {
    const s = Math.sin((seed + i) * 0.7) + Math.cos((seed + i) * 0.31);
    v += s * 2.4 + (i / points) * 1.6;
    out.push(v);
  }
  return out;
}
