import { Database } from "lucide-react";

/** Shows where a figure comes from and when it was read. Every financial widget should carry one. */
export function DataSourceStamp({
  source,
  at,
  illustrative = false,
}: {
  source: string;
  at?: string | Date | null;
  illustrative?: boolean;
}) {
  const when = at ? new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "time not available";
  return (
    <p className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Database className="h-3 w-3" aria-hidden="true" />
      <span>Source: {source}</span>
      {!(illustrative && !at) && (
        <>
          <span aria-hidden="true">·</span>
          <span>{when}</span>
        </>
      )}
      {illustrative && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-medium text-teal">Illustrative, not live data</span>
        </>
      )}
    </p>
  );
}
