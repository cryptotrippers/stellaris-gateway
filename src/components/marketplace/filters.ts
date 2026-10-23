import { categoryGroup, type CategoryGroup } from "./asset-meta";

/** Fields the marketplace filters read. Matches the stored asset registry. */
export type FilterableAsset = {
  id: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  target_lovelace: number;
  raised_lovelace: number;
  min_deposit_lovelace: number;
  maturity_months: number | null;
  funding_status: string;
  created_at: string;
};

export const SORTS = {
  newest: "Newest",
  progress: "Funding progress",
  target: "Target size",
  min: "Lowest minimum",
  name: "Name",
} as const;
export type SortKey = keyof typeof SORTS;

export const MIN_BUCKETS = {
  "5": "Up to ₳5",
  "25": "Up to ₳25",
  "100": "Up to ₳100",
} as const;
export type MinBucket = keyof typeof MIN_BUCKETS;

export const TERM_BUCKETS = {
  none: "No fixed term",
  short: "Up to 3 years",
  long: "Over 3 years",
} as const;
export type TermBucket = keyof typeof TERM_BUCKETS;

export const AVAILABILITY = {
  testnet: "Test deposits possible",
  view: "View only",
} as const;
export type Availability = keyof typeof AVAILABILITY;

export type MarketFilters = {
  q?: string;
  group?: CategoryGroup;
  country?: string;
  status?: string;
  availability?: Availability;
  operator?: string;
  min?: MinBucket;
  term?: TermBucket;
  sort?: SortKey;
};

const LOVELACE = 1_000_000;

/** Last comma-separated part of the stored location, e.g. "Davao City, Philippines" → "Philippines". */
export function countryOf(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

/** Demo rows are never investable; closed or funded rows are view only. */
export function availabilityOf(a: Pick<FilterableAsset, "funding_status">): Availability {
  return a.funding_status === "open" || a.funding_status === "pilot" ? "testnet" : "view";
}

export function fundedPercent(a: Pick<FilterableAsset, "target_lovelace" | "raised_lovelace">): number {
  const target = Number(a.target_lovelace);
  if (!(target > 0)) return 0;
  return Math.min(100, (Number(a.raised_lovelace) / target) * 100);
}

function termMatches(months: number | null, bucket: TermBucket): boolean {
  if (bucket === "none") return months == null;
  if (months == null) return false;
  return bucket === "short" ? months <= 36 : months > 36;
}

export function filterAssets<T extends FilterableAsset>(assets: T[], f: MarketFilters): T[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return assets.filter(
    (a) =>
      (q === "" ||
        [a.name, a.issuer, a.category, a.location ?? ""].some((s) => s.toLowerCase().includes(q))) &&
      (!f.group || categoryGroup(a.category) === f.group) &&
      (!f.country || countryOf(a.location) === f.country) &&
      (!f.status || a.funding_status === f.status) &&
      (!f.availability || availabilityOf(a) === f.availability) &&
      (!f.operator || a.issuer === f.operator) &&
      (!f.min || Number(a.min_deposit_lovelace) <= Number(f.min) * LOVELACE) &&
      (!f.term || termMatches(a.maturity_months, f.term)),
  );
}

export function sortAssets<T extends FilterableAsset>(assets: T[], sort: SortKey = "newest"): T[] {
  const copy = [...assets];
  copy.sort((a, b) => {
    if (sort === "progress") return fundedPercent(b) - fundedPercent(a);
    if (sort === "target") return Number(b.target_lovelace) - Number(a.target_lovelace);
    if (sort === "min") return Number(a.min_deposit_lovelace) - Number(b.min_deposit_lovelace);
    if (sort === "name") return a.name.localeCompare(b.name);
    return b.created_at.localeCompare(a.created_at);
  });
  return copy;
}

const pick = <K extends string>(v: unknown, allowed: readonly K[]): K | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as K) : undefined;
const text = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.slice(0, 120) : undefined);

/** Validates untrusted URL search params; unknown values are dropped, never trusted. */
export function parseMarketSearch(s: Record<string, unknown>): MarketFilters & { view?: "list" } {
  return {
    q: text(s.q),
    group: pick(s.group, [
      "energy",
      "residential",
      "commercial",
      "agriculture",
      "infrastructure",
      "other",
    ] as const),
    country: text(s.country),
    status: text(s.status),
    availability: pick(s.availability, Object.keys(AVAILABILITY) as Availability[]),
    operator: text(s.operator),
    min: pick(s.min, Object.keys(MIN_BUCKETS) as MinBucket[]),
    term: pick(s.term, Object.keys(TERM_BUCKETS) as TermBucket[]),
    sort: pick(s.sort, Object.keys(SORTS) as SortKey[]),
    view: s.view === "list" ? "list" : undefined,
  };
}

export function hasActiveFilters(f: MarketFilters): boolean {
  return !!(f.q || f.group || f.country || f.status || f.availability || f.operator || f.min || f.term);
}
