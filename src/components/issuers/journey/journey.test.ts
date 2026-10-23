import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJourney, nextStep, type JourneyInput } from "./journey";

const required = [
  { key: "legal_wrapper", label: "Legal wrapper" },
  { key: "asset_title", label: "Asset title or lease" },
];

const base: JourneyInput = {
  requestCreatedAt: "2026-10-01T00:00:00Z",
  requestStatus: "submitted",
  issuer: null,
  checklist: [],
  required,
  proposalId: null,
  assetId: null,
  vaultLive: false,
  vaultBootstrappedAt: null,
  hasAccruals: false,
};

const stage = (i: JourneyInput, key: string) => buildJourney(i).find((s) => s.key === key)!;

test("the journey always has nine stages", () => {
  assert.equal(buildJourney(base).length, 9);
});

test("Gate A passes only when the issuer is verified", () => {
  assert.equal(stage(base, "kyb").gate!.passed, false);
  const pending = { ...base, issuer: { verification_status: "pending", verified_at: null, created_at: "x" } };
  assert.equal(stage(pending, "kyb").gate!.passed, false);
  assert.equal(stage(pending, "kyb").status, "in_progress");
  const ok = { ...base, issuer: { verification_status: "verified", verified_at: "2026-10-02", created_at: "x" } };
  assert.equal(stage(ok, "kyb").gate!.passed, true);
});

test("review completes only when every required item is verified", () => {
  const partial = { ...base, checklist: [{ item_key: "legal_wrapper", status: "verified", verified_at: "2026-10-03" }] };
  assert.equal(stage(partial, "review").status, "in_progress");
  assert.deepEqual(stage(partial, "review").outstanding, ["Asset title or lease"]);
  const all = {
    ...base,
    checklist: [
      { item_key: "legal_wrapper", status: "verified", verified_at: "2026-10-03" },
      { item_key: "asset_title", status: "verified", verified_at: "2026-10-04" },
    ],
  };
  assert.equal(stage(all, "review").status, "complete");
  assert.equal(stage(all, "review").reviewed, "2026-10-04");
});

test("a rejected evidence item asks the issuer to act", () => {
  const r = { ...base, checklist: [{ item_key: "asset_title", status: "rejected", verified_at: "2026-10-03" }] };
  assert.equal(stage(r, "review").status, "action_required");
});

test("Gate B reflects a recorded listing; Gates C and D stay undecided", () => {
  assert.equal(stage(base, "offering_docs").gate!.passed, false);
  const listed = { ...base, requestStatus: "asset_created", assetId: "x" };
  assert.equal(stage(listed, "offering_docs").gate!.passed, true);
  assert.equal(stage(listed, "fundraising").gate!.passed, null);
  assert.equal(stage(listed, "milestones").gate!.passed, null);
});

test("the next step points at the first stage needing the issuer", () => {
  assert.match(nextStep(buildJourney(base)), /^Issuer KYB/);
});
