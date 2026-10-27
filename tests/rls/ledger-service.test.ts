/**
 * Sprint 2 E04 — ledger server rules end to end on the real migrations:
 * roles, maker-checker, recorder identity and the Sourced read model.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { as, freshDatabase, loadPglite, run, USERS, type Db } from "./harness";
import { sqlLedgerRepo } from "./ledger-sql-repo";
import {
  approveLedgerPeriod,
  closeLedgerPeriod,
  createLedgerProject,
  openLedgerPeriod,
  readPeriodFinancials,
  recordLedgerEntries,
  type LedgerActor,
} from "../../src/lib/ledger-service.server";
import { entryToJson } from "../../src/lib/ledger-store.server";
import { solarEntries } from "../../src/lib/__fixtures__/meridian";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
let db: Db;
before(async () => {
  if (pg.ok) db = await freshDatabase(pg.create);
});

const admin: LedgerActor = { userId: USERS.admin, roles: ["admin"] };
const admin2: LedgerActor = { userId: "00000000-0000-4000-8000-0000000000a2", roles: ["admin"] };
const operator: LedgerActor = { userId: USERS.operator, roles: ["operator"] };
const member: LedgerActor = { userId: USERS.alice, roles: [] };
const P = "solar-farm-alpha";

const entriesBy = (userId: string) =>
  solarEntries("FY2027").map((e) =>
    entryToJson({ ...e, provenance: { ...e.provenance, recordedBy: userId } }),
  );

async function setup(repo: ReturnType<typeof sqlLedgerRepo>) {
  assert.ok((await createLedgerProject(repo, admin, P, "AUD")).ok);
  assert.ok(
    (
      await openLedgerPeriod(repo, admin, P, {
        id: "FY2027",
        startsOn: "2026-07-01",
        endsOn: "2027-06-30",
      })
    ).ok,
  );
  const rec = await recordLedgerEntries(repo, admin, P, entriesBy(admin.userId) as unknown[]);
  assert.ok(rec.ok, rec.ok ? "" : rec.error.message);
  assert.equal(rec.value.appended, 9);
}

test(
  "E04: members can't read or write ledgers; operators read but can't create or approve",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      const repo = sqlLedgerRepo(tx);
      await setup(repo);
      for (const r of [
        await readPeriodFinancials(repo, member, P, "FY2027"),
        await createLedgerProject(repo, member, "x-proj", "AUD"),
        await createLedgerProject(repo, operator, "x-proj", "AUD"),
        await recordLedgerEntries(repo, operator, P, entriesBy(operator.userId) as unknown[]),
        await closeLedgerPeriod(repo, member, P, "FY2027"),
      ]) {
        assert.ok(!r.ok);
        assert.equal(r.error.code, "unauthorised_release");
      }
      const read = await readPeriodFinancials(repo, operator, P, "FY2027");
      assert.ok(read.ok);
      assert.equal(read.value.meta.verification, "self_reported");
    });
  },
);

test("E04: entries must name the signed-in user as recorder", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const repo = sqlLedgerRepo(tx);
    assert.ok((await createLedgerProject(repo, admin, P, "AUD")).ok);
    assert.ok(
      (
        await openLedgerPeriod(repo, admin, P, {
          id: "FY2027",
          startsOn: "2026-07-01",
          endsOn: "2027-06-30",
        })
      ).ok,
    );
    const r = await recordLedgerEntries(repo, admin, P, entriesBy("someone-else") as unknown[]);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "missing_provenance");
  });
});

test(
  "E04: preparer ≠ approver; the approved period is served as reviewed to the cent",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      const repo = sqlLedgerRepo(tx);
      await setup(repo);
      assert.ok((await closeLedgerPeriod(repo, operator, P, "FY2027")).ok);
      const op = await approveLedgerPeriod(repo, operator, P, "FY2027");
      assert.ok(!op.ok, "operators can't approve");
      const self = await approveLedgerPeriod(
        repo,
        { userId: operator.userId, roles: ["admin", "operator"] },
        P,
        "FY2027",
      );
      assert.ok(!self.ok, "the preparer can't approve their own period");
      const ok = await approveLedgerPeriod(repo, admin, P, "FY2027");
      assert.ok(ok.ok);
      const f = await readPeriodFinancials(repo, admin2, P, "FY2027");
      assert.ok(f.ok);
      assert.equal(f.value.value.distributable, "9000000");
      assert.equal(f.value.value.periodRoot, ok.value.periodRoot);
      assert.equal(f.value.value.approvedBy, admin.userId);
      assert.equal(f.value.meta.verification, "reviewed");
    });
  },
);
