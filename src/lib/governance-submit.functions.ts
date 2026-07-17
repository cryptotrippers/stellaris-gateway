import { createServerFn } from "@tanstack/react-start";

export const createProposal = createServerFn({ method: "POST" })
  .inputValidator((input: { title: string; category: string; summary: string; code: string }) => {
    if (!input.title || input.title.trim().length < 4) throw new Error("Title too short");
    if (!input.summary || input.summary.trim().length < 10) throw new Error("Summary too short");
    return input;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Compute next SIP number from existing rows
    const { data: rows, error: listErr } = await supabaseAdmin
      .from("governance_proposals")
      .select("sip_number");
    if (listErr) throw new Error(listErr.message);

    let maxN = 0;
    for (const r of rows ?? []) {
      const m = /SIP-(\d+)/i.exec(r.sip_number ?? "");
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const sip_number = `SIP-${String(maxN + 1).padStart(3, "0")}`;

    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: inserted, error } = await supabaseAdmin
      .from("governance_proposals")
      .insert({
        sip_number,
        title: data.title.trim(),
        status: "active",
        votes_for_pct: 0,
        ends_at: endsAt,
      })
      .select("id, sip_number")
      .single();
    if (error) throw new Error(error.message);

    return { id: inserted.id, sip_number: inserted.sip_number };
  });
