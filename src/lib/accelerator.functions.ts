/**
 * Accelerator server functions: issuer profiles, verification checklists,
 * impact attestations, and the public project-pipeline read.
 *
 * Only imports, types and server-function declarations live here — runtime
 * helpers are in `accelerator.shared.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { publicSupabase } from "./asset-vaults.shared";
import {
  deriveStage,
  readinessScore,
  type ChecklistRow,
  type ImpactAttestationRow,
  type IssuerRow,
  type PipelineProject,
  type PipelineSummary,
} from "./accelerator.shared";

const ISSUER_COLS =
  "id, legal_name, jurisdiction, registration_number, contact_email, website, wrapper_type, verification_status, verified_at, created_at";
const CHECK_COLS =
  "id, funding_request_id, item_key, status, evidence_url, note, verified_at";

/** Whole public pipeline: every funding request with its verification state. */
export const listPipeline = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ projects: PipelineProject[]; summary: PipelineSummary }> => {
    const supabase = publicSupabase();

    const [requests, checklist, issuers, vaults, accruals, attestations] = await Promise.all([
      supabase
        .from("funding_requests")
        .select(
          "id, asset_slug, name, category, issuer, issuer_id, location, target_lovelace, min_deposit_lovelace, maturity_months, proposed_fee_bps, status, proposal_id, asset_id, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(300),
      supabase.from("funding_request_checklist").select(CHECK_COLS).limit(3000),
      supabase.from("issuers").select(ISSUER_COLS).limit(500),
      supabase
        .from("asset_vaults")
        .select("asset_id, script_address, bootstrap_tx_hash, bootstrapped_at")
        .limit(500),
      supabase.from("yield_accruals").select("asset_id, total_assets_after").limit(2000),
      supabase
        .from("impact_attestations")
        .select("id, funding_request_id, published, impact_metrics(id)")
        .eq("published", true)
        .limit(1000),
    ]);

    for (const r of [requests, checklist, issuers, vaults, accruals, attestations]) {
      if (r.error) throw new Error(r.error.message);
    }

    const checksBy = new Map<string, ChecklistRow[]>();
    for (const c of (checklist.data ?? []) as ChecklistRow[]) {
      const list = checksBy.get(c.funding_request_id) ?? [];
      list.push(c);
      checksBy.set(c.funding_request_id, list);
    }

    const issuerById = new Map<string, IssuerRow>();
    for (const i of (issuers.data ?? []) as IssuerRow[]) issuerById.set(i.id, i);

    const vaultByAsset = new Map<string, { address: string; at: string | null }>();
    for (const v of vaults.data ?? []) {
      if (!v.bootstrap_tx_hash) continue;
      vaultByAsset.set(v.asset_id, { address: v.script_address, at: v.bootstrapped_at });
    }

    const accrualAssets = new Set<string>();
    let accountedLovelace = 0;
    const latestByAsset = new Map<string, number>();
    for (const a of accruals.data ?? []) {
      accrualAssets.add(a.asset_id);
      latestByAsset.set(a.asset_id, Number(a.total_assets_after));
    }
    for (const v of latestByAsset.values()) accountedLovelace += v;

    const metricsByRequest = new Map<string, number>();
    for (const a of (attestations.data ?? []) as {
      funding_request_id: string;
      impact_metrics: { id: string }[] | null;
    }[]) {
      metricsByRequest.set(
        a.funding_request_id,
        (metricsByRequest.get(a.funding_request_id) ?? 0) + (a.impact_metrics?.length ?? 0),
      );
    }

    const projects: PipelineProject[] = (requests.data ?? []).map((r) => {
      const checks = checksBy.get(r.id) ?? [];
      const vault = r.asset_id ? vaultByAsset.get(r.asset_id) : undefined;
      const issuer = r.issuer_id ? (issuerById.get(r.issuer_id) ?? null) : null;
      return {
        fundingRequestId: r.id,
        slug: r.asset_slug,
        name: r.name,
        category: r.category,
        issuerName: r.issuer,
        issuer,
        location: r.location,
        targetLovelace: Number(r.target_lovelace),
        minDepositLovelace: Number(r.min_deposit_lovelace),
        proposedFeeBps: r.proposed_fee_bps,
        maturityMonths: r.maturity_months,
        status: r.status,
        proposalId: r.proposal_id,
        assetId: r.asset_id,
        stage: deriveStage({
          status: r.status,
          proposalId: r.proposal_id,
          checklist: checks,
          vaultBootstrapped: Boolean(vault),
          hasAccruals: Boolean(r.asset_id && accrualAssets.has(r.asset_id)),
        }),
        readiness: readinessScore(checks),
        checklist: checks,
        attestedMetrics: metricsByRequest.get(r.id) ?? 0,
        vaultAddress: vault?.address ?? null,
        vaultBootstrappedAt: vault?.at ?? null,
        createdAt: r.created_at,
      };
    });

    const summary: PipelineSummary = {
      projects: projects.length,
      verifiedIssuers: (issuers.data ?? []).filter(
        (i) => i.verification_status === "verified",
      ).length,
      liveVaults: projects.filter((p) => p.vaultAddress).length,
      attestedMetrics: [...metricsByRequest.values()].reduce((a, b) => a + b, 0),
      accountedLovelace,
      generatedAt: new Date().toISOString(),
    };

    return { projects, summary };
  },
);

/** Toolkit view for one funding request: issuer, checklist, attestations. */
export const getProjectToolkit = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string }) => {
    if (!data?.slug) throw new Error("slug is required");
    return { slug: data.slug };
  })
  .handler(
    async ({
      data,
    }): Promise<{
      fundingRequestId: string | null;
      issuer: IssuerRow | null;
      checklist: ChecklistRow[];
      attestations: ImpactAttestationRow[];
      readiness: number;
    }> => {
      const supabase = publicSupabase();
      const { data: reqRows, error: reqErr } = await supabase
        .from("funding_requests")
        .select("id, issuer_id")
        .eq("asset_slug", data.slug)
        .limit(1);
      if (reqErr) throw new Error(reqErr.message);
      const req = (reqRows ?? [])[0];
      if (!req) {
        return {
          fundingRequestId: null,
          issuer: null,
          checklist: [],
          attestations: [],
          readiness: 0,
        };
      }

      const [checks, issuer, atts] = await Promise.all([
        supabase.from("funding_request_checklist").select(CHECK_COLS).eq("funding_request_id", req.id),
        req.issuer_id
          ? supabase.from("issuers").select(ISSUER_COLS).eq("id", req.issuer_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        supabase
          .from("impact_attestations")
          .select(
            "id, funding_request_id, attester, methodology, reporting_cadence, evidence_url, published, created_at, impact_metrics(id, metric_name, unit, baseline, target, measurement_method)",
          )
          .eq("funding_request_id", req.id)
          .eq("published", true),
      ]);
      if (checks.error) throw new Error(checks.error.message);
      if (issuer.error) throw new Error(issuer.error.message);
      if (atts.error) throw new Error(atts.error.message);

      const checklist = (checks.data ?? []) as ChecklistRow[];
      const attestations = ((atts.data ?? []) as unknown as (Omit<
        ImpactAttestationRow,
        "metrics"
      > & { impact_metrics: ImpactAttestationRow["metrics"] })[]).map((a) => ({
        id: a.id,
        funding_request_id: a.funding_request_id,
        attester: a.attester,
        methodology: a.methodology,
        reporting_cadence: a.reporting_cadence,
        evidence_url: a.evidence_url,
        published: a.published,
        created_at: a.created_at,
        metrics: a.impact_metrics ?? [],
      }));

      return {
        fundingRequestId: req.id,
        issuer: (issuer.data as IssuerRow | null) ?? null,
        checklist,
        attestations,
        readiness: readinessScore(checklist),
      };
    },
  );

/** One issuer plus the projects it has submitted. Public. */
export const getIssuer = createServerFn({ method: "GET" })
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id is required");
    return { id: data.id };
  })
  .handler(
    async ({
      data,
    }): Promise<{
      issuer: IssuerRow | null;
      history: { id: string; status: string; note: string | null; created_at: string }[];
      projects: { slug: string; name: string; status: string }[];
    }> => {
      const supabase = publicSupabase();
      const [issuer, history, projects] = await Promise.all([
        supabase.from("issuers").select(ISSUER_COLS).eq("id", data.id).maybeSingle(),
        supabase
          .from("issuer_verifications")
          .select("id, status, note, created_at")
          .eq("issuer_id", data.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("funding_requests")
          .select("asset_slug, name, status")
          .eq("issuer_id", data.id),
      ]);
      if (issuer.error) throw new Error(issuer.error.message);
      if (history.error) throw new Error(history.error.message);
      if (projects.error) throw new Error(projects.error.message);
      return {
        issuer: (issuer.data as IssuerRow | null) ?? null,
        history: history.data ?? [],
        projects: (projects.data ?? []).map((p) => ({
          slug: p.asset_slug,
          name: p.name,
          status: p.status,
        })),
      };
    },
  );

export interface IssuerInput {
  id?: string;
  legalName: string;
  jurisdiction: string;
  registrationNumber?: string;
  contactEmail?: string;
  website?: string;
  wrapperType: string;
  /** Optional funding request to attach this issuer profile to. */
  fundingRequestId?: string;
}

/** Create or update the caller's issuer profile, optionally linking a project. */
export const saveIssuer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: IssuerInput) => {
    if ((data?.legalName ?? "").trim().length < 3) {
      throw new Error("Give the legal entity's registered name.");
    }
    if ((data?.jurisdiction ?? "").trim().length < 2) {
      throw new Error("Name the jurisdiction the entity is registered in.");
    }
    const allowed = ["spv", "cooperative", "trust", "company", "foundation", "none"];
    if (!allowed.includes(data.wrapperType)) throw new Error("Unknown legal wrapper type.");
    if (data.website && !/^https:\/\/[^\s]{5,300}$/.test(data.website.trim())) {
      throw new Error("The website must be an https link.");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<IssuerRow> => {
    const payload = {
      owner_user_id: context.userId,
      legal_name: data.legalName.trim(),
      jurisdiction: data.jurisdiction.trim(),
      registration_number: data.registrationNumber?.trim() || null,
      contact_email: data.contactEmail?.trim() || null,
      website: data.website?.trim() || null,
      wrapper_type: data.wrapperType,
    };

    const q = data.id
      ? context.supabase.from("issuers").update(payload).eq("id", data.id).select(ISSUER_COLS).single()
      : context.supabase.from("issuers").insert(payload).select(ISSUER_COLS).single();
    const { data: row, error } = await q;
    if (error) throw new Error(error.message);

    if (data.fundingRequestId) {
      const { error: linkErr } = await context.supabase
        .from("funding_requests")
        .update({ issuer_id: (row as IssuerRow).id })
        .eq("id", data.fundingRequestId);
      if (linkErr) throw new Error(linkErr.message);
    }
    return row as IssuerRow;
  });

/** Submitter (or admin) records evidence for one checklist item. */
export const saveChecklistItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { fundingRequestId: string; itemKey: string; evidenceUrl?: string; note?: string }) => {
      if (!data?.fundingRequestId) throw new Error("fundingRequestId is required");
      if (!data?.itemKey) throw new Error("itemKey is required");
      if (data.evidenceUrl && !/^https:\/\/[^\s]{5,300}$/.test(data.evidenceUrl.trim())) {
        throw new Error("Evidence must be an https link.");
      }
      return data;
    },
  )
  .handler(async ({ data, context }): Promise<ChecklistRow> => {
    const url = data.evidenceUrl?.trim() || null;
    const { data: row, error } = await context.supabase
      .from("funding_request_checklist")
      .upsert(
        {
          funding_request_id: data.fundingRequestId,
          item_key: data.itemKey,
          status: url ? "submitted" : "missing",
          evidence_url: url,
          note: data.note?.trim().slice(0, 500) || null,
        },
        { onConflict: "funding_request_id,item_key" },
      )
      .select(CHECK_COLS)
      .single();
    if (error) throw new Error(error.message);
    return row as ChecklistRow;
  });

/** Admin decision on a checklist item. The database refuses non-admins. */
export const reviewChecklistItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      fundingRequestId: string;
      itemKey: string;
      status: "verified" | "rejected" | "submitted";
      note?: string;
    }) => {
      if (!["verified", "rejected", "submitted"].includes(data?.status)) {
        throw new Error("Unknown review status.");
      }
      return data;
    },
  )
  .handler(async ({ data, context }): Promise<ChecklistRow> => {
    const { data: row, error } = await context.supabase
      .from("funding_request_checklist")
      .update({ status: data.status, note: data.note?.trim().slice(0, 500) || null })
      .eq("funding_request_id", data.fundingRequestId)
      .eq("item_key", data.itemKey)
      .select(CHECK_COLS)
      .single();
    if (error) throw new Error(error.message);
    return row as ChecklistRow;
  });

/** Admin decision on an issuer. The database refuses non-admins. */
export const setIssuerVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { issuerId: string; status: "pending" | "verified" | "rejected" }) => {
    if (!["pending", "verified", "rejected"].includes(data?.status)) {
      throw new Error("Unknown verification status.");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<IssuerRow> => {
    const { data: row, error } = await context.supabase
      .from("issuers")
      .update({ verification_status: data.status })
      .eq("id", data.issuerId)
      .select(ISSUER_COLS)
      .single();
    if (error) throw new Error(error.message);
    return row as IssuerRow;
  });

export interface AttestationInput {
  fundingRequestId: string;
  attester: string;
  methodology: string;
  reportingCadence: string;
  evidenceUrl?: string;
  publish: boolean;
  metrics: {
    metricName: string;
    unit: string;
    baseline?: number | null;
    target?: number | null;
    measurementMethod?: string;
  }[];
}

/** Publish a structured impact attestation with its metrics. */
export const saveImpactAttestation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: AttestationInput) => {
    if ((data?.attester ?? "").trim().length < 3) throw new Error("Name who attests to the impact.");
    if ((data?.methodology ?? "").trim().length < 40) {
      throw new Error("Describe the measurement methodology in at least 40 characters.");
    }
    const metrics = (data.metrics ?? []).filter((m) => m.metricName?.trim() && m.unit?.trim());
    if (metrics.length === 0) throw new Error("Add at least one impact metric.");
    if (data.evidenceUrl && !/^https:\/\/[^\s]{5,300}$/.test(data.evidenceUrl.trim())) {
      throw new Error("Evidence must be an https link.");
    }
    return { ...data, metrics };
  })
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { data: att, error } = await context.supabase
      .from("impact_attestations")
      .insert({
        funding_request_id: data.fundingRequestId,
        attester: data.attester.trim(),
        methodology: data.methodology.trim(),
        reporting_cadence: data.reportingCadence.trim() || "quarterly",
        evidence_url: data.evidenceUrl?.trim() || null,
        published: data.publish,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const { error: mErr } = await context.supabase.from("impact_metrics").insert(
      data.metrics.map((m) => ({
        attestation_id: att.id,
        metric_name: m.metricName.trim(),
        unit: m.unit.trim(),
        baseline: m.baseline ?? null,
        target: m.target ?? null,
        measurement_method: m.measurementMethod?.trim() || null,
      })),
    );
    if (mErr) throw new Error(mErr.message);
    return { id: att.id };
  });
