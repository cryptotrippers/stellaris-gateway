import { FlaskConical } from "lucide-react";
import type { ReactNode } from "react";

/** Visually fences illustrative content so it cannot be read as real performance. */
export function DemoFrame({
  title = "Illustrative Example",
  note = "Sample figures for explanation only. Not actual platform or project performance.",
  children,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="rounded-2xl border-2 border-dashed border-teal/40 bg-teal/5 p-4 md:p-6"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-teal px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
          <FlaskConical className="h-3 w-3" aria-hidden="true" />
          {title}
        </span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      {children}
    </section>
  );
}
