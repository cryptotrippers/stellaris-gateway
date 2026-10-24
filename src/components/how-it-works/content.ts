/**
 * Educational content for /how-it-works. These stages describe the general
 * process; they are NOT the status of any real project. Feature readiness
 * describes what the platform has built, never how far a project has moved.
 */
import type { FeatureStage } from "@/components/brand/FeatureStatus";

export type JourneyKey = "asset" | "investor" | "tessera";

export const JOURNEYS: { key: JourneyKey; label: string; short: string }[] = [
  { key: "asset", label: "Asset lifecycle", short: "Assets" },
  { key: "investor", label: "Investor journey", short: "Investors" },
  { key: "tessera", label: "Tessera", short: "Tessera" },
];

export const isJourneyKey = (v: unknown): v is JourneyKey =>
  v === "asset" || v === "investor" || v === "tessera";

export type Gate = { id: "A" | "B" | "C" | "D"; label: string; note: string };

export type AssetStage = {
  key: string;
  title: string;
  icon: "inbox" | "id" | "folder" | "search" | "file" | "coins" | "milestone" | "chart" | "door";
  summary: string;
  happens: string;
  evidence: string;
  decides: string;
  canFail: string;
  next: string;
  readiness: FeatureStage[];
  readinessNote: string;
  gate?: Gate;
};

export const ASSET_STAGES: AssetStage[] = [
  {
    key: "enquiry",
    title: "Enquiry",
    icon: "inbox",
    summary: "An issuer introduces the project and organisation.",
    happens: "The issuer submits an enquiry describing the asset, its location, the capital sought and the team.",
    evidence: "Contact details, project outline and organisation name.",
    decides: "The Stellaris team decides whether to invite a full application.",
    canFail: "The project is outside scope, too early, or the information is incomplete.",
    next: "Invitation to verify the issuing organisation.",
    readiness: ["verified"],
    readinessNote: "Enquiry form and private lead management are built and tested.",
  },
  {
    key: "identity",
    title: "Issuer identity",
    icon: "id",
    summary: "The organisation's identity and control are checked.",
    happens: "The issuer's legal entity, directors and beneficial owners are identified (know-your-business).",
    evidence: "Registration records, director identity and ownership structure.",
    decides: "An authorised administrator records the verification decision on the server.",
    canFail: "Identity cannot be confirmed, ownership is unclear, or sanctions screening fails.",
    next: "Access to a private document room.",
    readiness: ["unverified", "awaiting_backend"],
    readinessNote:
      "Verification status is stored and shown; an integrated third-party KYB provider is not connected yet.",
    gate: { id: "A", label: "Gate A · Issuer verified (KYB)", note: "No project moves forward until the issuer is verified." },
  },
  {
    key: "documents",
    title: "Private documents",
    icon: "folder",
    summary: "Evidence is shared privately with reviewers.",
    happens: "The issuer uploads supporting documents into sections suited to the asset type. Files stay private until an administrator releases them.",
    evidence: "Title, permits, contracts, financial statements, technical reports.",
    decides: "Administrators release or reject each file, with a recorded reason.",
    canFail: "Documents are missing, out of date or inconsistent.",
    next: "Independent review of the evidence.",
    readiness: ["verified", "awaiting_legal"],
    readinessNote:
      "The private document room is built and tested. Legal and independent review processes behind it are still pending.",
  },
  {
    key: "review",
    title: "Evidence review",
    icon: "search",
    summary: "Legal, technical and financial evidence is assessed.",
    happens: "Each checklist item is reviewed and marked verified, rejected or outstanding.",
    evidence: "Reviewer notes against every required checklist item.",
    decides: "Administrators record checklist decisions; independent experts are still to be appointed.",
    canFail: "Key evidence is rejected or a material risk is found.",
    next: "Drafting offering terms.",
    readiness: ["unverified", "awaiting_legal"],
    readinessNote: "The checklist and review tools exist; independent reviewers are not yet engaged.",
  },
  {
    key: "terms",
    title: "Offering terms",
    icon: "file",
    summary: "Rights, fees, risks and exit terms are written down.",
    happens: "Offering documents set out what holders own, the fees, the risks and how the project ends.",
    evidence: "Offering memorandum, rights summary and risk disclosures.",
    decides:
      "An accountable, licensed party must approve the offering. Testnet governance votes do not count as this approval.",
    canFail: "Terms cannot be approved, or the offering is not permitted in a jurisdiction.",
    next: "Opening the funding round.",
    readiness: ["awaiting_legal"],
    readinessNote: "Waiting for a licensing and legal framework. No real offerings exist.",
    gate: {
      id: "B",
      label: "Gate B · Accountable listing approval",
      note: "Legal and offering approval by an accountable party — separate from testnet governance.",
    },
  },
  {
    key: "funding",
    title: "Funding",
    icon: "coins",
    summary: "Participants subscribe; funds are held until conditions are met.",
    happens: "Eligible participants subscribe. Funds are held until the funding conditions in the terms are met.",
    evidence: "Subscription records and the funding conditions (minimum raise, deadline).",
    decides: "The conditions written in the offering terms, checked and recorded.",
    canFail: "The minimum is not reached by the deadline — the round fails.",
    next: "Milestone-based release of capital.",
    readiness: ["demo", "awaiting_backend"],
    readinessNote: "On-chain vaults run on the Preprod testnet with test tokens only. Real-money escrow is not built.",
    gate: {
      id: "C",
      label: "Gate C · Funding conditions met",
      note: "Only the actual conditions in the terms — never a target set by the page.",
    },
  },
  {
    key: "release",
    title: "Milestone release",
    icon: "milestone",
    summary: "Capital is released only against approved milestones.",
    happens: "Capital is released in tranches as the project proves each milestone.",
    evidence: "Milestone evidence such as invoices, inspections or commissioning reports.",
    decides: "An authorised release approval recorded on the server.",
    canFail: "A milestone is not met; remaining capital stays held.",
    next: "Operation and reporting.",
    readiness: ["awaiting_backend"],
    readinessNote: "Release authorisation workflow is not built yet.",
    gate: {
      id: "D",
      label: "Gate D · Release authorised",
      note: "Each tranche needs its own recorded authorisation.",
    },
  },
  {
    key: "reporting",
    title: "Reporting & distributions",
    icon: "chart",
    summary: "The asset reports income, costs and material events.",
    happens: "The project reports revenue, costs and events. Approved distributable cash is shared with eligible holders.",
    evidence: "Periodic reports, accounts and distribution approvals.",
    decides: "Distribution amounts follow the offering terms and approved accounts.",
    canFail: "Revenue falls, costs rise or a distribution is reduced or skipped.",
    next: "Continued operation until exit.",
    readiness: ["demo", "awaiting_backend"],
    readinessNote: "Distribution views exist as illustrative examples; real reporting feeds are not connected.",
  },
  {
    key: "exit",
    title: "Exit",
    icon: "door",
    summary: "Units are redeemed or the project winds down under its terms.",
    happens: "The project is sold, refinanced or wound down and holders are paid according to the terms.",
    evidence: "Sale or wind-down documents and final accounts.",
    decides: "The process set out in the offering terms.",
    canFail: "The asset sells for less than expected or later than planned.",
    next: "Final distribution and closure.",
    readiness: ["awaiting_legal"],
    readinessNote: "Exit mechanics depend on the legal framework still to be approved.",
  },
];

export type InvestorStep = {
  key: string;
  title: string;
  icon: "compass" | "passport" | "scale" | "check" | "wallet" | "calendar";
  text: string;
  readiness: FeatureStage;
};

export const INVESTOR_STEPS: InvestorStep[] = [
  { key: "discover", title: "Discover", icon: "compass", text: "Browse listed assets by category, region and status in the marketplace.", readiness: "verified" },
  { key: "passport", title: "Read the Asset Passport", icon: "passport", text: "See evidence, documents released by reviewers and what is still pending.", readiness: "verified" },
  { key: "assess", title: "Assess rights & risks", icon: "scale", text: "Understand what you would own, the fees, the risks and how you could exit.", readiness: "awaiting_legal" },
  { key: "eligibility", title: "Check eligibility", icon: "check", text: "Confirm you are allowed to take part where you live. Not available yet.", readiness: "awaiting_legal" },
  { key: "confirm", title: "Confirm a transaction", icon: "wallet", text: "On Preprod, you sign test transactions in your own wallet. Nothing moves without your signature.", readiness: "demo" },
  { key: "follow", title: "Follow distributions & exit", icon: "calendar", text: "Track reported distributions and exit events for what you hold.", readiness: "awaiting_backend" },
];

export type TxState = { key: string; label: string; tone: "neutral" | "warn" | "progress" | "ok" | "fail"; text: string };

export const TX_STATES: TxState[] = [
  { key: "disconnected", label: "Wallet disconnected", tone: "neutral", text: "Connect a Cardano wallet to continue." },
  { key: "network", label: "Wrong network", tone: "warn", text: "Switch your wallet to Preprod. Mainnet is blocked." },
  { key: "signature", label: "Awaiting signature", tone: "progress", text: "Review and sign in your wallet, or cancel." },
  { key: "submitted", label: "Submitted", tone: "progress", text: "Sent to the network; waiting to be included in a block." },
  { key: "confirmed", label: "Confirmed", tone: "ok", text: "Seen on-chain. Only now is it recorded." },
  { key: "failed", label: "Failed", tone: "fail", text: "Rejected or expired. Nothing was recorded; you can retry." },
];

export const WATERFALL_STEPS = [
  { key: "revenue", label: "Revenue received", text: "Cash the asset actually collects.", kind: "in" },
  { key: "costs", label: "Operating costs", text: "Running, maintenance and insurance.", kind: "out" },
  { key: "debt", label: "Debt service & tax", text: "Loan repayments, interest and tax.", kind: "out" },
  { key: "reserve", label: "Reserve", text: "Held back for repairs and shortfalls.", kind: "out" },
  { key: "approved", label: "Approved distributable cash", text: "What remains after approval of accounts.", kind: "result" },
  { key: "holders", label: "Eligible holder distributions", text: "Shared pro rata among eligible holders.", kind: "result" },
] as const;
