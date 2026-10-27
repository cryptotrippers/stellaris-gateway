# RLS and trigger tests

These tests replay every real migration (`supabase/migrations/` in filename
order, then `drizzle/migrations/` in journal order) into an in-process Postgres
([PGlite](https://pglite.dev)) and then act as anon, signed-in users and the
service role exactly the way Supabase's API does. Nothing touches the live
database.

- `supabase-stub.sql` — the few Supabase pieces the migrations need
  (`auth.uid()`, `auth.users`, the API roles, storage tables).
- `harness.ts` — replay, actors, `run()` (always rolls back) and `refused()`.
- `funding-integrity.test.ts` — Sprint 1 E01: the audit's attack table.
- `ledger-store.test.ts` + `ledger-sql-repo.ts` — Sprint 1 E03: the Meridian ledger
  persisted, reloaded to the cent, tamper-checked and append-only.
- `access-matrix.test.ts` + `matrix.ts` — Sprint 2 E12: invariants for every table and
  function, a reviewed snapshot of the access surface (`access-surface.snapshot.json`) and
  the role × table × operation matrix (`access-matrix.expected.json`, 576 cells). Changing
  access on purpose: `UPDATE_RLS_EXPECTED=1 npm test -- tests/rls/access-matrix.test.ts`,
  then review the JSON diff like any other security change.
- `governance-integrity.test.ts` — regression tests for G-7 to G-12 (migration 0012).

They run on the dev dependency `@electric-sql/pglite` (pinned, installed by
`bun install`), so CI runs them on every pull request. If it is ever missing
they skip with a message instead of failing.
