import { describe, expect, test } from "bun:test";
import { issuerLeadSchema, leadUpdateSchema } from "./lead-schema";

const enquiry = { contact_name: "Test Operator", email: "test@example.com", organization: "Test Entity", jurisdiction: "Test jurisdiction", asset_category: "Other", project_summary: "A test project enquiry for validation.", consent: true, website_check: "" };
describe("issuer enquiry safeguards", () => {
  test("requires consent before storing contact details", () => {
    expect(issuerLeadSchema.safeParse(enquiry).success).toBe(true);
    expect(issuerLeadSchema.safeParse({ ...enquiry, consent: false }).success).toBe(false);
  });
  test("rejects invalid contact email", () => {
    expect(issuerLeadSchema.safeParse({ ...enquiry, email: "not-an-email" }).success).toBe(false);
  });
  test("rejects populated bot field", () => {
    expect(issuerLeadSchema.safeParse({ ...enquiry, website_check: "spam" }).success).toBe(false);
  });
  test("lead management cannot introduce an approval status", () => {
    const update = { id: "123e4567-e89b-12d3-a456-426614174000", status: "reviewing", internal_notes: "" };
    expect(leadUpdateSchema.safeParse(update).success).toBe(true);
    expect(leadUpdateSchema.safeParse({ ...update, status: "approved" }).success).toBe(false);
  });
});