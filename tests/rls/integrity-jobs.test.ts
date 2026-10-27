// Sprint 2 E10 — the nightly ledger check against the real migrations:
// clean projects pass; a row edited with direct database access is reported.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { as, freshDatabase, loadPglite, run, type Db } from "./harness";
import { sqlLedgerRepo } from "./ledger-sql-repo";
import { appendEntries, createProject, openPeriod } from "../../src/lib/ledger-store.server";
import { runIntegrityJobs } from "../../src/lib/integrity-jobs.server";
import { AUD, P1, must, solarEntries } from "../../src/lib/__fixtures__/meridian";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
let db: Db;
before(async () => {
  if (pg.ok) db = await freshDatabase(pg.create);
});

test("E10: the nightly check passes clean ledgers and names a tampered one", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    for (const p of ["proj-clean", "proj-tampered"]) {
      must(await createProject(repo, p, AUD));
      must(await openPeriod(repo, p, { id: P1, startsOn: "2026-07-01", endsOn: "2027-06-30" }));
      must(await appendEntries(repo, p, solarEntries()));
    }
    const clean = await runIntegrityJobs({ ledger: repo });
    assert.equal(clean.ok, true);
    assert.equal(clean.checks.ledger!.checked, 2);

    await tx.exec("RESET ROLE");
    await tx.exec("SET LOCAL session_replication_role = replica");
    await tx.query(
      `UPDATE public.ledger_entries SET amount = amount * 2,
              entry = jsonb_set(entry, '{amount}', to_jsonb((amount * 2)::text))
        WHERE project_id = 'proj-tampered' AND seq = 2`,
    );
    await tx.exec("SET LOCAL session_replication_role = origin");
    await tx.exec("SET LOCAL ROLE service_role");

    const after = await runIntegrityJobs({ ledger: repo });
    assert.equal(after.ok, false);
    assert.deepEqual(
      after.failures.map((f) => [f.subject, f.code]),
      [["proj-tampered", "integrity_failure"]],
    );
  });
});
