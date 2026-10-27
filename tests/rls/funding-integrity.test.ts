/**
 * Sprint 1 E01 — the engineering audit's attack table, run against the real
 * migrations. Every attack is made as a signed-in, non-admin user calling the
 * database directly with the public key (what a hostile browser can do).
 * Legitimate flows are tested alongside so the fixes don't break the product.
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { as, freshDatabase, loadPglite, refused, run, USERS, type Db } from "./harness";

const pg = await loadPglite();
const skip = pg.ok ? false : pg.reason;
let db: Db;

before(async () => {
  if (pg.ok) db = await freshDatabase(pg.create);
});

const { alice, bob, admin, operator } = USERS;

function requestRow(over: Record<string, unknown> = {}) {
  const slug = `asset-${Math.random().toString(36).slice(2, 10)}`;
  return {
    submitted_by: alice,
    asset_slug: slug,
    name: "Rooftop solar",
    category: "Energy",
    issuer: "Alice Solar Pty Ltd",
    status: "submitted",
    terms_version: "2026-10",
    terms_accepted_at: new Date().toISOString(),
    treasury_address: "addr_test1alice",
    ...over,
  };
}

// Columns signed-in users may read back (issuers hides registration_number
// and contact_email from the API since 23 Oct, as the live app does).
const RETURNING: Record<string, string> = {
  issuers: "id, owner_user_id, legal_name, verification_status, verified_at",
};

async function insert(tx: Db, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const res = await tx.query<Record<string, unknown>>(
    `INSERT INTO public.${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${RETURNING[table] ?? "*"}`,
    cols.map((c) => row[c]),
  );
  return res.rows[0];
}

/** Insert as the service role and keep it (fixture setup). */
async function seed(table: string, row: Record<string, unknown>) {
  return run(db, as.service, (tx) => insert(tx, table, row), { keep: true });
}

// --- 1. Skip approval stages ------------------------------------------------

test(
  "attack 1a: a user cannot insert a funding request that is already approved",
  { skip },
  async () => {
    for (const status of ["approved", "proposed", "asset_created", "funded"]) {
      const msg = await refused(
        run(db, as.user(alice), (tx) => insert(tx, "funding_requests", requestRow({ status }))),
      );
      assert.match(msg, /draft or submitted/, status);
    }
  },
);

test("attack 1b: a user cannot attach a proposal or asset on insert", { skip }, async () => {
  const msg = await refused(
    run(db, as.user(alice), (tx) => insert(tx, "funding_requests", requestRow({ asset_id: "x" }))),
  );
  assert.match(msg, /attached by the platform|foreign key/);
});

test("attack 1c: a user cannot move their own draft past submitted", { skip }, async () => {
  const draft = await seed(
    "funding_requests",
    requestRow({ status: "draft", terms_version: null, terms_accepted_at: null }),
  );
  const msg = await refused(
    run(db, as.user(alice), (tx) =>
      tx.query(
        `UPDATE public.funding_requests SET status = 'approved', terms_version = 'v', terms_accepted_at = now() WHERE id = $1`,
        [draft.id],
      ),
    ),
  );
  assert.match(msg, /later stages are set by the platform/);
});

test("legit: a user submits a request and saves then submits a draft", { skip }, async () => {
  await run(db, as.user(alice), async (tx) => {
    const sub = await insert(tx, "funding_requests", requestRow());
    assert.equal(sub.status, "submitted");
    const d = await insert(
      tx,
      "funding_requests",
      requestRow({ status: "draft", terms_version: null, terms_accepted_at: null }),
    );
    const upd = await tx.query<{ status: string }>(
      `UPDATE public.funding_requests SET name = 'Edited', status = 'submitted', terms_version = 'v', terms_accepted_at = now() WHERE id = $1 RETURNING status`,
      [d.id],
    );
    assert.equal(upd.rows[0]?.status, "submitted");
  });
});

test(
  "legit: an admin and the backend can move a request through later stages",
  { skip },
  async () => {
    const r = await seed("funding_requests", requestRow());
    await run(db, as.user(admin), async (tx) => {
      const res = await tx.query<{ status: string }>(
        `UPDATE public.funding_requests SET status = 'proposed' WHERE id = $1 RETURNING status`,
        [r.id],
      );
      assert.equal(res.rows[0]?.status, "proposed");
      const log = await tx.query(
        `SELECT 1 FROM public.security_audit_log WHERE action = 'funding_request_status_changed' AND detail->>'funding_request_id' = $1`,
        [r.id],
      );
      assert.equal(log.rows.length, 1, "admin stage moves are audit-logged");
    });
    await run(db, as.service, async (tx) => {
      const res = await tx.query<{ status: string }>(
        `UPDATE public.funding_requests SET status = 'asset_created' WHERE id = $1 RETURNING status`,
        [r.id],
      );
      assert.equal(res.rows[0]?.status, "asset_created");
    });
  },
);

// --- 2. Forge verification status --------------------------------------------

test("attack 2a: inserting an issuer as verified is stored as unverified", { skip }, async () => {
  await run(db, as.user(alice), async (tx) => {
    const row = await insert(tx, "issuers", {
      owner_user_id: alice,
      legal_name: "Alice Solar Pty Ltd",
      jurisdiction: "AU",
      verification_status: "verified",
      verified_at: new Date().toISOString(),
    });
    assert.equal(row.verification_status, "unverified");
    assert.equal(row.verified_at, null);
  });
});

test("attack 2b: a user cannot verify their own issuer by update", { skip }, async () => {
  const iss = await seed("issuers", { owner_user_id: alice, legal_name: "A", jurisdiction: "AU" });
  const msg = await refused(
    run(db, as.user(alice), (tx) =>
      tx.query(`UPDATE public.issuers SET verification_status = 'verified' WHERE id = $1`, [
        iss.id,
      ]),
    ),
  );
  assert.match(msg, /Only an admin can verify/);
});

test(
  "attack 2c: changing legal identity on a verified issuer sends it back to pending",
  { skip },
  async () => {
    const iss = await seed("issuers", {
      owner_user_id: alice,
      legal_name: "Alice Solar Pty Ltd",
      jurisdiction: "AU",
      verification_status: "verified",
    });
    await run(db, as.user(alice), async (tx) => {
      const res = await tx.query<{ verification_status: string; verified_at: unknown }>(
        `UPDATE public.issuers SET legal_name = 'Someone Else Ltd' WHERE id = $1 RETURNING verification_status, verified_at`,
        [iss.id],
      );
      assert.equal(res.rows[0]?.verification_status, "pending");
      assert.equal(res.rows[0]?.verified_at, null);
    });
    await run(db, as.user(alice), async (tx) => {
      const res = await tx.query<{ verification_status: string }>(
        `UPDATE public.issuers SET website = 'https://alice.example' WHERE id = $1 RETURNING verification_status`,
        [iss.id],
      );
      assert.equal(
        res.rows[0]?.verification_status,
        "verified",
        "non-identity edits keep the status",
      );
    });
  },
);

test(
  "attack 2d: a user cannot link a request to someone else's verified issuer",
  { skip },
  async () => {
    const bobs = await seed("issuers", {
      owner_user_id: bob,
      legal_name: "Bob Verified Ltd",
      jurisdiction: "AU",
      verification_status: "verified",
    });
    const msg = await refused(
      run(db, as.user(alice), (tx) =>
        insert(tx, "funding_requests", requestRow({ issuer_id: bobs.id })),
      ),
    );
    assert.match(msg, /issuer profile you own/);
  },
);

test("legit: an admin verifies an issuer", { skip }, async () => {
  const iss = await seed("issuers", { owner_user_id: alice, legal_name: "A2", jurisdiction: "AU" });
  await run(db, as.user(admin), async (tx) => {
    const res = await tx.query<{ verification_status: string; verified_at: unknown }>(
      `UPDATE public.issuers SET verification_status = 'verified' WHERE id = $1 RETURNING verification_status, verified_at`,
      [iss.id],
    );
    assert.equal(res.rows[0]?.verification_status, "verified");
    assert.notEqual(res.rows[0]?.verified_at, null);
  });
});

// --- 3. Modify approved evidence ---------------------------------------------

test(
  "attack 3: editing evidence on a verified checklist item sends it back for review",
  { skip },
  async () => {
    const r = await seed("funding_requests", requestRow());
    const item = await run(
      db,
      as.user(admin),
      (tx) =>
        insert(tx, "funding_request_checklist", {
          funding_request_id: r.id,
          item_key: "insurance",
          status: "verified",
          evidence_url: "https://evidence.example/policy-v1.pdf",
        }),
      { keep: true },
    );
    assert.equal(item.status, "verified");
    await run(db, as.user(alice), async (tx) => {
      const res = await tx.query<{ status: string; verified_by: unknown; verified_at: unknown }>(
        `UPDATE public.funding_request_checklist SET evidence_url = 'https://evidence.example/forged.pdf' WHERE id = $1 RETURNING status, verified_by, verified_at`,
        [item.id],
      );
      assert.equal(res.rows[0]?.status, "submitted");
      assert.equal(res.rows[0]?.verified_by, null);
      assert.equal(res.rows[0]?.verified_at, null);
    });
    const pending = await run(
      db,
      as.user(alice),
      (tx) =>
        insert(tx, "funding_request_checklist", {
          funding_request_id: r.id,
          item_key: "asset_title",
          status: "submitted",
          evidence_url: "https://evidence.example/title.pdf",
        }),
      { keep: true },
    );
    const msg = await refused(
      run(db, as.user(alice), (tx) =>
        tx.query(`UPDATE public.funding_request_checklist SET status = 'verified' WHERE id = $1`, [
          pending.id,
        ]),
      ),
    );
    assert.match(msg, /Only an admin can verify/);
  },
);

// --- 4. Publish an offering ---------------------------------------------------

test("attack 4: a user cannot publish an offering or register a vault", { skip }, async () => {
  await seed("assets", { id: "solar-x", name: "Solar X", category: "Energy", issuer: "Alice" });
  const offering = await refused(
    run(db, as.user(alice), (tx) =>
      insert(tx, "offerings", {
        asset_id: "solar-x",
        script_hash: "aa",
        script_address: "addr_test1x",
        fraction_policy_id: "bb",
        fraction_asset_name_hex: "cc",
        total_fractions: 100,
        price_per_fraction: 1_000_000,
        issuer_name: "Alice",
      }),
    ),
  );
  assert.match(offering, /row-level security|permission denied/);
});

// --- 5. Change a payout destination -------------------------------------------

test("attack 5: the payout address is locked once a request leaves draft", { skip }, async () => {
  const r = await seed("funding_requests", requestRow());
  await run(db, as.user(alice), async (tx) => {
    // RLS hides non-draft rows from the submitter's UPDATE: nothing changes.
    await tx.query(
      `UPDATE public.funding_requests SET treasury_address = 'addr_test1attacker' WHERE id = $1`,
      [r.id],
    );
  });
  const after = await run(db, as.service, (tx) =>
    tx.query<{ treasury_address: string }>(
      `SELECT treasury_address FROM public.funding_requests WHERE id = $1`,
      [r.id],
    ),
  );
  assert.equal(after.rows[0]?.treasury_address, "addr_test1alice");
  // Even an admin session can't redirect it.
  const msg = await refused(
    run(db, as.user(admin), (tx) =>
      tx.query(
        `UPDATE public.funding_requests SET treasury_address = 'addr_test1attacker' WHERE id = $1`,
        [r.id],
      ),
    ),
  );
  assert.match(msg, /payout address is locked/);
});

// --- 7. Manipulate financial records ------------------------------------------

test(
  "attack 7: an operator cannot insert yield accruals or fee schedules directly",
  { skip },
  async () => {
    const accrual = await refused(
      run(db, as.user(operator), (tx) =>
        insert(tx, "yield_accruals", {
          asset_id: "solar-x",
          vault_version: 5,
          tx_hash: "f".repeat(64),
          epoch: 1,
          amount_lovelace: 1,
          total_assets_after: 1,
          total_shares_after: 1,
          block_time: new Date().toISOString(),
        }),
      ),
    );
    assert.match(accrual, /row-level security/);
    const fee = await refused(
      run(db, as.user(operator), (tx) =>
        insert(tx, "vault_fee_schedules", {
          asset_id: "solar-x",
          vault_version: 5,
          fee_bps: 0,
          treasury_address: "addr_test1attacker",
        }),
      ),
    );
    assert.match(fee, /row-level security/);
  },
);

test("legit: the backend still records chain-verified accruals", { skip }, async () => {
  await run(db, as.service, async (tx) => {
    const row = await insert(tx, "yield_accruals", {
      asset_id: "solar-x",
      vault_version: 5,
      tx_hash: "e".repeat(64),
      epoch: 1,
      amount_lovelace: 1,
      total_assets_after: 1,
      total_shares_after: 1,
      block_time: new Date().toISOString(),
    });
    assert.equal(row.epoch, 1);
  });
});

// --- Self-grant admin -----------------------------------------------------------

test("attack 9: a user cannot grant themselves admin", { skip }, async () => {
  const msg = await refused(
    run(db, as.user(alice), (tx) => insert(tx, "user_roles", { user_id: alice, role: "admin" })),
  );
  assert.match(msg, /row-level security|permission denied/);
});

test("anon cannot write funding requests or issuers", { skip }, async () => {
  const a = await refused(run(db, as.anon, (tx) => insert(tx, "funding_requests", requestRow())));
  assert.match(a, /row-level security|permission denied/);
  const b = await refused(
    run(db, as.anon, (tx) =>
      insert(tx, "issuers", { owner_user_id: alice, legal_name: "X", jurisdiction: "AU" }),
    ),
  );
  assert.match(b, /row-level security|permission denied/);
});
