/**
 * Single source of truth for the stablecoin's names and tickers.
 * "Tessera" is a working name pending trademark clearance — a rename must be a
 * one-file change, so UI copy must read every name/ticker from here.
 */
export const BRAND = {
  productName: "Tessera",
  decimals: 6,
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
