/**
 * RLS test harness (Sprint 1 E01; the base for E12).
 *
 * Replays every real migration — supabase/migrations in filename order, then
 * the Drizzle track in journal order — into an in-process Postgres (PGlite),
 * then lets a test act as anon, a signed-in user or the service role the way
 * PostgREST does: `SET LOCAL ROLE` plus the JWT subject in
 * `request.jwt.claim.sub`.
 *
 * PGlite is an optional dev dependency. When it isn't installed the suites
 * that need it skip with a clear message instead of failing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

type Row = Record<string, unknown>;
export interface Db {
  exec(sql: string): Promise<unknown>;
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export type Actor = { kind: "anon" } | { kind: "service" } | { kind: "user"; id: string };

export const USERS = {
  admin: "00000000-0000-4000-8000-00000000000a",
  alice: "00000000-0000-4000-8000-0000000000a1",
  bob: "00000000-0000-4000-8000-0000000000b0",
  operator: "00000000-0000-4000-8000-0000000000c0",
} as const;

export const as = {
  anon: { kind: "anon" } as Actor,
  service: { kind: "service" } as Actor,
  user: (id: string): Actor => ({ kind: "user", id }),
};

/** Migration files in the order the live database applied them. */
export function migrationFiles(): string[] {
  const supa = readdirSync(join(ROOT, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `supabase/migrations/${f}`);
  const journal = JSON.parse(
    readFileSync(join(ROOT, "drizzle/migrations/meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const drizzle = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => `drizzle/migrations/${e.tag}.sql`);
  return [...supa, ...drizzle];
}

/** Load PGlite if installed; otherwise return the reason it's unavailable. */
export async function loadPglite(): Promise<
  { ok: true; create: () => Db } | { ok: false; reason: string }
> {
  try {
    const mod = (await import("@electric-sql/pglite" as string)) as {
      PGlite: new () => Db;
    };
    return { ok: true, create: () => new mod.PGlite() };
  } catch {
    return {
      ok: false,
      reason:
        "@electric-sql/pglite is not installed — RLS tests skipped (see tests/rls/README.md).",
    };
  }
}

// The admin-bootstrap retirement migration refuses to run until an
// email-verified admin exists, exactly as it did on the live database.
const BEFORE: Record<string, string> = {
  "supabase/migrations/20260809034647_9e3eddcc-6622-460d-951c-651dd2d1813c.sql": `
    INSERT INTO auth.users (id, email, email_confirmed_at)
    VALUES ('${USERS.admin}', 'admin@example.test', now());
    INSERT INTO public.user_roles (user_id, role) VALUES ('${USERS.admin}', 'admin');`,
};

/** A fresh database with every migration applied and the test users seeded. */
export async function freshDatabase(create: () => Db): Promise<Db> {
  const db = create();
  await db.exec(readFileSync(join(ROOT, "tests/rls/supabase-stub.sql"), "utf8"));
  for (const file of migrationFiles()) {
    if (BEFORE[file]) await db.exec(BEFORE[file]);
    try {
      await db.exec(readFileSync(join(ROOT, file), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
  await db.exec(`
    INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
      ('${USERS.alice}', 'alice@example.test', now()),
      ('${USERS.bob}', 'bob@example.test', now()),
      ('${USERS.operator}', 'operator@example.test', now());
    INSERT INTO public.user_roles (user_id, role) VALUES ('${USERS.operator}', 'operator');
  `);
  return db;
}

/**
 * Run `fn` as `actor` inside a transaction that is always rolled back unless
 * `keep` is set, so tests don't leak state into each other.
 */
export async function run<T>(
  db: Db,
  actor: Actor,
  fn: (tx: Db) => Promise<T>,
  { keep = false }: { keep?: boolean } = {},
): Promise<T> {
  const ROLLBACK = Symbol("rollback");
  let out: T | undefined;
  try {
    await db.transaction(async (tx) => {
      if (actor.kind === "user") {
        await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [actor.id]);
        await tx.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
        await tx.exec("SET LOCAL ROLE authenticated");
      } else if (actor.kind === "anon") {
        await tx.query(`SELECT set_config('request.jwt.claim.role', 'anon', true)`);
        await tx.exec("SET LOCAL ROLE anon");
      } else {
        await tx.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`);
        await tx.exec("SET LOCAL ROLE service_role");
      }
      out = await fn(tx);
      if (!keep) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
}

/** Expect `fn` to be refused; returns the database's message. */
export async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("Expected the database to refuse this, but it succeeded.");
}
