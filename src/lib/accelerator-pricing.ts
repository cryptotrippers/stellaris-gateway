/**
 * Accelerator revenue surface — scaffolded and OFF by default.
 *
 * Nothing charges anyone until these flags are switched on. They are read at
 * render time only; no Stripe call is made while a flag is false.
 */

export const ACCELERATOR_BILLING = {
  /** Charge issuers a listing/verification service fee when submitting. */
  listingFeeEnabled: false,
  listingFeeUsd: 250,
  /** Gate pipeline data export and API access behind a premium tier. */
  premiumAnalyticsEnabled: false,
  premiumAnalyticsUsdPerMonth: 49,
} as const;

export function billingIsLive(): boolean {
  return ACCELERATOR_BILLING.listingFeeEnabled || ACCELERATOR_BILLING.premiumAnalyticsEnabled;
}
