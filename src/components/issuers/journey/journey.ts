/**
 * Issuer funding journey: nine stages and four gates, mapped only from
 * server-held records. Nothing here can advance a stage — gates reflect
 * decisions the server has already recorded (issuer verification, checklist
 * review by an administrator, governance execution, vault bootstrap).
 */

export type JourneyStatus =
  | "complete"
  | "in_progress"
  | "action_required"
  | "rejected"
  | "not_started"
  | "awaiting_backend"
  | "awaiting_legal";

export type GateState = { label: string; passed: boolean | null };

export type JourneyStage = {
  key: string;
  title: string;
  status: JourneyStatus;
  actions: string;
  evidence: string;
  reviewer: string | null;
  submitted: string | null;
  reviewed: string | null;
  outstanding: string[];
  gate?: GateState;
};

export type JourneyChecklistItem = { item_key: string; status: string; verified_at: string | null };

export type JourneyInput = {
  requestCreatedAt: string;
  requestStatus: string;
  issuer: { verification_status: string; verified_at: string | null; created_at: string } | null;
  checklist: JourneyChecklistItem[];
  /** Keys and labels of the required checklist items, from the shared checklist definition. */
  required: { key: string; label: string }[];
  proposalId: string | null;
  assetId: string | null;
  vaultLive: boolean;
  vaultBootstrappedAt: string | null;
  hasAccruals: boolean;
};

const latest = (dates: (string | null)[]) => dates.filter((d): d is string => !!d).sort().pop() ?? null;

export function buildJourney(i: JourneyInput): JourneyStage[] {
  const byKey = new Map(i.checklist.map((c) => [c.item_key, c]));
  const requiredRows = i.required.map((r) => ({ ...r, row: byKey.get(r.key) }));
  const notVerified = requiredRows.filter((r) => r.row?.status !== "verified");
  const rejected = requiredRows.filter((r) => r.row?.status === "rejected");
  const submitted = requiredRows.filter((r) => r.row && r.row.status !== "missing");
  const allVerified = requiredRows.length > 0 && notVerified.length === 0;
  const kyb = i.issuer?.verification_status ?? null;
  const listed = i.requestStatus === "asset_created" || !!i.assetId;

  return [
    {
      key: "enquiry",
      title: "Enquiry",
      status: "complete",
      actions: "Funding request submitted.",
      evidence: "Project overview, target raise and terms acceptance.",
      reviewer: null,
      submitted: i.requestCreatedAt,
      reviewed: null,
      outstanding: [],
    },
    {
      key: "kyb",
      title: "Issuer KYB",
      status: !i.issuer
        ? "action_required"
        : kyb === "verified"
          ? "complete"
          : kyb === "rejected"
            ? "rejected"
            : kyb === "pending"
              ? "in_progress"
              : "action_required",
      actions: !i.issuer
        ? "Create an issuer profile with the legal entity's details."
        : kyb === "verified"
          ? "Organisation verified."
          : kyb === "rejected"
            ? "Verification was rejected. Contact the review team before resubmitting."
            : kyb === "pending"
              ? "Waiting for an administrator to review your organisation."
              : "Complete your issuer profile so it can be reviewed.",
      evidence: "Registered legal name, jurisdiction, registration number and wrapper type.",
      reviewer: "Stellaris administrator",
      submitted: i.issuer?.created_at ?? null,
      reviewed: i.issuer?.verified_at ?? null,
      outstanding: !i.issuer ? ["Issuer profile"] : kyb === "verified" ? [] : ["Organisation verification"],
      gate: { label: "Gate A: Issuer verified", passed: kyb === "verified" },
    },
    {
      key: "data_room",
      title: "Private data room",
      status: "awaiting_backend",
      actions: "Secure uploads, versioning and integrity checks wait for the approved data-room service. Evidence links can be added to the review checklist today.",
      evidence: "Ownership, licences, offtake agreements, insurance and audits.",
      reviewer: null,
      submitted: null,
      reviewed: null,
      outstanding: [],
    },
    {
      key: "review",
      title: "Evidence review",
      status: allVerified
        ? "complete"
        : rejected.length > 0
          ? "action_required"
          : submitted.length > 0
            ? "in_progress"
            : "not_started",
      actions: allVerified
        ? "Every required item has been verified by an administrator."
        : rejected.length > 0
          ? "Some evidence was rejected. Read the reviewer's note and resubmit."
          : submitted.length > 0
            ? "Evidence submitted and waiting for review."
            : "Add evidence for each required checklist item.",
      evidence: "The required items of the verification checklist.",
      reviewer: "Stellaris administrator (internal review — not yet independent)",
      submitted: null,
      reviewed: latest(i.checklist.map((c) => c.verified_at)),
      outstanding: notVerified.map((r) => r.label),
    },
    {
      key: "offering_docs",
      title: "Offering documents",
      status: "awaiting_legal",
      actions: "Rights, fees, risks and exit terms must be drafted and approved by legal counsel before any real-money listing.",
      evidence: "Offer document, unit-holder rights, fee schedule, risk disclosure.",
      reviewer: "Legal and compliance (not yet appointed)",
      submitted: null,
      reviewed: null,
      outstanding: [],
      gate: { label: "Gate B: Listing approval (testnet governance)", passed: listed },
    },
    {
      key: "fundraising",
      title: "Fundraising",
      status: i.vaultLive ? "in_progress" : "not_started",
      actions: i.vaultLive
        ? "A vault is live on Cardano Preprod. Test deposits only — no real capital."
        : "Opens after listing approval and vault set-up.",
      evidence: "Vault bootstrap transaction on chain.",
      reviewer: "Operators (multi-signature)",
      submitted: null,
      reviewed: i.vaultBootstrappedAt,
      outstanding: [],
      gate: { label: "Gate C: Funding conditions met", passed: null },
    },
    {
      key: "milestones",
      title: "Milestone releases",
      status: "awaiting_backend",
      actions: "Escrowed capital would be released only against approved milestones. The release service is not built.",
      evidence: "Milestone evidence and approval record, plus the release transaction.",
      reviewer: null,
      submitted: null,
      reviewed: null,
      outstanding: [],
      gate: { label: "Gate D: Milestone release approved", passed: null },
    },
    {
      key: "operating",
      title: "Operating and reporting",
      status: i.hasAccruals ? "in_progress" : "not_started",
      actions: i.hasAccruals
        ? "On-chain yield accruals are being recorded (test ADA). Operating reports cannot be submitted yet."
        : "Starts once the asset is operating.",
      evidence: "Periodic income, cost and material-event reports.",
      reviewer: null,
      submitted: null,
      reviewed: null,
      outstanding: [],
    },
    {
      key: "exit",
      title: "Exit",
      status: "awaiting_legal",
      actions: "Redemption or wind-down follows the approved offering terms.",
      evidence: "Exit notice and final distribution record.",
      reviewer: null,
      submitted: null,
      reviewed: null,
      outstanding: [],
    },
  ];
}

/** The first stage that still needs something, described as the next permitted step. */
export function nextStep(stages: JourneyStage[]): string {
  const s = stages.find((x) => x.status === "action_required" || x.status === "rejected")
    ?? stages.find((x) => x.status === "in_progress" || x.status === "not_started");
  if (!s) return "No further step is available until the remaining services are built.";
  return `${s.title}: ${s.actions}`;
}
