// Sprint 1 E01 — the database now refuses operator inserts into
// yield_accruals / vault_fee_schedules and user-set later stages on
// funding_requests. These checks make sure the server functions that do
// those writes legitimately (after their own role and chain checks) use the
// service role, so the fix can't silently break the product.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

test("E01: accrual inserts go through the service role", () => {
  for (const f of ["./yield-accruals.functions.ts", "./governance-vault.functions.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /context\.supabase\.from\("yield_accruals"\)\.insert/, f);
    assert.doesNotMatch(src, /\bsupabase\.from\("yield_accruals"\)\.insert/, f);
  }
});

test("E01: the chain-verified fee schedule write uses the service role", () => {
  const src = read("./governance-vault.functions.ts");
  assert.doesNotMatch(src, /insertFeeSchedule\(context\.supabase/);
  assert.match(src, /insertFeeSchedule\(feeWriter/);
});

test("E01: moving a request to 'proposed' is a platform write", () => {
  const src = read("./funding-requests.functions.ts");
  const i = src.indexOf('status: "proposed"');
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 400), i);
  assert.match(before, /supabaseAdmin\s*\.from\("funding_requests"\)/);
});

test("E01: linking an issuer to a request checks ownership and stage, then writes as the platform", () => {
  const src = read("./accelerator.functions.ts");
  const i = src.indexOf("update({ issuer_id:");
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 1600), i);
  assert.match(before, /fr\.submitted_by !== context\.userId/);
  assert.match(before, /fr\.status !== "draft" && fr\.status !== "submitted"/);
  assert.match(before, /await supabaseAdmin\s*\.from\("funding_requests"\)\s*\.$/);
});
