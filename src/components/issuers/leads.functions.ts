import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { issuerLeadSchema, leadUpdateSchema } from "./lead-schema";

export const submitIssuerLead = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => issuerLeadSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { consent, website_check, ...fields } = data;
    const { data: lead, error } = await supabaseAdmin.from("issuer_leads")
      .insert(fields).select("id").single();
    if (error || !lead) throw new Error("Your enquiry could not be saved. Please try again.");
    return { id: lead.id };
  });

export const listIssuerLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: admin, error: roleError } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "admin",
    });
    if (roleError || !admin) throw new Error("Administrator access is required to view issuer enquiries.");
    const { data, error } = await context.supabase.from("issuer_leads")
      .select("*").order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error("Enquiries could not be loaded.");
    return data;
  });

export const updateIssuerLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => leadUpdateSchema.parse(input))
  .handler(async ({ context, data }) => {
    const { data: admin, error: roleError } = await context.supabase.rpc("has_role", {
      _user_id: context.userId, _role: "admin",
    });
    if (roleError || !admin) throw new Error("Administrator access is required to manage issuer enquiries.");
    const { data: saved, error } = await context.supabase.from("issuer_leads")
      .update({ status: data.status, internal_notes: data.internal_notes, updated_at: new Date().toISOString() })
      .eq("id", data.id).select("id").single();
    if (error || !saved) throw new Error("Changes could not be saved.");
    return { id: saved.id };
  });