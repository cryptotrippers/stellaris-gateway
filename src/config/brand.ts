/**
 * Single source of truth for the stablecoin's names and tickers.
 * "Tessera" is a working name pending trademark clearance — a rename must be a
 * one-file change, so UI copy must read every name/ticker from here.
 */
export const BRAND = {
  productName: "Tessera",
  decimals: 6,
  /** Project site, published in the token registry entries. */
  url: "https://stellarischain.com",
  /**
   * Logo file for the token registry entries. PLACEHOLDER PATH: the artwork is an
   * open item (SPEC.md §7.5). While the file does not exist, registry entries
   * carry no `logo`; when it is added they must be regenerated and re-submitted.
   */
  logo: "public/brand/tessera-logo.png",
  /**
   * Preprod registry entries describe test assets, not the product (registry PR
   * #2995). `scripts/build-token-registry.mjs` appends `nameSuffix` to the name and
   * uses `baseDescription` for TSRA; a mainnet entry uses the descriptions below.
   */
  preprod: {
    nameSuffix: " (Preprod)",
    baseDescription:
      "Preprod test token for the Tessera protocol by Stellaris. Dollar-referenced test asset with no monetary value.",
  },
  base: {
    ticker: "TSRA",
    name: "Tessera",
    description:
      "Dollar-referenced token, 1 TSRA = 1 USD, backed by reserves published on the transparency page. Does not earn yield. Redeemed through a daily redemption queue.",
  },
  staked: {
    ticker: "sTSRA",
    name: "Staked Tessera",
    description:
      "Staked TSRA. Earns a share of the reserve portfolio's yield, credited gradually over 7 days. Rates are variable and can fall.",
  },
} as const;
