/**
 * Illustrative transparency figures for the testnet preview.
 * All numbers here are placeholders — replace this module with live
 * Blockfrost / database reads; the page only depends on these shapes.
 */
export interface Sleeve {
  id: string;
  name: string;
  detail: string;
  sharePct: number;
  targetMinPct: number;
  targetMaxPct: number;
}

export interface NavPoint {
  date: string; // ISO date
  nav: number; // USD per TSRA-equivalent unit
}

export interface OriginatorExposure {
  name: string;
  sleeve: string;
  exposureUsd: number;
}

export const TRANSPARENCY = {
  asOf: "2026-10-16T00:00:00Z",
  totalReservesUsd: 10_420_000,
  supplyUsd: 10_000_000,
  navHistory: [
    { date: "2026-10-10", nav: 1.0412 },
    { date: "2026-10-11", nav: 1.0414 },
    { date: "2026-10-12", nav: 1.0415 },
    { date: "2026-10-13", nav: 1.0417 },
    { date: "2026-10-14", nav: 1.0418 },
    { date: "2026-10-15", nav: 1.042 },
    { date: "2026-10-16", nav: 1.0421 },
  ] as NavPoint[],
  sleeves: [
    { id: "liquid", name: "Liquid", detail: "Cash + tokenised T-bill money-market funds", sharePct: 64, targetMinPct: 60, targetMaxPct: 70 },
    { id: "short-ig", name: "Short investment grade", detail: "Short-dated investment-grade bonds", sharePct: 6, targetMinPct: 0, targetMaxPct: 10 },
    { id: "credit", name: "Multi-originator credit", detail: "Diversified private credit from vetted originators", sharePct: 23, targetMinPct: 20, targetMaxPct: 30 },
    { id: "rwa", name: "Marketplace RWAs", detail: "Fractional real-world assets from the Stellaris marketplace", sharePct: 7, targetMinPct: 5, targetMaxPct: 10 },
  ] as Sleeve[],
  firstLoss: { levelPct: 2.6, targetPct: 3 },
  overcollateral: { ratioPct: 104.2, targetMinPct: 102, targetMaxPct: 105 },
  originators: [
    { name: "Originator A", sleeve: "Multi-originator credit", exposureUsd: 820_000 },
    { name: "Originator B", sleeve: "Multi-originator credit", exposureUsd: 690_000 },
    { name: "Originator C", sleeve: "Multi-originator credit", exposureUsd: 540_000 },
    { name: "Originator D", sleeve: "Multi-originator credit", exposureUsd: 345_000 },
    { name: "Marketplace issuers", sleeve: "Marketplace RWAs", exposureUsd: 730_000 },
  ] as OriginatorExposure[],
};
