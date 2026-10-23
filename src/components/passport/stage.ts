/** Plain-language project stage, derived only from stored registry and vault facts. */
export function passportStage(input: {
  funding_status: string;
  vaultLive: boolean;
  payouts: number;
}): string {
  if (input.funding_status === "demo") return "Demo listing — not an offering";
  if (input.payouts > 0) return "Vault live on Preprod · payouts recorded";
  if (input.vaultLive) return "Vault live on Preprod (test)";
  if (input.funding_status === "pilot") return "Preprod pilot — vault not live";
  if (input.funding_status === "open") return "Listed on testnet — vault not live";
  return input.funding_status;
}
