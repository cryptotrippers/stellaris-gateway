import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { SectionHeader } from "@/components/brand/SectionHeader";
import { CATEGORY_GROUPS, type CategoryGroup } from "./asset-meta";

const SPAN = ["lg:col-span-3", "lg:col-span-3", "lg:col-span-2", "lg:col-span-2", "lg:col-span-2"];

/**
 * Photographic asset-class tiles. These are concept categories: the count
 * under each tile is read from the registry, and a tile with no listings says so.
 */
export function CategoryShowcase({
  counts,
  loading,
}: {
  counts: Partial<Record<CategoryGroup, { total: number; demo: number }>>;
  loading: boolean;
}) {
  return (
    <section aria-labelledby="categories-heading" className="mt-16">
      <div id="categories-heading">
        <SectionHeader
          eyebrow="Asset classes"
          title="Five kinds of real-world asset, one standard of disclosure."
          description="These are the asset classes Stellaris is designed for. A category is a concept until an approved project is listed under it."
        />
      </div>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {CATEGORY_GROUPS.map((g, i) => {
          const c = counts[g.key];
          const status = loading
            ? "Checking listings…"
            : !c || c.total === 0
              ? "Concept category · no listings yet"
              : c.demo === c.total
                ? `${c.total} demo listing${c.total === 1 ? "" : "s"} · not investable`
                : `${c.total} listing${c.total === 1 ? "" : "s"} on testnet`;
          return (
            <li key={g.key} className={`${SPAN[i]} ${i === 0 ? "sm:col-span-2" : ""}`}>
              <Link
                to="/marketplace"
                search={(prev) => ({ ...prev, group: g.key })}
                hash="assets"
                className="group relative block h-72 overflow-hidden rounded-2xl border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-80"
              >
                <img
                  src={g.image}
                  alt=""
                  loading="lazy"
                  width={1280}
                  height={960}
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
                />
                <span className="absolute left-4 top-4 rounded-full bg-card/90 px-2.5 py-1 text-[11px] font-medium text-foreground backdrop-blur">
                  Concept category
                </span>
                <span className="absolute right-4 top-4 rounded bg-card/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  Illustrative image
                </span>
                <div className="absolute inset-x-4 bottom-4 rounded-xl bg-card/95 p-4 shadow-elevated backdrop-blur">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-display text-base font-semibold text-foreground">{g.label}</h3>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-teal transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{g.blurb}</p>
                  <p className="mt-2 text-xs font-medium text-teal">{status}</p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
