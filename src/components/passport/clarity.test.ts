import { test } from "node:test";
import assert from "node:assert/strict";
import { clarityItems, clarityPublishedCount } from "./clarity";

test("the Clarity Standard always has seven items", () => {
  const items = clarityItems({ funding_status: "open", issuer: "A", description: null, audit_report_url: null });
  assert.equal(items.length, 7);
});

test("a published audit link counts as published, never verified", () => {
  const items = clarityItems({
    funding_status: "open",
    issuer: "A",
    description: "x",
    audit_report_url: "https://example.com/report.pdf",
  });
  const asset = items.find((i) => i.key === "asset_verification")!;
  assert.equal(asset.status, "published");
  assert.equal(items.some((i) => i.status === "verified"), false);
});

test("demo listings mark issuer and financials illustrative and rights not applicable", () => {
  const items = clarityItems({ funding_status: "demo", issuer: "Demo", description: "x", audit_report_url: null });
  assert.equal(items.find((i) => i.key === "issuer_identity")!.status, "illustrative");
  assert.equal(items.find((i) => i.key === "financial_disclosures")!.status, "illustrative");
  assert.equal(items.find((i) => i.key === "legal_rights")!.status, "not_applicable");
  assert.equal(clarityPublishedCount(items), 1);
});

test("exit rules are published only once a vault is live", () => {
  const off = clarityItems({ funding_status: "pilot", issuer: "A", description: null, audit_report_url: null });
  const on = clarityItems({
    funding_status: "pilot",
    issuer: "A",
    description: null,
    audit_report_url: null,
    vaultLive: true,
  });
  assert.equal(off.find((i) => i.key === "liquidity_exit")!.status, "pending");
  assert.equal(on.find((i) => i.key === "liquidity_exit")!.status, "published");
});
