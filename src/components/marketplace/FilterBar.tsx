import { useId, useState } from "react";
import { LayoutGrid, List, RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CATEGORY_GROUPS, groupLabel, statusLabel, type CategoryGroup } from "./asset-meta";
import {
  AVAILABILITY,
  MIN_BUCKETS,
  SORTS,
  TERM_BUCKETS,
  type MarketFilters,
  type SortKey,
} from "./filters";

export type FilterOptions = {
  groups: CategoryGroup[];
  countries: string[];
  statuses: string[];
  operators: string[];
};

/** Marketplace controls. Only filters backed by stored registry fields are active. */
export function FilterBar({
  value,
  view,
  options,
  shown,
  total,
  activeCount,
  onChange,
  onView,
  onReset,
}: {
  value: MarketFilters;
  view: "grid" | "list";
  options: FilterOptions;
  shown: number;
  total: number;
  activeCount: number;
  onChange: (patch: Partial<MarketFilters>) => void;
  onView: (v: "grid" | "list") => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const pendingId = useId();
  const groups = Array.from(new Set([...CATEGORY_GROUPS.map((g) => g.key), ...options.groups]));

  return (
    <div className="card-institutional p-4 md:p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={value.q ?? ""}
            onChange={(e) => onChange({ q: e.target.value || undefined })}
            placeholder="Search assets, operators or locations"
            aria-label="Search assets"
            className="h-11 w-full rounded-lg border border-input bg-surface pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/25"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 shrink-0 md:hidden"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
          >
            <SlidersHorizontal /> Filters{activeCount ? ` (${activeCount})` : ""}
          </Button>
          <label className="sr-only" htmlFor={`${panelId}-sort`}>
            Sort by
          </label>
          <select
            id={`${panelId}-sort`}
            value={value.sort ?? "newest"}
            onChange={(e) =>
              onChange({ sort: e.target.value === "newest" ? undefined : (e.target.value as SortKey) })
            }
            className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-surface px-3 text-sm text-foreground md:flex-none"
          >
            {Object.entries(SORTS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-1" role="group" aria-label="Layout">
            <ViewBtn active={view === "grid"} label="Grid view" onClick={() => onView("grid")}>
              <LayoutGrid className="h-4 w-4" />
            </ViewBtn>
            <ViewBtn active={view === "list"} label="List view" onClick={() => onView("list")}>
              <List className="h-4 w-4" />
            </ViewBtn>
          </div>
        </div>
      </div>

      <div id={panelId} className={`${open ? "grid" : "hidden"} mt-4 gap-3 sm:grid-cols-2 md:grid md:grid-cols-4`}>
        <Field label="Asset category">
          <select
            value={value.group ?? ""}
            onChange={(e) => onChange({ group: (e.target.value || undefined) as CategoryGroup | undefined })}
            className={SELECT}
          >
            <option value="">All categories</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {groupLabel(g)}
                {options.groups.includes(g) ? "" : " (no listings)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Country / jurisdiction">
          <OptionSelect value={value.country} all="All locations" options={options.countries} onChange={(v) => onChange({ country: v })} />
        </Field>
        <Field label="Investment status">
          <select value={value.status ?? ""} onChange={(e) => onChange({ status: e.target.value || undefined })} className={SELECT}>
            <option value="">All statuses</option>
            {options.statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Funding availability">
          <select
            value={value.availability ?? ""}
            onChange={(e) => onChange({ availability: (e.target.value || undefined) as MarketFilters["availability"] })}
            className={SELECT}
          >
            <option value="">Any</option>
            {Object.entries(AVAILABILITY).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Project operator">
          <OptionSelect value={value.operator} all="All operators" options={options.operators} onChange={(v) => onChange({ operator: v })} />
        </Field>
        <Field label="Minimum participation">
          <select
            value={value.min ?? ""}
            onChange={(e) => onChange({ min: (e.target.value || undefined) as MarketFilters["min"] })}
            className={SELECT}
          >
            <option value="">Any amount</option>
            {Object.entries(MIN_BUCKETS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Term">
          <select
            value={value.term ?? ""}
            onChange={(e) => onChange({ term: (e.target.value || undefined) as MarketFilters["term"] })}
            className={SELECT}
          >
            <option value="">Any term</option>
            {Object.entries(TERM_BUCKETS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Risk category · Maturity · Distributions">
          <select disabled aria-describedby={pendingId} className={`${SELECT} cursor-not-allowed opacity-60`}>
            <option>Not yet published</option>
          </select>
        </Field>
        <p id={pendingId} className="text-xs text-muted-foreground sm:col-span-2 md:col-span-4">
          Risk category, project maturity and distribution frequency filters switch on once projects
          publish those fields. They are not stored for any listing today.
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm text-muted-foreground">
        <span aria-live="polite">
          Showing <span className="font-medium text-foreground">{shown}</span> of {total} listing
          {total === 1 ? "" : "s"}
        </span>
        {activeCount > 0 && (
          <button type="button" onClick={onReset} className="inline-flex items-center gap-1 font-medium text-teal hover:underline">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset filters
          </button>
        )}
      </div>
    </div>
  );
}

const SELECT = "h-10 w-full rounded-lg border border-input bg-surface px-2.5 text-sm text-foreground";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function OptionSelect({
  value,
  all,
  options,
  onChange,
}: {
  value?: string;
  all: string;
  options: string[];
  onChange: (v: string | undefined) => void;
}) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={SELECT}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ViewBtn({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md p-2 ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}
