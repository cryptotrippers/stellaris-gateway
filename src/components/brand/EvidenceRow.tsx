import { ExternalLink } from "lucide-react";
import { StatusPill, type DisclosureStatus } from "./StatusPill";

/** One evidence-led claim: what it is, its status, its source and when. */
export function EvidenceRow({
  title,
  status,
  href,
  source,
  date,
}: {
  title: string;
  status: DisclosureStatus;
  href?: string | null;
  source?: string;
  date?: string | null;
}) {
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">
          {source ?? "No source yet"}
          {date ? ` · ${date}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <StatusPill status={status} />
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-teal hover:underline"
          >
            View <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  );
}
