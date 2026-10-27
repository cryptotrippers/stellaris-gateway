/**
 * Sprint 2 — regression tests for the holes the E12 matrix found (migration
 * 0012_governance_integrity): G-7 forged proposals, G-8 operator-set results,
 * G-9 late ballots, G-10 self-set KYC, G-11 edits to published attestations,
 * G-12 un-revoked sessions. Legitimate flows are checked alongside.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { as, freshDatabase, loadPglite, refused, run, USERS, type Db } from "./harness";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
let db: Db;
const { alice, bob, operator, admin } = USERS;

const OPEN = "00000000-0000-4000-9100-000000000001";
const CLOSED = "00000000-0000-4000-9100-000000000002";
const PASSED = "00000000-0000-4000-9100-000000000003";
const ATT = "00000000-0000-4000-9100-000000000004";

before(async () => {
  if (!pg.ok) return;
  db = await freshDatabase(pg.create);
  await db.exec(`
    INSERT INTO public.governance_proposals (id, sip_number, title, status, kind, starts_at, ends_at) VALUES
      ('${OPEN}', 'SIP-1', 'Open', 'active', 'signal', now() - interval '1 day', now() + interval '1 day'),
      ('${CLOSED}', 'SIP-2', 'Closed', 'active', 'signal', now() - interval '3 days', now() - interval '1 hour'),
      ('${PASSED}', 'SIP-3', 'Passed', 'passed', 'accrue', now() - interval '9 days', now() - interval '2 days');
    INSERT INTO public.funding_requests (id, submitted_by, asset_slug, name, category, issuer, status, terms_version, terms_accepted_at)
      VALUES ('00000000-0000-4000-9100-000000000005', '${alice}', 'gi-req', 'R', 'Energy', 'A', 'submitted', 'v', now());
    INSERT INTO public.impact_attestations (id, funding_request_id, attester, methodology, created_by)
      VALUES ('${ATT}', '00000000-0000-4000-9100-000000000005', 'auditor', 'original', '${alice}');
    INSERT INTO public.impact_metrics (attestation_id, metric_name, unit) VALUES ('${ATT}', 'kWh', 'kWh');
    INSERT INTO public.security_sessions (user_id, revoked) VALUES ('${alice}', true);
  `);
});

// --- G-7 / G-8 ------------------------------------------------------------------------

test("G-7: a user cannot create a proposal directly, passed or otherwise", { skip }, async () => {
  for (const status of ["passed", "active", "draft"]) {
    const msg = await refused(
      run(db, as.user(alice), (tx) =>
        tx.query(
          `INSERT INTO public.governance_proposals (sip_number, title, author_user_id, status, kind)
           VALUES ('SIP-F${status}', 'forged', $1, $2, 'set_fee')`,
          [alice, status],
        ),
      ),
    );
    assert.match(msg, /row-level security|through the platform/, status);
  }
});

test("G-7 legit: the platform (service role) creates proposals", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const r = await tx.query<{ status: string }>(
      `INSERT INTO public.governance_proposals (sip_number, title, author_user_id, status, kind)
       VALUES ('SIP-OK', 'ok', $1, 'active', 'signal') RETURNING status`,
      [alice],
    );
    assert.equal(r.rows[0]?.status, "active");
  });
});

test("G-8: an operator cannot set a result or edit a proposal", { skip }, async () => {
  for (const [id, sql] of [
    [CLOSED, `UPDATE public.governance_proposals SET status = 'passed' WHERE id = $1`],
    [
      OPEN,
      `UPDATE public.governance_proposals SET ends_at = now() - interval '1 minute' WHERE id = $1`,
    ],
    [PASSED, `UPDATE public.governance_proposals SET params = '{"fee_bps":500}' WHERE id = $1`],
  ] as const) {
    const msg = await refused(run(db, as.user(operator), (tx) => tx.query(sql, [id])));
    assert.match(msg, /set by finalisation/, sql);
  }
});

test(
  "G-8 legit: an operator records execution of a passed proposal; admins and finalisation set results",
  { skip },
  async () => {
    await run(db, as.user(operator), async (tx) => {
      const r = await tx.query<{ status: string }>(
        `UPDATE public.governance_proposals
          SET status = 'executed', executed_tx_hash = $2, executed_at = now(), executed_epoch = 7
        WHERE id = $1 RETURNING status`,
        [PASSED, "d".repeat(64)],
      );
      assert.equal(r.rows[0]?.status, "executed");
    });
    for (const actor of [as.user(admin), as.service]) {
      await run(db, actor, async (tx) => {
        const r = await tx.query<{ status: string }>(
          `UPDATE public.governance_proposals SET status = 'rejected' WHERE id = $1 RETURNING status`,
          [CLOSED],
        );
        assert.equal(r.rows[0]?.status, "rejected");
      });
    }
  },
);

// --- G-9 --------------------------------------------------------------------------------

test(
  "G-9: users cannot write ballots directly; nobody votes outside the window",
  { skip },
  async () => {
    const direct = await refused(
      run(db, as.user(alice), (tx) =>
        tx.query(
          `INSERT INTO public.proposal_votes (proposal_id, voter_user_id, choice) VALUES ($1, $2, 'for')`,
          [OPEN, alice],
        ),
      ),
    );
    assert.match(direct, /row-level security/);
    for (const id of [CLOSED, PASSED]) {
      const late = await refused(
        run(db, as.service, (tx) =>
          tx.query(
            `INSERT INTO public.proposal_votes (proposal_id, voter_user_id, choice) VALUES ($1, $2, 'for')`,
            [id, alice],
          ),
        ),
      );
      assert.match(late, /not open/, id);
    }
  },
);

test(
  "G-9 legit: the platform records and changes a ballot while voting is open",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      await tx.query(
        `INSERT INTO public.proposal_votes (proposal_id, voter_user_id, choice) VALUES ($1, $2, 'for')`,
        [OPEN, bob],
      );
      const r = await tx.query<{ choice: string }>(
        `UPDATE public.proposal_votes SET choice = 'against' WHERE proposal_id = $1 AND voter_user_id = $2 RETURNING choice`,
        [OPEN, bob],
      );
      assert.equal(r.rows[0]?.choice, "against");
    });
  },
);

test(
  "G-9: a ballot cast while open cannot be changed after the window closes",
  { skip },
  async () => {
    await run(db, as.service, async (tx) => {
      await tx.query(
        `INSERT INTO public.proposal_votes (proposal_id, voter_user_id, choice) VALUES ($1, $2, 'for')`,
        [OPEN, bob],
      );
      await tx.exec(`RESET ROLE`);
      await tx.query(
        `UPDATE public.governance_proposals SET ends_at = now() - interval '1 second' WHERE id = $1`,
        [OPEN],
      );
      await tx.exec(`SET LOCAL ROLE service_role`);
      const msg = await refused(
        tx.query(`UPDATE public.proposal_votes SET choice = 'against' WHERE proposal_id = $1`, [
          OPEN,
        ]),
      );
      assert.match(msg, /not open/);
    });
  },
);

// --- G-10 -------------------------------------------------------------------------------

test("G-10: a user cannot mark their own KYC as verified", { skip }, async () => {
  const msg = await refused(
    run(db, as.user(alice), (tx) =>
      tx.query(`UPDATE public.user_profiles SET kyc_status = 'verified' WHERE user_id = $1`, [
        alice,
      ]),
    ),
  );
  assert.match(msg, /set by review/);
  await run(db, as.user(alice), async (tx) => {
    const r = await tx.query(
      `UPDATE public.user_profiles SET wallet_address = 'addr_test1me' WHERE user_id = $1 RETURNING id`,
      [alice],
    );
    assert.equal(r.rows.length, 1, "other profile fields stay editable");
  });
  await run(db, as.user(admin), async (tx) => {
    const r = await tx.query<{ kyc_status: string }>(
      `UPDATE public.user_profiles SET kyc_status = 'verified' WHERE user_id = $1 RETURNING kyc_status`,
      [alice],
    );
    assert.equal(r.rows.length, 0, "admins don't see other profiles through RLS today");
  });
});

// --- G-11 -------------------------------------------------------------------------------

test(
  "G-11: once published, an attestation and its metrics are frozen for the owner",
  { skip },
  async () => {
    await run(db, as.user(alice), async (tx) => {
      const r = await tx.query(
        `UPDATE public.impact_attestations SET methodology = 'draft edit' WHERE id = $1 RETURNING id`,
        [ATT],
      );
      assert.equal(r.rows.length, 1, "an unpublished attestation stays editable");
    });
    await run(
      db,
      as.user(admin),
      (tx) =>
        tx.query(`UPDATE public.impact_attestations SET published = true WHERE id = $1`, [ATT]),
      { keep: true },
    );
    for (const sql of [
      `UPDATE public.impact_attestations SET methodology = 'forged' WHERE id = $1`,
      `DELETE FROM public.impact_attestations WHERE id = $1`,
      `UPDATE public.impact_metrics SET unit = 'MWh' WHERE attestation_id = $1`,
      `DELETE FROM public.impact_metrics WHERE attestation_id = $1`,
      `INSERT INTO public.impact_metrics (attestation_id, metric_name, unit) VALUES ($1, 'extra', 'x')`,
    ]) {
      const msg = await refused(run(db, as.user(alice), (tx) => tx.query(sql, [ATT])));
      assert.match(msg, /published/, sql);
    }
  },
);

// --- G-12 -------------------------------------------------------------------------------

test(
  "G-12: a revoked session cannot be restored by its owner; revoking still works",
  { skip },
  async () => {
    const msg = await refused(
      run(db, as.user(alice), (tx) =>
        tx.query(`UPDATE public.security_sessions SET revoked = false WHERE user_id = $1`, [alice]),
      ),
    );
    assert.match(msg, /cannot be restored/);
    await run(db, as.user(alice), async (tx) => {
      await tx.query(`INSERT INTO public.security_sessions (user_id) VALUES ($1)`, [alice]);
      const r = await tx.query(
        `UPDATE public.security_sessions SET revoked = true WHERE user_id = $1 AND NOT revoked RETURNING id`,
        [alice],
      );
      assert.equal(r.rows.length, 1);
    });
  },
);
