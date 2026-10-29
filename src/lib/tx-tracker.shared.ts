/**
 * E07 — transaction tracker (SPEC-v2.md §7).
 *
 * Follows a submitted transaction until it is safe to treat as done, and says
 * plainly when it is not:
 *
 *   pending      submitted, not yet in a block;
 *   onchain      in a block, fewer than `finalDepth` blocks deep;
 *   final        `finalDepth` or more blocks deep (terminal);
 *   rolled_back  was in a block and is no longer (a chain rollback). It may
 *                come back; until then its outputs do not exist and nothing
 *                built on them can be submitted;
 *   expired      never seen, and its validity window has closed: it can never
 *                be included, so it is safe to rebuild (terminal).
 *
 * The core (`advance`) is pure: it takes what the chain shows now and returns
 * the next record, so every transition is unit-tested. `trackTx` polls a
 * `ChainReader`; `blockfrostReader` reads through the same-origin proxy
 * (`/api/bf`, E13), so no key reaches the browser.
 *
 * Finality here is practical, not absolute: Cardano's settlement guarantee is
 * k = 2160 blocks. `FINAL_DEPTH` (15 blocks, about 5 minutes) is what the app
 * waits for before it builds on a result; operators reconcile at k.
 */

export type TrackStatus = "pending" | "onchain" | "final" | "rolled_back" | "expired";

export interface Tracked {
  readonly hash: string;
  readonly status: TrackStatus;
  /** Upper validity bound of the transaction (POSIX ms). */
  readonly validTo: number;
  /** Height of the block the transaction is in, while it is on chain. */
  readonly height: number | null;
  /** Blocks deep, counting its own block as 1; 0 while not on chain. */
  readonly depth: number;
  /** Times the transaction left the chain after being seen. */
  readonly rollbacks: number;
}

/** What the chain shows at one moment. */
export interface ChainSnapshot {
  /** Height of the latest block. */
  readonly tip: number;
  /** Height of the block holding the transaction, or null if none does. */
  readonly txHeight: number | null;
  /** Wall-clock time of the snapshot (POSIX ms). */
  readonly now: number;
}

export const FINAL_DEPTH = 15;
/** After `validTo`, wait this long before calling a never-seen tx expired. */
export const EXPIRY_GRACE_MS = 120_000;

const TX_HASH = /^[0-9a-f]{64}$/;

export function track(hash: string, validTo: number): Tracked {
  const h = hash.toLowerCase();
  if (!TX_HASH.test(h)) throw new Error("A transaction hash is 64 hex characters.");
  if (!Number.isFinite(validTo)) throw new Error("Give the transaction's validity end.");
  return { hash: h, status: "pending", validTo, height: null, depth: 0, rollbacks: 0 };
}

const TERMINAL: ReadonlySet<TrackStatus> = new Set(["final", "expired"]);

export const isTerminal = (t: Tracked) => TERMINAL.has(t.status);

/** The next record, given what the chain shows now. Terminal records stay put. */
export function advance(t: Tracked, s: ChainSnapshot, finalDepth = FINAL_DEPTH): Tracked {
  if (isTerminal(t)) return t;
  if (s.txHeight !== null) {
    const depth = Math.max(1, s.tip - s.txHeight + 1);
    return {
      ...t,
      status: depth >= finalDepth ? "final" : "onchain",
      height: s.txHeight,
      depth,
    };
  }
  if (t.status === "onchain") {
    return { ...t, status: "rolled_back", height: null, depth: 0, rollbacks: t.rollbacks + 1 };
  }
  if (t.status === "rolled_back") {
    // Still gone. Once the window closes it can no longer come back.
    return s.now > t.validTo + EXPIRY_GRACE_MS ? { ...t, status: "expired" } : t;
  }
  return s.now > t.validTo + EXPIRY_GRACE_MS ? { ...t, status: "expired" } : t;
}

/** Plain-English line for the UI. */
export function describe(t: Tracked, finalDepth = FINAL_DEPTH): string {
  switch (t.status) {
    case "pending":
      return "Submitted; waiting for the transaction to reach a block.";
    case "onchain":
      return `In a block; ${t.depth} of ${finalDepth} confirmations.`;
    case "final":
      return "Confirmed.";
    case "rolled_back":
      return "The chain rolled back past this transaction. Waiting to see whether it is included again; do not act on it yet.";
    case "expired":
      return "This transaction was never included and can no longer be. Nothing moved; you can try again.";
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface ChainReader {
  tip(): Promise<number>;
  /** Block height of the transaction, or null when no block holds it. */
  txHeight(hash: string): Promise<number | null>;
}

export interface TrackOptions {
  finalDepth?: number;
  intervalMs?: number;
  /** Give up (returning the last record) after this long. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onChange?: (t: Tracked) => void;
}

/**
 * Poll until the transaction is final or expired (or the timeout passes).
 * Calls `onChange` on every status or depth change. A failed read is skipped,
 * never treated as "not on chain".
 */
export async function trackTx(
  reader: ChainReader,
  start: Tracked,
  opts: TrackOptions = {},
): Promise<Tracked> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 10_000;
  const deadline = now() + (opts.timeoutMs ?? 30 * 60_000);
  let t = start;
  while (!isTerminal(t) && now() <= deadline) {
    try {
      const [tip, txHeight] = await Promise.all([reader.tip(), reader.txHeight(t.hash)]);
      const next = advance(t, { tip, txHeight, now: now() }, opts.finalDepth);
      if (next.status !== t.status || next.depth !== t.depth) opts.onChange?.(next);
      t = next;
    } catch {
      // A failed read says nothing about the transaction; try again.
    }
    if (!isTerminal(t)) await sleep(interval);
  }
  return t;
}

/**
 * Reader over the same-origin Blockfrost proxy. `get` performs a GET of a
 * proxy path (e.g. `/api/bf/blocks/latest`) and returns { status, json }.
 * A 404 for a transaction means no block holds it.
 */
export function blockfrostReader(
  get: (path: string) => Promise<{ status: number; json: unknown }>,
  base = "/api/bf",
): ChainReader {
  const height = (j: unknown, key: string): number => {
    const v = (j as Record<string, unknown> | null)?.[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new Error(`unexpected ${key}`);
    }
    return v;
  };
  return {
    async tip() {
      const r = await get(`${base}/blocks/latest`);
      if (r.status !== 200) throw new Error(`tip read failed (${r.status})`);
      return height(r.json, "height");
    },
    async txHeight(hash) {
      if (!TX_HASH.test(hash)) throw new Error("bad hash");
      const r = await get(`${base}/txs/${hash}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`tx read failed (${r.status})`);
      return height(r.json, "block_height");
    },
  };
}
