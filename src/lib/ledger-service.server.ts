/**
 * Sprint 2 E04 — who may do what with the Meridian ledger.
 *
 * The server functions (ledger.functions.ts) look up the caller's roles and
 * call these; keeping the rules here, over a `LedgerRepo`, means they are
 * tested against the real migrations in PGlite rather than a mock.
 *
 *   read figures        admin or operator
 *   create / open        admin
 *   record entries       admin (until evidence intake, E08, proposes them)
 *   close a period       admin or operator — the closer is the preparer
 *   approve a period     admin, and never the preparer (maker-checker)
 *
 * Every write is re-validated by the pure rules (financial-ledger.shared.ts)
 * and again by the database (0010_meridian_ledger).
 */
import type { EntryInput } from "./financial-ledger.shared";
import {
  appendEntries,
  approvePeriod,
  closePeriod,
  createProject,
  entryFromJson,
  loadLedger,
  openPeriod,
  type LedgerRepo,
} from "./ledger-store.server";
import { periodFinancials, periodSummaries, type PeriodFinancials } from "./ledger-read.shared";
import { fail, ok, type Result, type Sourced } from "./provenance.shared";

export type LedgerRole = "admin" | "operator";

export interface LedgerActor {
  /** Auth user id; recorded as preparer / approver. */
  userId: string;
  roles: readonly LedgerRole[];
}

const can = (a: LedgerActor, ...roles: LedgerRole[]) => roles.some((r) => a.roles.includes(r));

const denied = <T>(what: string): Result<T> =>
  fail(
    "unauthorised_release",
    `${what} needs the ${what.startsWith("Approving") ? "admin" : "admin or operator"} role.`,
  );

export async function readPeriodFinancials(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  periodId: string,
  now: Date = new Date(),
): Promise<Result<Sourced<PeriodFinancials>>> {
  if (!can(actor, "admin", "operator")) return denied("Reading project ledgers");
  const stored = await loadLedger(repo, projectId);
  if (!stored.ok) return stored;
  return periodFinancials(stored.value, periodId, now.toISOString());
}

export async function readPeriodList(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  now: Date = new Date(),
) {
  if (!can(actor, "admin", "operator")) return denied<never>("Reading project ledgers");
  const stored = await loadLedger(repo, projectId);
  if (!stored.ok) return stored;
  return ok(periodSummaries(stored.value, now.toISOString()));
}

export async function createLedgerProject(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  currency: string,
): Promise<Result<true>> {
  if (!can(actor, "admin"))
    return fail("unauthorised_release", "Creating a project ledger needs the admin role.");
  return createProject(repo, projectId, currency);
}

export async function openLedgerPeriod(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  p: { id: string; startsOn: string; endsOn: string; adjustsPeriodId?: string | null },
): Promise<Result<true>> {
  if (!can(actor, "admin"))
    return fail("unauthorised_release", "Opening a period needs the admin role.");
  return openPeriod(repo, projectId, p);
}

/**
 * Record entries supplied as JSON (amounts as decimal strings of minor
 * units). The recorder in every entry's provenance must be the caller.
 */
export async function recordLedgerEntries(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  entriesJson: readonly unknown[],
): Promise<Result<{ appended: number; headSeq: string }>> {
  if (!can(actor, "admin"))
    return fail("unauthorised_release", "Recording ledger entries needs the admin role.");
  if (entriesJson.length === 0 || entriesJson.length > 200) {
    return fail("unknown_reference", "Send between 1 and 200 entries at a time.");
  }
  let entries: EntryInput[];
  try {
    entries = entriesJson.map((e) => entryFromJson(e));
  } catch (e) {
    return fail("non_positive_amount", (e as Error).message);
  }
  const foreign = entries.find((e) => e.provenance?.recordedBy !== actor.userId);
  if (foreign) {
    return fail("missing_provenance", `${foreign.ref}: the recorder must be the signed-in user.`);
  }
  const r = await appendEntries(repo, projectId, entries);
  if (!r.ok) return r;
  return ok({ appended: r.value.appended.length, headSeq: r.value.head.seq.toString() });
}

export async function closeLedgerPeriod(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  periodId: string,
): Promise<Result<true>> {
  if (!can(actor, "admin", "operator")) return denied("Closing a period");
  return closePeriod(repo, projectId, periodId, actor.userId);
}

export async function approveLedgerPeriod(
  repo: LedgerRepo,
  actor: LedgerActor,
  projectId: string,
  periodId: string,
): Promise<Result<{ periodRoot: string }>> {
  if (!can(actor, "admin")) return denied("Approving a period");
  return approvePeriod(repo, projectId, periodId, actor.userId);
}
