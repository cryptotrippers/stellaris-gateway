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

They need the dev dependency `@electric-sql/pglite`. Without it they skip with
a message, so `npm test` still passes.
