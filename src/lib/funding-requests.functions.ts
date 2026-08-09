/**
 * Funding request onboarding.
 *
 * Anyone signed in can submit a real-world project for funding. A request is
 * only a claim until governance votes on it: submitting never creates an
 * `assets` row, never derives a vault, and never moves money. Promotion to a
 * governance proposal is a separate, explicit step.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { publicSupabase } from "./asset-vaults.shared";

export interface FundingRequestRow {
  id: string;
  asset_slug: string;
  name: string;
  category: string;
  issuer: string;
  location: string | null;
  description: string | null;
  target_lovelace: number;
  min_deposit_lovelace: number;
  maturity_months: number | null;
  reporting_cadence: string | null;
  evidence_urls: string[];
  proposed_fee_bps: number;
  treasury_address: string | null;
  status: string;
  proposal_id: string | null;
  asset_id: string | null;
  created_at: string;
}

const COLS =
  "id, asset_slug, name, category, issuer, location, description, target_lovelace, min_deposit_lovelace, maturity_months, reporting_cadence, evidence_urls, proposed_fee_bps, treasury_address, status, proposal_id, asset_id, created_at";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const URL_RE = /^https:\/\/[^\s]{5,300}$/;

/** Every funding request, newest first. Public — the pipeline is transparent. */
export const listFundingRequests = createServerFn({ method: "GET" }).handler(
  async (): Promise<FundingRequestRow[]> => {
    const supabase = publicSupabase();
    const { data, error } = await supabase
      .from("funding_requests")
      .select(COLS)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as FundingRequestRow[];
  },
);

/** One request by slug. Public. */
export const getFundingRequest = createServerFn({ method: "GET" })
  .inputValidator((data: { slug: string }) => {
    if (!data?.slug) throw new Error("slug is required");
    return { slug: data.slug };
  })
  .handler(async ({ data }): Promise<FundingRequestRow | null> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("funding_requests")
      .select(COLS)
      .eq("asset_slug", data.slug)
      .limit(1);
    if (error) throw new Error(error.message);
    return ((rows ?? [])[0] as FundingRequestRow | undefined) ?? null;
  });

export interface FundingRequestInput {
  assetSlug: string;
  name: string;
  category: string;
  issuer: string;
  location?: string;
  description: string;
  targetAda: number;
  minDepositAda: number;
  maturityMonths?: number;
  reportingCadence?: string;
  evidenceUrls: string[];
  proposedFeeBps: number;
  treasuryAddress?: string;
}

function validate(input: FundingRequestInput) {
  const slug = (input.assetSlug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      "The asset identifier must be 3–32 lowercase letters, numbers or hyphens, e.g. nordic-wind-03.",
    );
  }
  if ((input.name ?? "").trim().length < 4) throw new Error("Give the project a real name.");
  if ((input.issuer ?? "").trim().length < 3) {
    throw new Error("Name the legal issuer responsible for the asset.");
  }
  if ((input.description ?? "").trim().length < 80) {
    throw new Error(
      "Describe the asset in at least 80 characters: what it is, who operates it, and where the yield comes from.",
    );
  }
  if (!(input.targetAda > 0)) throw new Error("The target raise must be greater than zero.");
  if (!(input.minDepositAda >= 10)) {
    throw new Error("The minimum deposit must be at least 10 ADA — the contract's floor.");
  }
  if (
    !Number.isInteger(input.proposedFeeBps) ||
    input.proposedFeeBps < 0 ||
    input.proposedFeeBps > 500
  ) {
    throw new Error("The management fee must be 0–500 basis points (0–5.00%/yr).");
  }
  const evidence = (input.evidenceUrls ?? []).map((u) => u.trim()).filter(Boolean);
  if (evidence.length === 0) {
    throw new Error("Add at least one https link to verifiable evidence (title, licence, audit).");
  }
  const bad = evidence.find((u) => !URL_RE.test(u));
  if (bad) throw new Error(`"${bad.slice(0, 40)}" is not an https link.`);

  return {
    slug,
    name: input.name.trim(),
    category: (input.category ?? "").trim() || "Other",
    issuer: input.issuer.trim(),
    location: input.location?.trim() || null,
    description: input.description.trim(),
    targetLovelace: Math.round(input.targetAda * 1_000_000),
    minDepositLovelace: Math.round(input.minDepositAda * 1_000_000),
    maturityMonths:
      Number.isInteger(input.maturityMonths) && (input.maturityMonths ?? 0) > 0
        ? input.maturityMonths!
        : null,
    reportingCadence: input.reportingCadence?.trim().slice(0, 64) || null,
    evidence,
    proposedFeeBps: input.proposedFeeBps,
    treasuryAddress: input.treasuryAddress?.trim() || null,
  };
}

/** Submit a funding request. Signed-in users only; stored against their account. */
export const submitFundingRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: FundingRequestInput) => data)
  .handler(async ({ data, context }): Promise<FundingRequestRow> => {
    const v = validate(data);
    const { data: row, error } = await context.supabase
      .from("funding_requests")
      .insert({
        submitted_by: context.userId,
        asset_slug: v.slug,
        name: v.name,
        category: v.category,
        issuer: v.issuer,
        location: v.location,
        description: v.description,
        target_lovelace: v.targetLovelace,
        min_deposit_lovelace: v.minDepositLovelace,
        maturity_months: v.maturityMonths,
        reporting_cadence: v.reportingCadence,
        evidence_urls: v.evidence,
        proposed_fee_bps: v.proposedFeeBps,
        treasury_address: v.treasuryAddress,
        status: "submitted",
      })
      .select(COLS)
      .single();
    if (error) {
      if (error.code === "23505") {
        throw new Error(`The identifier "${v.slug}" is already taken by another request.`);
      }
      throw new Error(error.message);
    }
    return row as FundingRequestRow;
  });

/**
 * Promote a submitted funding request to a governance proposal.
 *
 * The numbers on the proposal are read fresh from the funding_requests row —
 * the caller supplies nothing but the request id — so a proposal can never
 * claim terms different from what was actually put up for review.
 */
export const proposeFundingForGovernance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { fundingRequestId: string }) => {
    const id = (data?.fundingRequestId ?? "").trim();
    if (!id) throw new Error("fundingRequestId is required");
    return { fundingRequestId: id };
  })
  .handler(async ({ data, context }): Promise<{ sipNumber: string; proposalId: string }> => {
    const { data: row, error } = await context.supabase
      .from("funding_requests")
      .select(`${COLS}, submitted_by`)
      .eq("id", data.fundingRequestId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("That funding request does not exist.");

    const req = row as FundingRequestRow & { submitted_by: string };

    if (req.status !== "submitted") {
      throw new Error(
        `This request is "${req.status}" — only requests still under review can be proposed.`,
      );
    }
    if (req.proposal_id) {
      throw new Error(
        "This request already has a governance proposal. Resubmission after a rejection is a human decision, not an automatic new proposal.",
      );
    }

    if (req.submitted_by !== context.userId) {
      const { data: isAdmin, error: roleErr } = await context.supabase.rpc("has_role", {
        _user_id: context.userId,
        _role: "admin",
      } as never);
      if (roleErr) throw new Error(roleErr.message);
      if (!isAdmin) {
        throw new Error("Only the submitter or an admin can propose this request for a vote.");
      }
    }

    const { createVaultProposal } = await import("./governance-vault.functions");

    const body =
      (req.description ?? "").trim() ||
      `${req.name} — funding request submitted by ${req.issuer}.`;

    const proposal = await createVaultProposal({
      data: {
        title: `Fund: ${req.name}`.slice(0, 160),
        body,
        kind: "fund_asset",
        assetId: null,
        params: { funding_request_id: req.id },
      },
    });

    const { error: updErr } = await context.supabase
      .from("funding_requests")
      .update({ proposal_id: proposal.id, status: "proposed" })
      .eq("id", req.id)
      .eq("status", "submitted");
    if (updErr) throw new Error(updErr.message);

    return { sipNumber: proposal.sipNumber, proposalId: proposal.id };
  });
