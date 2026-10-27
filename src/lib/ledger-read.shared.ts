/**
 * Sprint 2 E04 — read model for the Meridian (Rail B) ledger.
 *
 * Turns a stored, verified ledger (ledger-store.server.ts) into the JSON-safe
 * figures the app shows, each wrapped as `Sourced<T>` (Meridian §9): the value
 * plus where it came from, when it was read, how far it is verified, and the
 * sentence saying what it does not prove.
 *
 * Money crosses the JSON boundary as decimal strings of minor units (cents);
 * the UI converts for display only. Pure and deterministic: the same ledger
 * and clock always give the same output.
 */
import { computeWaterfall, type PeriodWaterfall } from "./asset-cashflow.shared";
import type { ProjectLedger } from "./financial-ledger.shared";
import {
  fail,
  ok,
  type Provenance,
  type Result,
  type Sourced,
  type SourceMeta,
} from "./provenance.shared";

/** A money amount in minor units, as a decimal string. */
export type MinorString = string;

export interface TierFinancials {
  key: string;
  label: string;
  required: MinorString;
  fundedFromReceipts: MinorString;
  fundedFromReserve: MinorString;
  unfunded: MinorString;
  refs: string[];
}

export interface PeriodFinancials {
  projectId: string;
  periodId: string;
  currency: string;
  periodStatus: "open" | "closed" | "approved";
  /** Who approved the period (approved periods only). */
  approvedBy: string | null;
  /** Merkle root of the period's entries, recorded at approval. */
  periodRoot: string | null;
  settledReceipts: MinorString;
  receivables: MinorString;
  tiers: TierFinancials[];
  reserveReleased: MinorString;
  distributable: MinorString;
  shortfall: MinorString;
  /** Reported only; excluded from every figure above. */
  valuationRecorded: MinorString;
  entryCount: number;
  /** Head of the project's hash chain when this was read. */
  chainHead: { seq: string; hash: string };
}

/** What the read model needs from a stored ledger (see StoredLedger). */
export interface VerifiedLedger {
  ledger: ProjectLedger;
  head: { seq: bigint; hash: string };
  periods: ReadonlyArray<{ id: string; period_root: string | null }>;
}

export const LEDGER_SOURCE = "Stellaris project ledger (Meridian, hash-chained)";

/** How far a period's figures can be relied on. */
export function periodMeta(
  status: PeriodFinancials["periodStatus"],
  observedAt: string,
  provenance: readonly Provenance[],
): SourceMeta {
  if (status === "approved") {
    return {
      source: LEDGER_SOURCE,
      observedAt,
      verification: "reviewed",
      limitation:
        "Approved by a second person and fixed by a hash chain. It shows the books as recorded from the cited evidence; it does not prove the evidence itself is genuine — that is the reviewer's and the auditor's job.",
      provenance,
    };
  }
  return {
    source: LEDGER_SOURCE,
    observedAt,
    verification: "self_reported",
    limitation:
      status === "closed"
        ? "Closed but not yet approved: figures may still be corrected before approval."
        : "Period still open: entries are still being recorded and figures will change.",
    provenance,
  };
}

const s = (v: bigint) => v.toString();

function toFinancials(
  w: PeriodWaterfall,
  v: VerifiedLedger,
  approvedBy: string | null,
): PeriodFinancials {
  const row = v.periods.find((p) => p.id === w.periodId);
  return {
    projectId: w.projectId,
    periodId: w.periodId,
    currency: w.currency,
    periodStatus: w.periodStatus,
    approvedBy,
    periodRoot: row?.period_root ?? null,
    settledReceipts: s(w.settledReceipts),
    receivables: s(w.receivables),
    tiers: w.tiers.map((t) => ({
      key: t.key,
      label: t.label,
      required: s(t.required),
      fundedFromReceipts: s(t.fundedFromReceipts),
      fundedFromReserve: s(t.fundedFromReserve),
      unfunded: s(t.unfunded),
      refs: [...t.refs],
    })),
    reserveReleased: s(w.reserveReleased),
    distributable: s(w.distributable),
    shortfall: s(w.shortfall),
    valuationRecorded: s(w.valuationRecorded),
    entryCount: v.ledger.entries.filter((e) => e.periodId === w.periodId).length,
    chainHead: { seq: s(v.head.seq), hash: v.head.hash },
  };
}

/** Distinct provenance records behind a period, capped for the response size. */
function periodProvenance(l: ProjectLedger, periodId: string, cap = 50): Provenance[] {
  const seen = new Set<string>();
  const out: Provenance[] = [];
  for (const e of l.entries) {
    if (e.periodId !== periodId) continue;
    const key = `${e.provenance.kind}|${e.provenance.documentId}|${e.provenance.sha256}|${e.provenance.txHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e.provenance);
    if (out.length >= cap) break;
  }
  return out;
}

/** One period's financials from a verified ledger, as `Sourced<T>`. */
export function periodFinancials(
  v: VerifiedLedger,
  periodId: string,
  observedAt: string,
): Result<Sourced<PeriodFinancials>> {
  const w = computeWaterfall(v.ledger, periodId);
  if (!w.ok) return w;
  const period = v.ledger.periods.find((p) => p.id === periodId);
  if (!period) return fail("unknown_period", `period ${periodId} does not exist`);
  const value = toFinancials(w.value, v, period.approvedBy);
  return ok({
    value,
    meta: periodMeta(value.periodStatus, observedAt, periodProvenance(v.ledger, periodId)),
  });
}

/** Every period of a project, newest last, without entry detail. */
export function periodSummaries(
  v: VerifiedLedger,
  observedAt: string,
): Array<
  Sourced<Pick<PeriodFinancials, "periodId" | "periodStatus" | "distributable" | "shortfall">>
> {
  const out = [];
  for (const p of v.ledger.periods) {
    const w = computeWaterfall(v.ledger, p.id);
    if (!w.ok) continue;
    out.push({
      value: {
        periodId: p.id,
        periodStatus: w.value.periodStatus,
        distributable: s(w.value.distributable),
        shortfall: s(w.value.shortfall),
      },
      meta: periodMeta(w.value.periodStatus, observedAt, []),
    });
  }
  return out;
}
