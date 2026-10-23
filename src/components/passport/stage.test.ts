import { test } from "node:test";
import assert from "node:assert/strict";
import { passportStage } from "./stage";

test("demo listings are never described as offerings", () => {
  assert.equal(passportStage({ funding_status: "demo", vaultLive: true, payouts: 3 }), "Demo listing — not an offering");
});

test("a live vault is only claimed when a bootstrap is recorded", () => {
  assert.equal(passportStage({ funding_status: "open", vaultLive: false, payouts: 0 }), "Listed on testnet — vault not live");
  assert.equal(passportStage({ funding_status: "open", vaultLive: true, payouts: 0 }), "Vault live on Preprod (test)");
});

test("recorded payouts take precedence over vault status", () => {
  assert.equal(passportStage({ funding_status: "pilot", vaultLive: true, payouts: 2 }), "Vault live on Preprod · payouts recorded");
});
