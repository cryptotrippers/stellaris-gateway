// Sprint 2 E10 — the signed integrity endpoint: refuses unsigned, wrong,
// stale and replayed requests before running anything; reports drift as 409.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  handleIntegrityRequest,
  runIntegrityJobs,
  type IntegrityDeps,
} from "./integrity-jobs.server";
import type { LedgerRepo } from "./ledger-store.server";

const SECRET = "test-secret-not-real";
let ran = 0;
const repo = (projects: Record<string, boolean>): LedgerRepo =>
  ({
    async listProjectIds() {
      ran++;
      return Object.keys(projects);
    },
    async getProject(id: string) {
      return projects[id] ? { id, currency: "AUD" } : null;
    },
    async listPeriods() {
      return [];
    },
    async listEntries() {
      return [];
    },
  }) as unknown as LedgerRepo;

const deps = (projects: Record<string, boolean>) => async (): Promise<IntegrityDeps> => ({
  ledger: repo(projects),
});

function signed(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return new Request("https://site.example/api/public/jobs/integrity", {
    method: "POST",
    body,
    headers: { "x-stellaris-signature": `t=${t},v1=${v1}` },
  });
}

test("E10: a correctly signed request runs the checks; a clean ledger answers 200", async () => {
  const res = await handleIntegrityRequest(signed('{"job":"all","run":"1"}'), {
    secret: SECRET,
    deps: deps({ "proj-a": true }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; checks: Record<string, { checked: number }> };
  assert.equal(body.ok, true);
  assert.equal(body.checks.ledger!.checked, 1);
});

test("E10: drift answers 409 with the failures", async () => {
  // "proj-b" is listed but can't be loaded: reported, not thrown.
  const res = await handleIntegrityRequest(signed('{"job":"all","run":"2"}'), {
    secret: SECRET,
    deps: deps({ "proj-a": true, "proj-b": false }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { failures: Array<{ subject: string }> };
  assert.deepEqual(
    body.failures.map((f) => f.subject),
    ["proj-b"],
  );
});

test("E10: unsigned, wrongly signed, stale and replayed requests are refused before running", async () => {
  ran = 0;
  const body = '{"job":"all","run":"3"}';
  const unsigned = new Request("https://site.example/x", { method: "POST", body });
  const wrong = signed(body, undefined, "other-secret");
  const stale = signed(body, Math.floor(Date.now() / 1000) - 3600);
  for (const r of [unsigned, wrong, stale]) {
    const res = await handleIntegrityRequest(r, { secret: SECRET, deps: deps({}) });
    assert.equal(res.status, 401);
  }
  const t = Math.floor(Date.now() / 1000);
  assert.equal(
    (await handleIntegrityRequest(signed(body, t), { secret: SECRET, deps: deps({}) })).status,
    200,
  );
  assert.equal(
    (await handleIntegrityRequest(signed(body, t), { secret: SECRET, deps: deps({}) })).status,
    401,
    "replay",
  );
  assert.equal(ran, 1, "only the one valid request ran the checks");
  const unconfigured = await handleIntegrityRequest(signed(body), {
    secret: undefined,
    deps: deps({}),
  });
  assert.equal(unconfigured.status, 503);
});

test("E10: runIntegrityJobs reports per check", async () => {
  const r = await runIntegrityJobs({ ledger: repo({}) }, new Date("2027-01-01T00:00:00Z"));
  assert.equal(r.ranAt, "2027-01-01T00:00:00.000Z");
  assert.deepEqual(r.checks, { ledger: { checked: 0, failed: 0 } });
});

test("E10: the nightly workflow signs exactly what the endpoint verifies", () => {
  const wf = readFileSync(".github/workflows/nightly-integrity.yml", "utf8");
  assert.match(wf, /printf '%s' "\$\{t\}\.\$\{body\}" \| openssl dgst -sha256 -hmac "\$SECRET"/);
  assert.match(wf, /x-stellaris-signature: t=\$\{t\},v1=\$\{sig\}/);
  assert.match(wf, /if \[ "\$code" != "200" \]/);
});
