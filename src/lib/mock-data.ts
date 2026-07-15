export type RiskProfile = "Conservative" | "Moderate" | "Aggressive";
export type AssetCategory = "Sustainable Farming" | "Clean Energy" | "Real Estate" | "Carbon Credits" | "Infrastructure";

export interface Asset {
  id: string;
  name: string;
  category: AssetCategory;
  apy: number;
  risk: RiskProfile;
  fundedPct: number;
  targetAda: number;
  maturityMonths: number;
  esgRating: "AAA" | "AA" | "A" | "BBB";
  minInvestmentAda: number;
  description: string;
  location: string;
  issuer: string;
}

export const ASSETS: Asset[] = [
  {
    id: "sfm-01",
    name: "Andean Sustainable Coffee Yield",
    category: "Sustainable Farming",
    apy: 9.2,
    risk: "Moderate",
    fundedPct: 68,
    targetAda: 1_250_000,
    maturityMonths: 24,
    esgRating: "AA",
    minInvestmentAda: 100,
    description: "Fractionalized yield from 340 hectares of certified organic coffee estates across Colombia and Peru.",
    location: "Colombia · Peru",
    issuer: "Andes Verde Cooperativa",
  },
  {
    id: "ceb-02",
    name: "Nordic Wind Farm Bond Series III",
    category: "Clean Energy",
    apy: 6.4,
    risk: "Conservative",
    fundedPct: 91,
    targetAda: 4_800_000,
    maturityMonths: 60,
    esgRating: "AAA",
    minInvestmentAda: 250,
    description: "Senior secured bond financing 82MW of onshore wind capacity with 15-year PPA offtake.",
    location: "Denmark",
    issuer: "Kattegat Energi AS",
  },
  {
    id: "cc-03",
    name: "Amazon Basin Carbon Credit Vault",
    category: "Carbon Credits",
    apy: 12.8,
    risk: "Aggressive",
    fundedPct: 42,
    targetAda: 900_000,
    maturityMonths: 36,
    esgRating: "A",
    minInvestmentAda: 500,
    description: "Verified REDD+ carbon credits from 12,000 ha of protected rainforest. Verra-registered.",
    location: "Brazil",
    issuer: "Terra Firma Impact Trust",
  },
  {
    id: "re-04",
    name: "Lisbon Prime Residential Fund",
    category: "Real Estate",
    apy: 7.1,
    risk: "Moderate",
    fundedPct: 55,
    targetAda: 3_200_000,
    maturityMonths: 48,
    esgRating: "AA",
    minInvestmentAda: 250,
    description: "Fractional ownership across 24 rental properties in central Lisbon. Quarterly distributions.",
    location: "Portugal",
    issuer: "Tejo Residencial SICAFI",
  },
  {
    id: "inf-05",
    name: "Kenya Solar Microgrid Infrastructure",
    category: "Infrastructure",
    apy: 10.5,
    risk: "Aggressive",
    fundedPct: 28,
    targetAda: 1_600_000,
    maturityMonths: 42,
    esgRating: "A",
    minInvestmentAda: 200,
    description: "Financing 140 off-grid solar microgrids serving 62,000 rural households.",
    location: "Kenya",
    issuer: "Rift Valley Power Ltd",
  },
  {
    id: "ceb-06",
    name: "Iberian Green Hydrogen Notes",
    category: "Clean Energy",
    apy: 8.3,
    risk: "Moderate",
    fundedPct: 76,
    targetAda: 2_400_000,
    maturityMonths: 30,
    esgRating: "AA",
    minInvestmentAda: 250,
    description: "Structured notes backed by long-term hydrogen offtake contracts with EU industrial buyers.",
    location: "Spain",
    issuer: "H2 Iberia SA",
  },
];

export interface Investment {
  assetId: string;
  amountAda: number;
  entryDate: string;
  currentValueAda: number;
  yieldEarnedAda: number;
}

export const PORTFOLIO: Investment[] = [
  { assetId: "sfm-01", amountAda: 12_500, entryDate: "2025-11-04", currentValueAda: 13_240, yieldEarnedAda: 740 },
  { assetId: "ceb-02", amountAda: 25_000, entryDate: "2025-08-12", currentValueAda: 26_680, yieldEarnedAda: 1_680 },
  { assetId: "re-04", amountAda: 8_000, entryDate: "2026-01-18", currentValueAda: 8_312, yieldEarnedAda: 312 },
];

export interface Proposal {
  id: string;
  title: string;
  status: "Voting" | "Executed" | "Defeated" | "Queued";
  category: "Treasury" | "Protocol" | "Listing" | "Risk";
  forPct: number;
  againstPct: number;
  quorumPct: number;
  endsIn: string;
  author: string;
}

export const PROPOSALS: Proposal[] = [
  { id: "SIP-042", title: "Onboard Andean Coffee Vault as senior collateral", status: "Voting", category: "Listing", forPct: 78, againstPct: 12, quorumPct: 62, endsIn: "2d 14h", author: "steward.eth" },
  { id: "SIP-041", title: "Reduce insurance fund haircut to 4.5%", status: "Voting", category: "Risk", forPct: 54, againstPct: 41, quorumPct: 71, endsIn: "1d 03h", author: "risk.core" },
  { id: "SIP-040", title: "Treasury allocation: 2.4M ADA to Nordic Wind III", status: "Executed", category: "Treasury", forPct: 88, againstPct: 6, quorumPct: 82, endsIn: "—", author: "treasury.dao" },
  { id: "SIP-039", title: "Enable ZK-KYC bridge with Midnight", status: "Executed", category: "Protocol", forPct: 92, againstPct: 3, quorumPct: 79, endsIn: "—", author: "core.dev" },
  { id: "SIP-038", title: "Delist Iberian H2 Notes (early redemption)", status: "Defeated", category: "Listing", forPct: 22, againstPct: 68, quorumPct: 55, endsIn: "—", author: "member.7723" },
];

export const VAULT_ACTIVITY = [
  { id: 1, kind: "Deposit", asset: "ADA", amount: "+120,000", who: "vault.rwa.02", time: "2m ago" },
  { id: 2, kind: "Yield Distribution", asset: "Nordic Wind III", amount: "+18,240", who: "12,844 holders", time: "18m ago" },
  { id: 3, kind: "Withdrawal", asset: "ADA", amount: "-42,500", who: "steward.eth", time: "1h ago" },
  { id: 4, kind: "Rebalance", asset: "Coffee Vault", amount: "±", who: "auto-strategy", time: "3h ago" },
  { id: 5, kind: "Timelock Set", asset: "SIP-040", amount: "24h", who: "governance", time: "6h ago" },
];

/** Deterministic sparkline series for TVL / yield */
export function sparkline(seed: number, points = 24): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < points; i++) {
    const s = Math.sin((seed + i) * 0.7) + Math.cos((seed + i) * 0.31);
    v += s * 2.4 + (i / points) * 1.6;
    out.push(v);
  }
  return out;
}

export function formatAda(n: number): string {
  if (n >= 1_000_000) return `₳ ${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `₳ ${(n / 1_000).toFixed(1)}K`;
  return `₳ ${n.toFixed(0)}`;
}
export function formatUsd(ada: number, rate = 0.42): string {
  const usd = ada * rate;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}
