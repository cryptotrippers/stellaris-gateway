import { useEffect, useState } from "react";
import { ASSETS } from "./mock-data";

export interface Payout {
  txHash: string;
  block: number;
  slot: number;
  epoch: number;
  timestamp: number;
  assetId: string;
  amountAda: number;
  holders: number;
  apyAtPayout: number;
  merkleRoot: string;
  zkProof: string;
  verified: true;
}

export interface LiveYield {
  assetId: string;
  apy: number;      // annualized %
  apy24h: number;   // 24h delta pp
  streamedAda: number; // ADA streamed so far in current epoch
  lastTickMs: number;
  history: number[]; // last 32 APY samples
}

function hash(prefix: string, seed: number, len = 56): string {
  const alphabet = "0123456789abcdef";
  let out = "";
  let v = seed >>> 0;
  for (let i = 0; i < len; i++) {
    v = (v * 1664525 + 1013904223) >>> 0;
    out += alphabet[v % 16];
  }
  return prefix + out;
}

const START_EPOCH = 512;
const EPOCH_MS = 5 * 24 * 3600 * 1000; // Cardano epoch ≈ 5 days
const NOW = Date.now();

/** Deterministic payout history spanning the last 60 days across all assets. */
export function generatePayoutHistory(count = 42): Payout[] {
  const out: Payout[] = [];
  for (let i = 0; i < count; i++) {
    const asset = ASSETS[i % ASSETS.length];
    const daysAgo = i * 1.4 + Math.sin(i * 1.7) * 0.6;
    const ts = NOW - daysAgo * 24 * 3600 * 1000;
    const epoch = START_EPOCH - Math.floor(daysAgo / 5);
    const slot = 21_600 * (5 - Math.floor(daysAgo % 5)) + Math.floor((i * 7919) % 21_600);
    const block = 10_842_113 - i * 1487 - Math.floor((i * 991) % 200);
    const drift = Math.sin(i * 0.9) * 0.4 + Math.cos(i * 0.31) * 0.2;
    const apy = Math.max(3, asset.apy + drift);
    const amount = Math.round((asset.apy / 100 / 12) * (asset.targetAda * (asset.fundedPct / 100)) / 4);
    out.push({
      txHash: hash("", i * 13 + asset.id.length, 64),
      block,
      slot,
      epoch,
      timestamp: ts,
      assetId: asset.id,
      amountAda: amount,
      holders: 800 + Math.floor(((i * 601) % 12_000)),
      apyAtPayout: Number(apy.toFixed(2)),
      merkleRoot: hash("0x", i * 17 + 7, 40),
      zkProof: hash("π", i * 23 + 11, 32),
      verified: true,
    });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

export const PAYOUTS: Payout[] = generatePayoutHistory();

function seedLive(assetId: string, i: number): LiveYield {
  const asset = ASSETS.find(a => a.id === assetId)!;
  const history: number[] = [];
  let v = asset.apy;
  for (let k = 0; k < 32; k++) {
    v += Math.sin((i + k) * 0.6) * 0.05 + (Math.random() - 0.5) * 0.03;
    history.push(Number(v.toFixed(3)));
  }
  return {
    assetId,
    apy: history[history.length - 1],
    apy24h: Number((Math.sin(i) * 0.35).toFixed(2)),
    streamedAda: Math.floor(500 + Math.random() * 4000),
    lastTickMs: Date.now(),
    history,
  };
}

/** Live-updating yield feed. Re-emits every `intervalMs`. */
export function useLiveYields(intervalMs = 2000) {
  const [state, setState] = useState<LiveYield[]>(() =>
    ASSETS.map((a, i) => seedLive(a.id, i)),
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setState(prev =>
        prev.map(y => {
          const drift = (Math.sin(Date.now() / 4000 + y.assetId.length) * 0.04) + (Math.random() - 0.5) * 0.06;
          const nextApy = Math.max(2, Math.min(20, y.apy + drift));
          const nextHistory = [...y.history.slice(-31), Number(nextApy.toFixed(3))];
          const nextStreamed = y.streamedAda + Math.max(0, (nextApy / 100 / 365 / (86_400_000 / intervalMs)) * 1_200_000);
          return {
            ...y,
            apy: nextApy,
            history: nextHistory,
            streamedAda: nextStreamed,
            lastTickMs: Date.now(),
          };
        }),
      );
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return state;
}

export function short(hex: string, head = 8, tail = 6) {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function cardanoscanTx(hash: string) {
  return `https://cardanoscan.io/transaction/${hash.replace(/^0x/, "")}`;
}
export function cardanoscanBlock(block: number) {
  return `https://cardanoscan.io/block/${block}`;
}
