/**
 * Sprint 2 E04 — maps ledger read-model figures (minor units as strings) onto
 * the display shapes the finance components already take. Display only: the
 * numbers are converted for drawing, never used for further calculation.
 */
import type { PeriodFinancials } from "@/lib/ledger-read.shared";
import type { WaterfallData, WaterfallStep } from "./types";

/** Minor units (cents) as a display number in major units. */
export function toMajor(minor: string, decimals = 2): number {
  if (!/^-?\d+$/.test(minor)) throw new Error(`not an integer amount: ${minor}`);
  const neg = minor.startsWith("-");
  const digits = (neg ? minor.slice(1) : minor).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals);
  return Number(`${neg ? "-" : ""}${whole}.${frac}`);
}

/** Waterfall steps from settled receipts through each funded tier to the distributable result. */
export function toWaterfallData(f: PeriodFinancials, periodLabel = f.periodId): WaterfallData {
  const steps: WaterfallStep[] = [];
  const receipts = toMajor(f.settledReceipts);
  steps.push({
    key: "receipts",
    label: "Settled receipts",
    amount: receipts,
    from: 0,
    to: receipts,
    kind: "inflow",
  });
  let running = receipts;
  for (const t of f.tiers) {
    const taken = toMajor(t.fundedFromReceipts);
    if (taken === 0) continue;
    steps.push({
      key: t.key,
      label: t.label,
      amount: -taken,
      from: running,
      to: running - taken,
      kind: "deduction",
      note: t.refs.length ? `Sources: ${t.refs.join(", ")}` : undefined,
    });
    running -= taken;
  }
  const distributable = toMajor(f.distributable);
  steps.push({
    key: "distributable",
    label: "Net distributable cash",
    amount: distributable,
    from: 0,
    to: distributable,
    kind: "result",
    note: f.periodStatus === "approved" ? "Approved period." : "Not approved yet; may change.",
  });
  return { currency: f.currency, period: periodLabel, steps };
}
