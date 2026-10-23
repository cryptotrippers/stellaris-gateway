import { z } from "zod";

export const LEAD_STATUSES = ["new", "reviewing", "contacted", "qualified", "closed"] as const;
export const ASSET_CATEGORIES = ["Clean energy", "Agriculture", "Property", "Other"] as const;
export const issuerLeadSchema = z.object({
  contact_name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  organization: z.string().trim().min(1).max(160),
  jurisdiction: z.string().trim().min(1).max(100),
  asset_category: z.enum(ASSET_CATEGORIES),
  project_summary: z
    .string()
    .trim()
    .min(20, "Please include at least 20 characters about your project.")
    .max(3000),
  consent: z.literal(true, { error: "Please agree to be contacted about this enquiry." }),
  website_check: z.string().max(0),
});
export const leadUpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(LEAD_STATUSES),
  internal_notes: z.string().trim().max(5000),
});
