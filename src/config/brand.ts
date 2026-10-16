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
      "Dollar-referenced stablecoin, 1 TSRA = 1 USD. Does not earn yield; redeemable instantly.",
  },
  staked: {
    ticker: "sTSRA",
    name: "Staked Tessera",
    description:
      "Yield-bearing staked TSRA. Earns from the reserve portfolio and unstakes after a cooldown.",
  },
} as const;
