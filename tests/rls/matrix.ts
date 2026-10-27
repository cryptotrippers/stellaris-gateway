/**
 * Sprint 2 E12 — role × table × operation probes.
 *
 * Every public table gets two seeded rows (one owned by alice, one by bob,
 * where the table has an owner column). Then each actor tries SELECT,
 * INSERT (a valid row "as themselves"), UPDATE (a no-op on every row) and
 * DELETE (every row), each inside a transaction that is rolled back. The
 * observed outcome per cell is compared with the reviewed expectation in
 * access-matrix.expected.json — that file is the access spec.
 */
import { createHash } from "node:crypto";
import { as, run, USERS, type Actor, type Db } from "./harness";

export const ACTORS = {
  anon: as.anon,
  member: as.user(USERS.alice),
  operator: as.user(USERS.operator),
  admin: as.user(USERS.admin),
} as const satisfies Record<string, Actor>;
export type ActorName = keyof typeof ACTORS;
export const OPS = ["select", "insert", "update", "delete"] as const;
export type Op = (typeof OPS)[number];

/** What happened: rows seen/changed, inserted, or which layer refused. */
export type Outcome =
  | number
  | "ok"
  | "denied:grant"
  | "denied:rls"
  | `denied:trigger`
  | `error:${string}`;

const ID = {
  alice: USERS.alice,
  bob: USERS.bob,
  operator: USERS.operator,
  admin: USERS.admin,
};

/** Column that names the row's owner, where there is one. */
export const OWNER: Record<string, string> = {
  funding_requests: "submitted_by",
  impact_attestations: "created_by",
  issuers: "owner_user_id",
  kyc_attestations: "user_id",
  linked_wallets: "user_id",
  proposal_votes: "voter_user_id",
  security_audit_log: "user_id",
  security_sessions: "user_id",
  transactions: "user_id",
  user_profiles: "user_id",
  user_roles: "user_id",
  user_security_settings: "user_id",
  vault_positions: "user_id",
  wallet_link_nonces: "user_id",
  governance_proposals: "author_user_id",
};

/** One row per user, created by the sign-up trigger: not seeded again. */
const ONE_PER_USER = new Set(["user_profiles", "user_security_settings"]);

/** Fixed parents every template can point at (seeded first). */
export const PARENTS = `
  INSERT INTO public.oracle_feeds (id, provider, pair, feed_address)
    VALUES ('00000000-0000-4000-9000-000000000001', 'charli3', 'ADA/USD', 'addr_test1feed');
  INSERT INTO public.assets (id, name, category, issuer) VALUES ('solar-x', 'Solar X', 'Energy', 'Alice');
  INSERT INTO public.deposit_assets (id, symbol, display_name, issuer_name)
    VALUES ('00000000-0000-4000-9000-000000000002', 'TADA', 'Test ADA', 'Test');
  INSERT INTO public.governance_proposals (id, sip_number, title)
    VALUES ('00000000-0000-4000-9000-000000000003', 'SIP-PARENT', 'Parent proposal');
  INSERT INTO public.offerings (id, asset_id, script_hash, script_address, fraction_policy_id,
      fraction_asset_name_hex, total_fractions, price_per_fraction, issuer_name)
    VALUES ('00000000-0000-4000-9000-000000000004', 'solar-x', 'aa', 'addr_test1off', 'bb', 'cc', 100, 1000000, 'Alice');
  INSERT INTO public.funding_requests (id, submitted_by, asset_slug, name, category, issuer, status, terms_version, terms_accepted_at)
    VALUES ('00000000-0000-4000-9000-000000000005', '${ID.alice}', 'parent-req', 'Parent', 'Energy', 'Alice', 'submitted', 'v', now());
  INSERT INTO public.issuers (id, owner_user_id, legal_name, jurisdiction)
    VALUES ('00000000-0000-4000-9000-000000000006', '${ID.alice}', 'Parent Issuer', 'AU');
  INSERT INTO public.impact_attestations (id, funding_request_id, attester, methodology, created_by)
    VALUES ('00000000-0000-4000-9000-000000000007', '00000000-0000-4000-9000-000000000005', 'auditor', 'm', '${ID.alice}');
  INSERT INTO public.ledger_projects (id, currency) VALUES ('proj-parent', 'AUD');
  INSERT INTO public.ledger_periods (project_id, id, kind, starts_on, ends_on)
    VALUES ('proj-parent', 'P0', 'regular', '2027-01-01', '2027-12-31');
`;

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
const hex = (n: number) => createHash("sha256").update(uniq()).digest("hex").slice(0, n);

/** A valid row for `table`, owned by `uid` where the table has an owner. */
export function template(table: string, uid: string): Record<string, unknown> | null {
  const u = uniq();
  switch (table) {
    case "admin_wallets":
      return { address: `addr_test1admin${u}` };
    case "asset_vaults":
      return {
        asset_id: "solar-x",
        vault_version: counter,
        script_hash: hex(56),
        script_address: `addr_test1v${u}`,
      };
    case "assets":
      return { id: `asset-${u}`, name: "A", category: "Energy", issuer: "I" };
    case "contract_audits":
      return {
        contract_name: "c",
        auditor: "a",
        report_url: "https://x.example/r",
        commit_hash: hex(40),
        audited_at: "2027-01-01",
      };
    case "csp_reports":
      return {
        directive: "script-src",
        blocked: `b-${u}`,
        document_path: "/",
        disposition: "report",
      };
    case "deposit_assets":
      return { symbol: `T${u}`.slice(0, 12), display_name: "T", issuer_name: "I" };
    case "fraction_events":
      return {
        offering_id: "00000000-0000-4000-9000-000000000004",
        asset_id: "solar-x",
        event_type: "buy",
        tx_hash: hex(64),
      };
    case "funding_request_checklist":
      return {
        funding_request_id: "00000000-0000-4000-9000-000000000005",
        item_key: [
          "legal_wrapper",
          "asset_title",
          "operating_licence",
          "insurance",
          "offtake_agreement",
          "technical_audit",
          "impact_methodology",
        ][counter % 7],
        status: "submitted",
      };
    case "funding_requests":
      return {
        submitted_by: uid,
        asset_slug: `slug-${u}`,
        name: "N",
        category: "Energy",
        issuer: "I",
        status: "submitted",
        terms_version: "v",
        terms_accepted_at: new Date().toISOString(),
      };
    case "governance_proposals":
      return { sip_number: `SIP-${u}`, title: "T", author_user_id: uid };
    case "impact_attestations":
      return {
        funding_request_id: "00000000-0000-4000-9000-000000000005",
        attester: "a",
        methodology: "m",
        created_by: uid,
      };
    case "impact_metrics":
      return {
        attestation_id: "00000000-0000-4000-9000-000000000007",
        metric_name: "kWh",
        unit: "kWh",
      };
    case "issuer_leads":
      return {
        contact_name: "C",
        email: `c${u}@example.test`,
        organization: "O",
        jurisdiction: "AU",
        asset_category: "Property",
        project_summary: "A twenty-plus character summary of the project.",
        consent_at: new Date().toISOString(),
      };
    case "issuer_verifications":
      return { issuer_id: "00000000-0000-4000-9000-000000000006", status: "pending" };
    case "issuers":
      return { owner_user_id: uid, legal_name: `L ${u}`, jurisdiction: "AU" };
    case "kyc_attestations":
      return { user_id: uid, attestation_type: "kyc", proof_cid: `cid${u}`, verifier: "v" };
    case "ledger_entries":
      return {
        project_id: "proj-parent",
        seq: 1,
        period_id: "P0",
        ref: `R-${u}`,
        kind: "receipt_settled",
        amount: 1,
        currency: "AUD",
        entry: "{}",
        prev_hash: "0".repeat(64),
        entry_hash: hex(64),
      };
    case "ledger_periods":
      return {
        project_id: "proj-parent",
        id: `P-${u}`,
        kind: "regular",
        starts_on: "2027-01-01",
        ends_on: "2027-12-31",
      };
    case "ledger_projects":
      return { id: `proj-${u}`, currency: "AUD" };
    case "linked_wallets":
      return {
        user_id: uid,
        address: `addr_test1w${u}`,
        payment_key_hash: hex(56),
        signature: "sig",
      };
    case "offerings":
      return {
        asset_id: "solar-x",
        vault_version: counter + 10,
        script_hash: hex(56),
        script_address: `addr_test1o${u}`,
        fraction_policy_id: hex(56),
        fraction_asset_name_hex: "aa",
        total_fractions: 10,
        price_per_fraction: 1,
        issuer_name: "I",
      };
    case "oracle_feeds":
      return { provider: "p", pair: `P${u}`, feed_address: "addr_test1f" };
    case "proposal_votes":
      return {
        proposal_id: "00000000-0000-4000-9000-000000000003",
        voter_user_id: uid,
        choice: "for",
      };
    case "rate_limit_hits":
      return { key: `k-${u}`, window_start: new Date().toISOString() };
    case "security_audit_log":
      return { user_id: uid, action: "probe" };
    case "security_sessions":
      return { user_id: uid };
    case "transactions":
      return {
        user_id: uid,
        vault_id: "solar-x",
        type: "deposit",
        amount_ada: 1,
        tx_hash: hex(64),
      };
    case "treasury_config":
      return { id: 1, treasury_address: "addr_test1t" };
    case "treasury_events":
      return {
        event_type: "buyback",
        tx_hash: hex(64),
        amount_lovelace: 1,
        slot: 1,
        block_time: new Date().toISOString(),
      };
    case "user_profiles":
      return { user_id: uid };
    case "user_roles":
      return { user_id: uid, role: "admin" };
    case "user_security_settings":
      return { user_id: uid };
    case "vault_fee_schedules":
      return { asset_id: "solar-x", vault_version: 5, treasury_address: "addr_test1fee" };
    case "vault_positions":
      return { user_id: uid, vault_id: "solar-x", amount_ada: 1, tx_hash: hex(64) };
    case "wallet_link_nonces":
      return {
        user_id: uid,
        address: "addr_test1n",
        nonce: `n-${u}`,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      };
    case "yield_accruals":
      return {
        asset_id: "solar-x",
        vault_version: 5,
        tx_hash: hex(64),
        epoch: 1,
        amount_lovelace: 1,
        total_assets_after: 1,
        total_shares_after: 1,
        block_time: new Date().toISOString(),
      };
    default:
      return null;
  }
}

/** A column a no-op UPDATE can touch (set to itself). */
export function noopColumn(table: string): string {
  const c: Record<string, string> = {
    ledger_entries: "ref",
    ledger_periods: "kind",
    ledger_projects: "currency",
    rate_limit_hits: "key",
    csp_reports: "directive",
  };
  return c[table] ?? "id";
}

async function insertRow(tx: Db, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  // RETURNING nothing: a column-restricted table must still accept the insert.
  await tx.query(
    `INSERT INTO public.${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
}

/** Seed two rows per table as the database owner (no RLS, triggers on). */
export async function seed(db: Db, tables: string[]): Promise<void> {
  await db.exec(PARENTS);
  for (const t of tables) {
    const existing = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`);
    if (ONE_PER_USER.has(t) && existing.rows[0]!.n > 0) continue;
    for (const owner of ONE_PER_USER.has(t) ? [ID.bob] : [ID.alice, ID.bob]) {
      if (t === "ledger_entries" || t === "treasury_config" || t === "user_roles") continue;
      const row = template(t, owner);
      if (!row) throw new Error(`no template for table ${t} — add one to tests/rls/matrix.ts`);
      try {
        await insertRow(db, t, row);
      } catch (e) {
        throw new Error(`seeding ${t}: ${(e as Error).message}`);
      }
    }
  }
  await db.exec(
    `INSERT INTO public.treasury_config (id, treasury_address) VALUES (1, 'addr_test1t') ON CONFLICT (id) DO NOTHING`,
  );
  await db.exec(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ID.bob}', 'member')`);
}

function classify(e: unknown): Outcome {
  const m = (e as Error).message ?? String(e);
  if (/permission denied/i.test(m)) return "denied:grant";
  if (/row-level security/i.test(m)) return "denied:rls";
  if (/violates (not-null|check|unique|foreign key)|duplicate key|invalid input/i.test(m)) {
    return `error:${m.slice(0, 80)}`;
  }
  return "denied:trigger";
}

/** Run one probe and report what the database allowed. */
export async function probe(db: Db, actor: Actor, table: string, op: Op): Promise<Outcome> {
  try {
    return await run(db, actor, async (tx) => {
      switch (op) {
        case "select": {
          const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${table}`);
          return r.rows[0]!.n;
        }
        case "insert": {
          const uid = actor.kind === "user" ? actor.id : ID.alice;
          const row = template(table, uid);
          if (!row) return "error:no template";
          await insertRow(tx, table, row);
          return "ok";
        }
        case "update": {
          const c = noopColumn(table);
          const r = await tx.query(`UPDATE public.${table} SET ${c} = ${c}`);
          return (r as { affectedRows?: number }).affectedRows ?? 0;
        }
        case "delete": {
          const r = await tx.query(`DELETE FROM public.${table}`);
          return (r as { affectedRows?: number }).affectedRows ?? 0;
        }
      }
    });
  } catch (e) {
    return classify(e);
  }
}
