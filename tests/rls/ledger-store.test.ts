/**
 * Sprint 1 E03 — the Meridian ledger persisted through the real migrations.
 *
 * Acceptance: the solar fixture round-trips through the database to the cent;
 * a tampered row is detected; entries are append-only; a stale writer loses
 * the compare-and-swap; duplicate references, closed periods, self-approval
 * and Rail A ids are refused by the store AND by the database itself.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { as, freshDatabase, loadPglite, refused, run, USERS, type Db } from "./harness";
import { sqlLedgerRepo } from "./ledger-sql-repo";
import {
  appendEntries,
  approvePeriod,
  closePeriod,
  createProject,
  loadLedger,
  openPeriod,
  toEntryRow,
  type LedgerRepo,
} from "../../src/lib/ledger-store.server";
import { chainEntries, EMPTY_HEAD } from "../../src/lib/ledger-hash.shared";
import { computeWaterfall } from "../../src/lib/asset-cashflow.shared";
import { AUD, P1, PROJECT, must, receipt, solarEntries } from "../../src/lib/__fixtures__/meridian";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
let db: Db;

before(async () => {
  if (pg.ok) db = await freshDatabase(pg.create);
});

async function seedSolar(repo: LedgerRepo) {
  must(await createProject(repo, PROJECT, AUD));
  must(await openPeriod(repo, PROJECT, { id: P1, startsOn: "2026-07-01", endsOn: "2027-06-30" }));
  return must(await appendEntries(repo, PROJECT, solarEntries()));
}

/** Act as a superuser with triggers off: what someone with raw DB access could do. */
async function asRawDatabase(tx: Db, sql: string, params: unknown[] = []) {
  await tx.exec("RESET ROLE");
  await tx.exec("SET LOCAL session_replication_role = replica");
  await tx.query(sql, params);
  await tx.exec("SET LOCAL session_replication_role = origin");
  await tx.exec("SET LOCAL ROLE service_role");
}

test("E03: the solar fixture round-trips through the database to the cent", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    const appended = await seedSolar(repo);
    assert.equal(appended.head.seq, 9n);

    const loaded = must(await loadLedger(repo, PROJECT));
    assert.deepEqual(loaded.ledger.entries, solarEntries());
    assert.equal(loaded.head.hash, appended.head.hash);

    const w = must(computeWaterfall(loaded.ledger, P1));
    assert.equal(w.distributable, 9_000_000n, "AUD 90,000.00 distributable, as the pure model");

    must(await closePeriod(repo, PROJECT, P1, "preparer-1"));
    const approved = must(await approvePeriod(repo, PROJECT, P1, "board"));
    assert.match(approved.periodRoot, /^[0-9a-f]{64}$/);

    const again = must(await loadLedger(repo, PROJECT));
    assert.equal(again.ledger.periods[0]?.status, "approved");
    assert.equal(again.periods[0]?.period_root, approved.periodRoot);
    assert.deepEqual(again.ledger.entries, solarEntries());
  });
});

test("E03: a tampered amount is detected on load", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    await seedSolar(repo);
    await asRawDatabase(
      tx,
      `UPDATE public.ledger_entries
          SET amount = amount + 1, entry = jsonb_set(entry, '{amount}', to_jsonb((amount + 1)::text))
        WHERE project_id = $1 AND seq = 5`,
      [PROJECT],
    );
    const r = await loadLedger(repo, PROJECT);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "integrity_failure");
    assert.match(r.error.message, /seq 5/);
    // And nothing more can be appended on top of a broken chain.
    const more = await appendEntries(repo, PROJECT, [receipt("BANK-LATE", 1n)]);
    assert.ok(!more.ok);
    assert.equal(more.error.code, "integrity_failure");
  });
});

test("E03: a deleted row or a rewritten period root is detected", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    await seedSolar(repo);
    must(await closePeriod(repo, PROJECT, P1, "preparer-1"));
    must(await approvePeriod(repo, PROJECT, P1, "board"));
    await asRawDatabase(
      tx,
      `UPDATE public.ledger_periods SET period_root = repeat('a', 64) WHERE project_id = $1`,
      [PROJECT],
    );
    const r = await loadLedger(repo, PROJECT);
    assert.ok(!r.ok);
    assert.match(r.error.message, /no longer matches its root/);
  });
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    await seedSolar(repo);
    await asRawDatabase(tx, `DELETE FROM public.ledger_entries WHERE project_id = $1 AND seq = 9`, [
      PROJECT,
    ]);
    // Removing the last row leaves a valid shorter chain; removing a middle one doesn't.
    await asRawDatabase(tx, `DELETE FROM public.ledger_entries WHERE project_id = $1 AND seq = 3`, [
      PROJECT,
    ]);
    const r = await loadLedger(repo, PROJECT);
    assert.ok(!r.ok);
    assert.match(r.error.message, /seq 4/);
  });
});

test("E03: entries are append-only, even for the service role", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    await seedSolar(sqlLedgerRepo(tx));
    for (const sql of [
      `UPDATE public.ledger_entries SET amount = 1 WHERE project_id = '${PROJECT}' AND seq = 1`,
      `DELETE FROM public.ledger_entries WHERE project_id = '${PROJECT}'`,
      `TRUNCATE public.ledger_entries`,
      `DELETE FROM public.ledger_periods WHERE project_id = '${PROJECT}'`,
      `UPDATE public.ledger_projects SET currency = 'USD' WHERE id = '${PROJECT}'`,
    ]) {
      const msg = await refused(tx.query(`SAVEPOINT s; ${""}`).then(() => tx.query(sql)));
      assert.match(msg, /append-only|cannot be deleted|permission denied/, sql);
      await tx.exec("ROLLBACK TO SAVEPOINT s");
    }
  });
});

test("E03: a stale writer loses the compare-and-swap", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    await seedSolar(repo);
    // A batch computed against the empty ledger (an out-of-date head).
    const stale = chainEntries(PROJECT, AUD, EMPTY_HEAD, [receipt("BANK-STALE", 100n)]);
    const w = await repo.insertEntries(stale.map((c) => toEntryRow(PROJECT, AUD, c)));
    assert.ok(!w.ok);
    assert.match(w.message, /ledger_version_conflict/);

    // A writer whose read raced another append.
    const racing: LedgerRepo = { ...repo, listEntries: async () => [] };
    const r = await appendEntries(racing, PROJECT, [receipt("BANK-RACE", 100n)]);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "version_conflict");
  });
});

test(
  "E03: duplicate references and closed periods are refused by store and database",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      const repo = sqlLedgerRepo(tx);
      const seeded = await seedSolar(repo);
      const dup = await appendEntries(repo, PROJECT, [receipt("BANK-ELEC-2027", 5n)]);
      assert.ok(!dup.ok);
      assert.equal(dup.error.code, "duplicate_reference");

      // Bypassing the store: the database still refuses the duplicate ref.
      const forged = chainEntries(PROJECT, AUD, seeded.head, [receipt("BANK-ELEC-2027", 5n)]);
      const w = await repo.insertEntries(forged.map((c) => toEntryRow(PROJECT, AUD, c)));
      assert.ok(!w.ok);
      assert.match(w.message, /ledger_entries_project_id_ref_key|duplicate key/);

      must(await closePeriod(repo, PROJECT, P1, "preparer-1"));
      const late = await appendEntries(repo, PROJECT, [receipt("BANK-LATE", 5n)]);
      assert.ok(!late.ok);
      assert.equal(late.error.code, "period_not_open");
      const raw = chainEntries(PROJECT, AUD, seeded.head, [receipt("BANK-LATE", 5n)]);
      const w2 = await repo.insertEntries(raw.map((c) => toEntryRow(PROJECT, AUD, c)));
      assert.ok(!w2.ok);
      assert.match(w2.message, /open period/);
    });
  },
);

test(
  "E03: maker-checker — the preparer cannot approve, and approval is final",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      const repo = sqlLedgerRepo(tx);
      await seedSolar(repo);
      must(await closePeriod(repo, PROJECT, P1, "preparer-1"));
      const self = await approvePeriod(repo, PROJECT, P1, "preparer-1");
      assert.ok(!self.ok);
      assert.equal(self.error.code, "unauthorised_release");
      const direct = await repo.updatePeriod(PROJECT, P1, "closed", {
        status: "approved",
        approved_by: "preparer-1",
        period_root: "b".repeat(64),
      });
      assert.ok(!direct.ok);
      assert.match(direct.message, /maker-checker/);

      must(await approvePeriod(repo, PROJECT, P1, "board"));
      const reopen = await repo.updatePeriod(PROJECT, P1, "approved", { status: "open" });
      assert.ok(!reopen.ok);
      assert.match(reopen.message, /cannot move from approved/);
    });
  },
);

test("E03: Rail A ids and units are refused (I-B9)", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    const a = await createProject(repo, "tessera:preprod-v1", AUD);
    assert.ok(!a.ok);
    const b = await createProject(repo, "solar-b", "TSRA");
    assert.ok(!b.ok);
    const msg = await refused(
      tx.query(`INSERT INTO public.ledger_projects (id, currency) VALUES ('tessera:x', 'AUD')`),
    );
    assert.match(msg, /rail_b/);
  });
});

test("E03: browsers can't write the ledger; only admins can read it", { skip }, async () => {
  await run(db, as.service, (tx) => seedSolar(sqlLedgerRepo(tx)), { keep: true });
  const anonRead = await refused(
    run(db, as.anon, (tx) => tx.query("SELECT 1 FROM public.ledger_entries")),
  );
  assert.match(anonRead, /permission denied/);
  await run(db, as.user(USERS.alice), async (tx) => {
    const r = await tx.query("SELECT 1 FROM public.ledger_entries");
    assert.equal(r.rows.length, 0, "a normal user sees nothing");
  });
  await run(db, as.user(USERS.admin), async (tx) => {
    const r = await tx.query("SELECT 1 FROM public.ledger_entries");
    assert.equal(r.rows.length, 9, "an admin can read");
  });
  for (const actor of [as.user(USERS.alice), as.user(USERS.admin), as.user(USERS.operator)]) {
    const msg = await refused(
      run(db, actor, (tx) =>
        tx.query(`INSERT INTO public.ledger_projects (id, currency) VALUES ('x', 'AUD')`),
      ),
    );
    assert.match(msg, /permission denied/);
  }
});
