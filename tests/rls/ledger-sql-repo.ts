/**
 * LedgerRepo over raw SQL, for running ledger-store.server.ts against the
 * real migrations in PGlite. Mirrors supabaseLedgerRepo one-for-one.
 */
import type {
  LedgerEntryRow,
  LedgerPeriodRow,
  LedgerProjectRow,
  LedgerRepo,
  RepoWrite,
} from "../../src/lib/ledger-store.server";
import type { Db } from "./harness";

const PERIOD_COLS =
  "project_id, id, kind, adjusts_period_id, starts_on::text AS starts_on, ends_on::text AS ends_on, status, closed_by, approved_by, period_root";
const ENTRY_COLS =
  "project_id, seq::text AS seq, period_id, ref, kind, amount::text AS amount, currency, entry, prev_hash, entry_hash";

/**
 * Each write runs in its own savepoint, like a separate PostgREST request: a
 * refused write is rolled back on its own and later calls keep working.
 */
function writer(db: Db) {
  return async (sql: string, params: unknown[]): Promise<RepoWrite> => {
    await db.exec("SAVEPOINT repo_write");
    try {
      const r = (await db.query(sql, params)) as { rows: unknown[]; affectedRows?: number };
      await db.exec("RELEASE SAVEPOINT repo_write");
      return { ok: true, count: r.rows.length || (r.affectedRows ?? 0) };
    } catch (e) {
      await db.exec("ROLLBACK TO SAVEPOINT repo_write");
      return { ok: false, message: (e as Error).message };
    }
  };
}

export function sqlLedgerRepo(db: Db): LedgerRepo {
  const write = writer(db);
  return {
    async listProjectIds() {
      const r = await db.query<{ id: string }>("SELECT id FROM public.ledger_projects ORDER BY id");
      return r.rows.map((x) => x.id);
    },
    async getProject(id) {
      const r = await db.query<LedgerProjectRow>(
        "SELECT id, currency FROM public.ledger_projects WHERE id = $1",
        [id],
      );
      return r.rows[0] ?? null;
    },
    async listPeriods(projectId) {
      const r = await db.query<LedgerPeriodRow>(
        `SELECT ${PERIOD_COLS} FROM public.ledger_periods WHERE project_id = $1 ORDER BY created_at, id`,
        [projectId],
      );
      return r.rows;
    },
    async listEntries(projectId) {
      const r = await db.query<LedgerEntryRow>(
        `SELECT ${ENTRY_COLS} FROM public.ledger_entries WHERE project_id = $1 ORDER BY seq`,
        [projectId],
      );
      return r.rows;
    },
    insertProject: (row) =>
      write("INSERT INTO public.ledger_projects (id, currency) VALUES ($1, $2)", [
        row.id,
        row.currency,
      ]),
    insertPeriod: (row) =>
      write(
        `INSERT INTO public.ledger_periods (project_id, id, kind, adjusts_period_id, starts_on, ends_on)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.project_id, row.id, row.kind, row.adjusts_period_id, row.starts_on, row.ends_on],
      ),
    async updatePeriod(projectId, periodId, from, patch) {
      const keys = Object.keys(patch) as Array<keyof typeof patch>;
      const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
      return write(
        `UPDATE public.ledger_periods SET ${sets} WHERE project_id = $1 AND id = $2 AND status = $3 RETURNING id`,
        [projectId, periodId, from, ...keys.map((k) => patch[k])],
      );
    },
    insertEntries(rows) {
      // One multi-row statement, like the PostgREST bulk insert.
      const cols = [
        "project_id",
        "seq",
        "period_id",
        "ref",
        "kind",
        "amount",
        "currency",
        "entry",
        "prev_hash",
        "entry_hash",
      ] as const;
      const params: unknown[] = [];
      const values = rows
        .map((r) => {
          const ph = cols.map((c) => {
            params.push(c === "entry" ? JSON.stringify(r.entry) : r[c]);
            return `$${params.length}${c === "entry" ? "::jsonb" : ""}`;
          });
          return `(${ph.join(", ")})`;
        })
        .join(", ");
      return write(
        `INSERT INTO public.ledger_entries (${cols.join(", ")}) VALUES ${values} RETURNING seq`,
        params,
      );
    },
  };
}
