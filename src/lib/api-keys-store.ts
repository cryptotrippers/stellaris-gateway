import { useSyncExternalStore } from "react";

export type ApiKeyStatus = "active" | "revoked";
export type ApiKeyEnv = "live" | "test";

export interface ApiKey {
  id: string;
  label: string;
  env: ApiKeyEnv;
  prefix: string; // e.g. sk_live_stl_
  last4: string;
  full: string; // full secret; shown once after create/rotate
  createdAt: number;
  lastUsedAt: number | null;
  status: ApiKeyStatus;
  quotaPerMin: number;
  usedThisMin: number;
  monthlyCalls: number;
  monthlyLimit: number;
}

const STORAGE_KEY = "stellaris.api-keys.v1";

function rand(len: number) {
  const alphabet = "abcdef0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function makeKey(env: ApiKeyEnv, label: string, quotaPerMin = 6000, monthlyLimit = 5_000_000): ApiKey {
  const body = rand(32);
  const prefix = `sk_${env}_stl_`;
  return {
    id: `key_${rand(10)}`,
    label,
    env,
    prefix,
    last4: body.slice(-4),
    full: `${prefix}${body}`,
    createdAt: Date.now(),
    lastUsedAt: Date.now() - Math.floor(Math.random() * 3_600_000),
    status: "active",
    quotaPerMin,
    usedThisMin: Math.floor(Math.random() * (quotaPerMin * 0.4)),
    monthlyCalls: Math.floor(Math.random() * (monthlyLimit * 0.6)),
    monthlyLimit,
  };
}

function seed(): ApiKey[] {
  return [
    { ...makeKey("live", "Primary (production)"), monthlyCalls: 3_142_808 },
    { ...makeKey("test", "Sandbox", 2000, 1_000_000), monthlyCalls: 128_432 },
  ];
}

function load(): ApiKey[] {
  if (typeof window === "undefined") return seed();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const s = seed();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      return s;
    }
    return JSON.parse(raw) as ApiKey[];
  } catch {
    return seed();
  }
}

let state: ApiKey[] = load();
const listeners = new Set<() => void>();

function persist() {
  if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  listeners.forEach(l => l());
}

export const apiKeysStore = {
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  get() { return state; },
  create(label: string, env: ApiKeyEnv, quotaPerMin: number, monthlyLimit: number) {
    const k = makeKey(env, label || `${env === "live" ? "Live" : "Test"} key`, quotaPerMin, monthlyLimit);
    k.monthlyCalls = 0;
    k.usedThisMin = 0;
    state = [k, ...state];
    persist();
    return k;
  },
  rotate(id: string) {
    let rotated: ApiKey | null = null;
    state = state.map(k => {
      if (k.id !== id) return k;
      const fresh = makeKey(k.env, k.label, k.quotaPerMin, k.monthlyLimit);
      rotated = { ...fresh, id: k.id, monthlyCalls: k.monthlyCalls, createdAt: Date.now(), status: "active" };
      return rotated;
    });
    persist();
    return rotated;
  },
  revoke(id: string) {
    state = state.map(k => k.id === id ? { ...k, status: "revoked" as const } : k);
    persist();
  },
  remove(id: string) {
    state = state.filter(k => k.id !== id);
    persist();
  },
  updateQuota(id: string, quotaPerMin: number, monthlyLimit: number) {
    state = state.map(k => k.id === id ? { ...k, quotaPerMin, monthlyLimit } : k);
    persist();
  },
};

export function useApiKeys() {
  return useSyncExternalStore(apiKeysStore.subscribe, apiKeysStore.get, apiKeysStore.get);
}

export function maskKey(k: ApiKey) {
  return `${k.prefix}${"•".repeat(24)}${k.last4}`;
}
