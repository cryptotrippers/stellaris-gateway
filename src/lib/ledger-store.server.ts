/**
 * Sprint 1 E03 — persistence for the Meridian (Rail B) project ledger.
 *
 * The pure modules decide what is allowed (financial-ledger.shared.ts); this
 * module loads a project's stored ledger, re-checks its hash chain and
 * approved-period roots (ledger-hash.shared.ts), applies the pure rules to a
 * proposed change and writes the result. The database enforces the same
 * shape again (drizzle/migrations/0010_meridian_ledger.sql): append-only
 * entries, chain continuity as the compare-and-swap, open periods only,
 * forward-only period states and maker-checker approval.
 *
 * Server-only. It never imports a Supabase client itself: callers pass one
 * (normally `supabaseAdmin`, after their own role checks) through
 * `supabaseLedgerRepo`, and tests pass an in-process Postgres.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  approvePeriod as approvePure,
  closePeriod as closePure,
  createLedger,
  openPeriod as openPure,
  postAll,
  type AccountingPeriod,
  type EntryInput,
  type LedgerEntry,
  type ProjectLedger,
} from "./financial-ledger.shared";
import {
  canonical,
  chainEntries,
  periodRoot,
  verifyChain,
  type ChainedEntry,
  type ChainHead,
} from "./ledger-hash.shared";
import {
  fail,
  ok,
  type CurrencyCode,
  type LedgerErrorCode,
  type Result,
} from "./provenance.shared";

// --- Storage rows ---------------------------------------------------------------

export interface LedgerProjectRow {
  id: string;
  currency: string;
}

export interface LedgerPeriodRow {
  project_id: string;
  id: string;
  kind: "regular" | "adjustment";
  adjusts_period_id: string | null;
  starts_on: string;
  ends_on: string;
  status: "open" | "closed" | "approved";
  closed_by: string | null;
  approved_by: string | null;
  period_root: string | null;
}

export interface LedgerEntryRow {
  project_id: string;
  seq: string | number | bigint;
  period_id: string;
  ref: string;
  kind: string;
  amount: string;
  currency: string;
  entry: unknown;
  prev_hash: string;
  entry_hash: string;
}

export type RepoWrite = { ok: true; count: number } | { ok: false; message: string };

/** The few storage operations the ledger needs. */
export interface LedgerRepo {
  getProject(projectId: string): Promise<LedgerProjectRow | null>;
  listPeriods(projectId: string): Promise<LedgerPeriodRow[]>;
  listEntries(projectId: string): Promise<LedgerEntryRow[]>;
  insertProject(row: LedgerProjectRow): Promise<RepoWrite>;
  insertPeriod(
    row: Omit<LedgerPeriodRow, "status" | "closed_by" | "approved_by" | "period_root">,
  ): Promise<RepoWrite>;
  /** Compare-and-swap on status: updates only if the period is still `from`. */
  updatePeriod(
    projectId: string,
    periodId: string,
    from: LedgerPeriodRow["status"],
    patch: Partial<Pick<LedgerPeriodRow, "status" | "closed_by" | "approved_by" | "period_root">>,
  ): Promise<RepoWrite>;
  /** One statement, all or nothing. */
  insertEntries(rows: LedgerEntryRow[]): Promise<RepoWrite>;
}

/** Repo over a Supabase client (the server passes `supabaseAdmin`). */
export function supabaseLedgerRepo(client: SupabaseClient): LedgerRepo {
  // The ledger tables arrive in the generated types after the migration is
  // applied; until then they're addressed untyped.
  const from = (t: string) => (client as unknown as { from: SupabaseClient["from"] }).from(t);
  const write = (error: { message: string } | null, count: number): RepoWrite =>
    error ? { ok: false, message: error.message } : { ok: true, count };
  return {
    async getProject(projectId) {
      const { data, error } = await from("ledger_projects")
        .select("id, currency")
        .eq("id", projectId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as LedgerProjectRow | null) ?? null;
    },
    async listPeriods(projectId) {
      const { data, error } = await from("ledger_periods")
        .select(
          "project_id, id, kind, adjusts_period_id, starts_on, ends_on, status, closed_by, approved_by, period_root",
        )
        .eq("project_id", projectId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as LedgerPeriodRow[];
    },
    async listEntries(projectId) {
      const { data, error } = await from("ledger_entries")
        .select(
          "project_id, seq, period_id, ref, kind, amount, currency, entry, prev_hash, entry_hash",
        )
        .eq("project_id", projectId)
        .order("seq", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as LedgerEntryRow[];
    },
    async insertProject(row) {
      const { error } = await from("ledger_projects").insert(row as never);
      return write(error, 1);
    },
    async insertPeriod(row) {
      const { error } = await from("ledger_periods").insert(row as never);
      return write(error, 1);
    },
    async updatePeriod(projectId, periodId, fromStatus, patch) {
      const { data, error } = await from("ledger_periods")
        .update(patch as never)
        .eq("project_id", projectId)
        .eq("id", periodId)
        .eq("status", fromStatus)
        .select("id");
      return write(error, (data ?? []).length);
    },
    async insertEntries(rows) {
      const { error } = await from("ledger_entries").insert(rows as never);
      return write(error, rows.length);
    },
  };
}

// --- Row <-> entry ----------------------------------------------------------------

const INT = /^-?\d+$/;

/** The stored JSON form of an entry: canonical, bigints as decimal strings. */
export const entryToJson = (e: LedgerEntry): unknown => JSON.parse(canonical(e));

/** Rebuild an entry from its stored JSON; refuses anything that isn't integer money. */
export function entryFromJson(json: unknown): LedgerEntry {
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.amount !== "string" || !INT.test(o.amount)) {
    throw new Error("stored ledger entry has no integer amount");
  }
  return { ...(o as object), amount: BigInt(o.amount) } as LedgerEntry;
}

export function toEntryRow(projectId: string, currency: string, c: ChainedEntry): LedgerEntryRow {
  return {
    project_id: projectId,
    seq: c.seq.toString(),
    period_id: c.entry.periodId,
    ref: c.entry.ref,
    kind: c.entry.kind,
    amount: c.entry.amount.toString(),
    currency,
    entry: entryToJson(c.entry),
    prev_hash: c.prevHash,
    entry_hash: c.entryHash,
  };
}

export function fromEntryRow(r: LedgerEntryRow): ChainedEntry {
  return {
    seq: BigInt(String(r.seq)),
    prevHash: r.prev_hash,
    entryHash: r.entry_hash,
    entry: entryFromJson(r.entry),
  };
}

const toPeriod = (r: LedgerPeriodRow): AccountingPeriod => ({
  id: r.id,
  kind: r.kind,
  adjustsPeriodId: r.adjusts_period_id,
  startsOn: String(r.starts_on).slice(0, 10),
  endsOn: String(r.ends_on).slice(0, 10),
  status: r.status,
  approvedBy: r.approved_by,
});

// --- Load and verify -------------------------------------------------------------

export interface StoredLedger {
  ledger: ProjectLedger;
  head: ChainHead;
  chain: ChainedEntry[];
  periods: LedgerPeriodRow[];
}

/**
 * Load a project and prove it hasn't been tampered with: the hash chain must
 * recompute exactly, every row's columns must match its hashed document, and
 * every approved period's stored root must match its entries.
 */
export async function loadLedger(
  repo: LedgerRepo,
  projectId: string,
): Promise<Result<StoredLedger>> {
  const project = await repo.getProject(projectId);
  if (!project) return fail("unknown_reference", `ledger project ${projectId} does not exist`);
  const [periods, rows] = await Promise.all([
    repo.listPeriods(projectId),
    repo.listEntries(projectId),
  ]);

  let chain: ChainedEntry[];
  try {
    chain = rows.map(fromEntryRow);
  } catch (e) {
    return fail("integrity_failure", (e as Error).message);
  }
  for (const [i, r] of rows.entries()) {
    const e = chain[i]!.entry;
    if (
      r.ref !== e.ref ||
      r.kind !== e.kind ||
      r.period_id !== e.periodId ||
      String(r.amount) !== e.amount.toString() ||
      r.currency !== project.currency
    ) {
      return fail("integrity_failure", `row ${String(r.seq)} columns differ from its hashed entry`);
    }
  }
  const check = verifyChain(projectId, project.currency, chain);
  if (!check.ok) {
    return fail("integrity_failure", `hash chain broken at seq ${check.seq}: ${check.reason}`);
  }
  for (const p of periods) {
    if (p.status !== "approved") continue;
    if (p.period_root !== periodRoot(chain, p.id)) {
      return fail("integrity_failure", `approved period ${p.id} no longer matches its root`);
    }
  }

  const base = createLedger(projectId, project.currency as CurrencyCode);
  if (!base.ok) return base;
  const ledger: ProjectLedger = {
    ...base.value,
    periods: periods.map(toPeriod),
    entries: chain.map((c) => c.entry),
  };
  return ok({ ledger, head: check.head, chain, periods });
}

// --- Writes ---------------------------------------------------------------------------

function mapWriteError(message: string): Result<never> {
  const m = message.toLowerCase();
  // Anything the database refuses that isn't one of the known rules is
  // reported as an integrity failure rather than guessed at.
  let code: LedgerErrorCode = "integrity_failure";
  if (m.includes("ledger_version_conflict") || m.includes("ledger_entries_pkey"))
    code = "version_conflict";
  else if (m.includes("project_id_ref") || m.includes("_ref_key")) code = "duplicate_reference";
  else if (m.includes("open period")) code = "period_not_open";
  else if (m.includes("maker-checker")) code = "unauthorised_release";
  else if (m.includes("already exists") || m.includes("duplicate key"))
    code = "duplicate_reference";
  return fail(code, message);
}

export async function createProject(
  repo: LedgerRepo,
  projectId: string,
  currency: CurrencyCode,
): Promise<Result<true>> {
  const pure = createLedger(projectId, currency);
  if (!pure.ok) return pure;
  const w = await repo.insertProject({ id: projectId, currency });
  return w.ok ? ok(true) : mapWriteError(w.message);
}

export async function openPeriod(
  repo: LedgerRepo,
  projectId: string,
  p: { id: string; startsOn: string; endsOn: string; adjustsPeriodId?: string | null },
): Promise<Result<true>> {
  const state = await loadLedger(repo, projectId);
  if (!state.ok) return state;
  const pure = openPure(state.value.ledger, p);
  if (!pure.ok) return pure;
  const w = await repo.insertPeriod({
    project_id: projectId,
    id: p.id,
    kind: p.adjustsPeriodId ? "adjustment" : "regular",
    adjusts_period_id: p.adjustsPeriodId ?? null,
    starts_on: p.startsOn,
    ends_on: p.endsOn,
  });
  return w.ok ? ok(true) : mapWriteError(w.message);
}

/**
 * Validate entries against the stored ledger with the pure rules and append
 * them, chained, in one statement. If anything else appended first the chain
 * head no longer matches and the database refuses the batch (version_conflict).
 */
export async function appendEntries(
  repo: LedgerRepo,
  projectId: string,
  inputs: readonly EntryInput[],
): Promise<Result<{ head: ChainHead; appended: ChainedEntry[] }>> {
  if (inputs.length === 0) return fail("unknown_reference", "nothing to append");
  const state = await loadLedger(repo, projectId);
  if (!state.ok) return state;
  const posted = postAll(state.value.ledger, inputs);
  if (!posted.ok) return posted;
  const currency = state.value.ledger.currency;
  const chained = chainEntries(projectId, currency, state.value.head, inputs);
  const w = await repo.insertEntries(chained.map((c) => toEntryRow(projectId, currency, c)));
  if (!w.ok) return mapWriteError(w.message);
  const last = chained[chained.length - 1]!;
  return ok({ head: { seq: last.seq, hash: last.entryHash }, appended: chained });
}

/** Stop postings to a period. `closedBy` is the preparer. */
export async function closePeriod(
  repo: LedgerRepo,
  projectId: string,
  periodId: string,
  closedBy: string,
): Promise<Result<true>> {
  if (!closedBy.trim())
    return fail("unauthorised_release", "closing a period needs a named preparer");
  const state = await loadLedger(repo, projectId);
  if (!state.ok) return state;
  const pure = closePure(state.value.ledger, periodId);
  if (!pure.ok) return pure;
  const w = await repo.updatePeriod(projectId, periodId, "open", {
    status: "closed",
    closed_by: closedBy,
  });
  if (!w.ok) return mapWriteError(w.message);
  return w.count === 1
    ? ok(true)
    : fail("version_conflict", `period ${periodId} changed meanwhile`);
}

/**
 * Approve a closed period (maker-checker: the approver can't be the preparer)
 * and record the Merkle root of its entries. After this the period is final.
 */
export async function approvePeriod(
  repo: LedgerRepo,
  projectId: string,
  periodId: string,
  approvedBy: string,
): Promise<Result<{ periodRoot: string }>> {
  const state = await loadLedger(repo, projectId);
  if (!state.ok) return state;
  const pure = approvePure(state.value.ledger, periodId, approvedBy);
  if (!pure.ok) return pure;
  const row = state.value.periods.find((p) => p.id === periodId);
  if (row?.closed_by && row.closed_by === approvedBy) {
    return fail(
      "unauthorised_release",
      "maker-checker: the approver must differ from the preparer",
    );
  }
  const root = periodRoot(state.value.chain, periodId);
  const w = await repo.updatePeriod(projectId, periodId, "closed", {
    status: "approved",
    approved_by: approvedBy,
    period_root: root,
  });
  if (!w.ok) return mapWriteError(w.message);
  return w.count === 1
    ? ok({ periodRoot: root })
    : fail("version_conflict", `period ${periodId} changed meanwhile`);
}
