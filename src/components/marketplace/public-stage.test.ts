import { test } from "node:test";
import assert from "node:assert/strict";
import { publicStage } from "./public-stage";

test("rejected applications are hidden from the public pipeline", () => {
  assert.equal(publicStage("rejected"), null);
});

test("internal stages map onto the public vocabulary", () => {
  assert.equal(publicStage("submitted"), "initial_review");
  assert.equal(publicStage("verifying"), "due_diligence");
  assert.equal(publicStage("proposed"), "awaiting_decision");
  assert.equal(publicStage("approved"), "preparing_offering");
  assert.equal(publicStage("vault_live"), "funding_open");
  assert.equal(publicStage("reporting"), "operating");
});
