/**
 * Platform terms shown during funding-request onboarding (`/funding/new`)
 * and at `/terms`. Plain data — shared between the client wizard (renders
 * it) and `funding-requests.functions.ts` (records which version a
 * submitter accepted). Bump `FUNDING_TERMS_VERSION` whenever the wording
 * changes materially; past acceptances keep the version they agreed to.
 */

export const FUNDING_TERMS_VERSION = "2026-08-11";

export interface TermsSection {
  heading: string;
  body: string;
}

export const FUNDING_TERMS_SECTIONS: TermsSection[] = [
  {
    heading: "Preprod only — no real value",
    body: "Everything on this platform currently runs on Cardano Preprod. No ADA submitted, deposited, or referenced in a funding request has real-world value, and nothing here is deployed to mainnet. See /security for the current network status.",
  },
  {
    heading: "Your submission is public and must be accurate",
    body: "The project name, issuer, description, target raise, evidence links, and proposed management fee you submit are published immediately and shown to every voter. Do not submit fabricated evidence, unverifiable claims, or information you are not authorized to publish. A request found to contain false information may be rejected or removed at any time.",
  },
  {
    heading: "Submitting is not approval",
    body: "There is no admin pre-screen. Your request enters a public pipeline and becomes investable only if a governance proposal built from it passes a community vote, and only after an operator separately bootstraps its on-chain vault with the approved terms. Submitting a request creates no asset, no vault, and moves no funds.",
  },
  {
    heading: "The management fee is enforced on chain, not negotiable after bootstrap",
    body: "The fee you propose here (0–5.00%/yr) is charged annually on accounted vault assets and settled by minting shares to the treasury — no ADA is paid out when the fee is charged. Once a vault is bootstrapped with a fee rate, that rate can only be changed through a subsequent governance-executed action, never unilaterally.",
  },
  {
    heading: "No investment advice, no guarantee of yield",
    body: "Nothing on this platform is investment, legal, or tax advice. Any APY figures shown — including projections in this onboarding flow — are illustrative calculations of the fee formula, not a promise of returns. Yield depends entirely on the real-world performance of the underlying asset, which this platform does not control or guarantee.",
  },
];
