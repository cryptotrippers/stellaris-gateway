/**
 * Sprint 2 E12 — RLS test suite (Security Suite S5.1).
 *
 * Three layers, all against every real migration replayed into PGlite:
 *  1. Invariants that must hold for every table and function.
 *  2. The access surface — RLS flags, table/column grants, policies and
 *     SECURITY DEFINER functions — compared with a reviewed snapshot, so any
 *     migration that changes who can do what shows up as a diff in review.
 *  3. Behaviour — anon, member, operator and admin each try SELECT, INSERT,
 *     UPDATE and DELETE on every table; outcomes must match the reviewed
 *     matrix in access-matrix.expected.json.
 *
 * Changing access on purpose: run with UPDATE_RLS_EXPECTED=1 to rewrite both
 * JSON files, then review the diff like any other security change.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { freshDatabase, loadPglite, type Db } from "./harness";
import { ACTORS, OPS, probe, seed, type ActorName, type Op, type Outcome } from "./matrix";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
const UPDATE = process.env.UPDATE_RLS_EXPECTED === "1";
const SURFACE_FILE = "tests/rls/access-surface.snapshot.json";
const MATRIX_FILE = "tests/rls/access-matrix.expected.json";

let db: Db;
let tables: string[] = [];

before(async () => {
  if (!pg.ok) return;
  db = await freshDatabase(pg.create);
  const r = await db.query<{ t: string }>(
    `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  );
  tables = r.rows.map((x) => x.t);
  await seed(db, tables);
});

// --- 1. Invariants ------------------------------------------------------------------

test("E12: every public table has row-level security enabled", { skip }, async () => {
  const r = await db.query<{ t: string }>(
    `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
  );
  assert.deepEqual(
    r.rows.map((x) => x.t),
    [],
  );
  assert.ok(tables.length >= 36, `expected at least 36 tables, found ${tables.length}`);
});

test("E12: no policy lets anon or everyone write unconditionally", { skip }, async () => {
  const r = await db.query<{ t: string; p: string }>(
    `SELECT tablename AS t, policyname AS p FROM pg_policies
      WHERE schemaname = 'public' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        AND (roles && ARRAY['anon', 'public']::name[])
        AND (coalesce(qual, 'true') = 'true' AND coalesce(with_check, 'true') = 'true')`,
  );
  assert.deepEqual(r.rows, [], "an always-true write policy for anon/public");
});

test("E12: every SECURITY DEFINER function pins its search_path", { skip }, async () => {
  const r = await db.query<{ f: string }>(
    `SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`,
  );
  assert.deepEqual(
    r.rows.map((x) => x.f),
    [],
  );
});

// --- 2. Access surface snapshot -----------------------------------------------------

async function accessSurface(): Promise<Record<string, unknown>> {
  const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
  const rls = await q<{ t: string; rls: boolean; force: boolean }>(
    `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  );
  const grants = await q<{ t: string; g: string; p: string }>(
    `SELECT table_name AS t, grantee AS g, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const columnGrants = await q<{ t: string; g: string; p: string; cols: string }>(
    `SELECT table_name AS t, grantee AS g, privilege_type AS p,
            string_agg(column_name, ',' ORDER BY column_name) AS cols
       FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
        AND (table_name, grantee, privilege_type) NOT IN (
          SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
           WHERE table_schema = 'public')
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  );
  const policies = await q<Record<string, unknown>>(
    `SELECT tablename AS t, policyname AS name, permissive, cmd, roles::text AS roles,
            qual, with_check
       FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`,
  );
  const definers = await q<{ f: string; acl: string }>(
    `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f,
            array_to_string(ARRAY(
              SELECT r FROM unnest(coalesce(p.proacl::text[], '{}')) r
               WHERE r ~ '^(anon|authenticated|)=' ORDER BY r), ' ') AS acl
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`,
  );
  return { rls, grants, columnGrants, policies, definers };
}

test("E12: the access surface matches the reviewed snapshot", { skip }, async () => {
  const now = await accessSurface();
  if (UPDATE || !existsSync(SURFACE_FILE)) {
    writeFileSync(SURFACE_FILE, JSON.stringify(now, null, 2) + "\n");
    if (!UPDATE)
      assert.fail(`${SURFACE_FILE} was missing and has been written — review and commit it`);
    return;
  }
  const expected = JSON.parse(readFileSync(SURFACE_FILE, "utf8"));
  for (const key of Object.keys(expected)) {
    assert.deepEqual(
      now[key],
      expected[key],
      `access surface "${key}" changed — if intended, rerun with UPDATE_RLS_EXPECTED=1 and review the diff`,
    );
  }
});

// --- 3. Behaviour matrix ------------------------------------------------------------

type Matrix = Record<string, Record<ActorName, Record<Op, Outcome>>>;

test(
  "E12: every role × table × operation behaves as reviewed",
  { skip, timeout: 600_000 },
  async () => {
    const observed: Matrix = {};
    for (const t of tables) {
      observed[t] = {} as Matrix[string];
      for (const [name, actor] of Object.entries(ACTORS) as Array<
        [ActorName, (typeof ACTORS)[ActorName]]
      >) {
        observed[t][name] = {} as Record<Op, Outcome>;
        for (const op of OPS) observed[t][name][op] = await probe(db, actor, t, op);
      }
    }
    const cells = tables.length * Object.keys(ACTORS).length * OPS.length;
    assert.ok(cells >= 500, `only ${cells} cases`);

    if (UPDATE || !existsSync(MATRIX_FILE)) {
      writeFileSync(MATRIX_FILE, JSON.stringify(observed, null, 2) + "\n");
      if (!UPDATE)
        assert.fail(`${MATRIX_FILE} was missing and has been written — review and commit it`);
      return;
    }
    const expected = JSON.parse(readFileSync(MATRIX_FILE, "utf8")) as Matrix;
    const diffs: string[] = [];
    for (const t of new Set([...Object.keys(expected), ...tables])) {
      for (const a of Object.keys(ACTORS) as ActorName[]) {
        for (const op of OPS) {
          const want = expected[t]?.[a]?.[op];
          const got = observed[t]?.[a]?.[op];
          if (want !== got)
            diffs.push(`${t} · ${a} · ${op}: expected ${String(want)}, got ${String(got)}`);
        }
      }
    }
    assert.deepEqual(diffs, [], `access changed:\n${diffs.join("\n")}`);
  },
);
