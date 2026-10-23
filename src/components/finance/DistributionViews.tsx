import { ExternalLink } from "lucide-react";
import { cardanoscanTx } from "@/lib/chain-format";
import type {
  DistributionEvent,
  DistributionStatus,
  ForecastPoint,
  PerUnitSummaryData,
  Scenario,
  SensitivityRow,
} from "./types";
import { money, pct, shortHash } from "./format";

/** Forecast, Approved, Funded and Paid are always visually distinct. */
export const DISTRIBUTION_STATUS: Record<DistributionStatus, { label: string; cls: string; help: string }> = {
  forecast: {
    label: "Forecast",
    cls: "border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground",
    help: "An estimate. Not approved, not funded, not owed.",
  },
  approved: {
    label: "Approved",
    cls: "border-gold/40 bg-gold/15 text-foreground",
    help: "Approved for payment; cash not yet set aside.",
  },
  funded: {
    label: "Funded",
    cls: "border-teal/30 bg-teal/10 text-teal",
    help: "Cash set aside for payment; not yet paid out.",
  },
  paid: {
    label: "Paid",
    cls: "border-success/30 bg-success/10 text-success",
    help: "Settled, with a confirmed transaction reference.",
  },
};

export function DistributionStatusBadge({ status }: { status: DistributionStatus }) {
  const m = DISTRIBUTION_STATUS[status];
  return (
    <span title={m.help} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function DistributionStatusLegend() {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {(Object.keys(DISTRIBUTION_STATUS) as DistributionStatus[]).map((k) => (
        <div key={k} className="rounded-xl border border-border bg-card p-3">
          <dt>
            <DistributionStatusBadge status={k} />
          </dt>
          <dd className="mt-2 text-xs text-muted-foreground">{DISTRIBUTION_STATUS[k].help}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PerUnitSummary({ data }: { data: PerUnitSummaryData }) {
  const rows: [string, string][] = [
    ["Capital raised", money(data.capitalRaised, data.currency)],
    ["Participation units", data.units.toLocaleString("en-AU")],
    ["Issue price per unit", money(data.unitPrice, data.currency)],
    ["Net distributable cash", money(data.distributableCash, data.currency)],
  ];
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <p className="font-display text-base font-semibold text-foreground">Per-unit distribution</p>
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-xs text-muted-foreground">Distribution per unit</p>
          <p className="number-display font-display text-4xl font-semibold text-foreground">
            {money(data.distributionPerUnit, data.currency)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Cash yield on issue price</p>
          <p className="number-display font-display text-2xl font-semibold text-teal">{pct(data.cashYieldPct, 0)}</p>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-lg bg-secondary/60 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="number-display font-semibold text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Forecast versus actual per period. Missing actuals are shown as missing, never zero. */
export function ActualVsForecast({ points, currency, unitLabel = "per unit" }: { points: ForecastPoint[]; currency: string; unitLabel?: string }) {
  const max = Math.max(1, ...points.flatMap((p) => [p.forecast ?? 0, p.actual ?? 0]));
  const anyActual = points.some((p) => p.actual != null);
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <p className="font-display text-base font-semibold text-foreground">Actual versus forecast</p>
      <p className="mt-1 text-xs text-muted-foreground">Distribution {unitLabel}, {currency}</p>
      {points.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No forecast or actual results have been published.</p>
      ) : (
        <ul className="mt-5 space-y-4">
          {points.map((p) => (
            <li key={p.period}>
              <p className="text-sm font-medium text-foreground">{p.period}</p>
              <Bar label="Forecast" value={p.forecast} max={max} currency={currency} cls="bg-muted-foreground/40" />
              <Bar label="Actual" value={p.actual} max={max} currency={currency} cls="bg-teal" />
            </li>
          ))}
        </ul>
      )}
      {!anyActual && points.length > 0 && (
        <p className="mt-4 rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          No actual results exist yet, so there is nothing to compare against.
        </p>
      )}
    </div>
  );
}

function Bar({ label, value, max, currency, cls }: { label: string; value: number | null; max: number; currency: string; cls: string }) {
  return (
    <div className="mt-2 grid grid-cols-[64px_1fr_auto] items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="h-3 rounded-full bg-secondary">
        {value != null && <div className={`h-full rounded-full ${cls}`} style={{ width: `${(value / max) * 100}%` }} />}
      </div>
      <span className="number-display w-24 text-right font-medium text-foreground">
        {value != null ? money(value, currency) : "Not reported"}
      </span>
    </div>
  );
}

export function DistributionTimeline({ events, currency }: { events: DistributionEvent[]; currency: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <p className="font-display text-base font-semibold text-foreground">Distribution timeline</p>
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No distributions have been declared or paid.</p>
      ) : (
        <ol className="mt-5 space-y-3">
          {events.map((e) => (
            <li key={e.key} className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">{e.period}</p>
                <p className="text-xs text-muted-foreground">{e.date ?? "No payment date set"}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="number-display text-sm font-semibold text-foreground">
                  {money(e.perUnit, currency)} / unit
                </span>
                <DistributionStatusBadge status={e.status} />
                {e.status === "paid" && e.txHash && (
                  <a href={cardanoscanTx(e.txHash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-teal">
                    {shortHash(e.txHash)} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ScenarioCards({ scenarios, currency, pendingNote }: { scenarios: Scenario[]; currency: string; pendingNote?: string }) {
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        {scenarios.map((s) => (
          <div key={s.key} className="rounded-2xl border border-border bg-card p-5">
            <p className="text-sm font-semibold text-foreground">{s.label}</p>
            <p className="number-display mt-3 font-display text-2xl font-semibold text-foreground">
              {money(s.distributionPerUnit, currency)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/ unit</span>
            </p>
            <p className="text-sm text-teal">{pct(s.cashYieldPct, 0)} cash yield</p>
            <p className="mt-3 text-xs text-muted-foreground">{s.assumptions}</p>
          </div>
        ))}
        {pendingNote && (
          <div className="flex items-center rounded-2xl border border-dashed border-border p-5 text-sm text-muted-foreground md:col-span-2">
            {pendingNote}
          </div>
        )}
      </div>
    </div>
  );
}

export function SensitivityTable({ rows, currency, pendingNote }: { rows: SensitivityRow[]; currency: string; pendingNote: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <p className="font-display text-base font-semibold text-foreground">Risk sensitivity</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{pendingNote}</p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Driver</th>
              <th className="pb-2 font-medium">Change</th>
              <th className="pb-2 text-right font-medium">Distribution / unit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-2 text-foreground">{r.driver}</td>
                <td className="py-2 text-muted-foreground">{r.change}</td>
                <td className="number-display py-2 text-right font-medium text-foreground">{money(r.distributionPerUnit, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
