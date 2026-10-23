import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { issuerLeadSchema, leadUpdateSchema } from "./lead-schema";

const enquiry = { contact_name: "Test Operator", email: "test@example.com", organization: "Test Entity", jurisdiction: "Test jurisdiction", asset_category: "Other", project_summary: "A test project enquiry for validation.", consent: true, website_check: "" };
describe("issuer enquiry safeguards", () => {
  test("requires consent before storing contact details", () => {
    assert.equal(issuerLeadSchema.safeParse(enquiry).success, true);
    assert.equal(issuerLeadSchema.safeParse({ ...enquiry, consent: false }).success, false);
  });
  test("rejects invalid contact email", () => {
    assert.equal(issuerLeadSchema.safeParse({ ...enquiry, email: "not-an-email" }).success, false);
  });
  test("rejects populated bot field", () => {
    assert.equal(issuerLeadSchema.safeParse({ ...enquiry, website_check: "spam" }).success, false);
  });
  test("lead management cannot introduce an approval status", () => {
    const update = { id: "123e4567-e89b-12d3-a456-426614174000", status: "reviewing", internal_notes: "" };
    assert.equal(leadUpdateSchema.safeParse(update).success, true);
    assert.equal(leadUpdateSchema.safeParse({ ...update, status: "approved" }).success, false);
  });
});