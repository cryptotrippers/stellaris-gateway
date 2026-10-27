/**
 * Sprint 1 E03 — tamper-evident hash chain for the Meridian (Rail B) ledger.
 *
 * Every persisted ledger entry carries `entry_hash = sha256(prev_hash ‖ "\n" ‖
 * canonical(entry))`, where `prev_hash` is the previous entry's hash in the
 * same project (or GENESIS for the first). Changing, removing or reordering
 * any stored entry breaks every hash after it, so `verifyChain` recomputing
 * the chain from the rows detects tampering — including by someone with
 * direct database access.
 *
 * An approved period also gets a Merkle root over its entries' hashes
 * (`periodRoot`), the value later anchored on-chain (E23 / v2 CommitPeriod)
 * so anyone can check a payout against the approved books without seeing
 * the books.
 *
 * Plain shared module: deterministic, no I/O, no floating point. Uses SHA-256
 * from @noble/hashes (already a dependency); nothing here is a home-made
 * cryptographic primitive — only a standard hash chain and a standard
 * domain-separated Merkle tree.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { LedgerEntry } from "./financial-ledger.shared";

/** Hash-format version, part of every hashed payload. */
export const LEDGER_HASH_VERSION = 1;

/** `prev_hash` of a project's first entry. */
export const GENESIS = "0".repeat(64);

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, bigints as
 * decimal strings. Two equal values always produce the same text.
 */
export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "bigint":
      return JSON.stringify(value.toString());
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonical(): non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical(): unsupported ${typeof value}`);
  }
}

const sha256Hex = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** What is hashed for one entry: the entry plus its place in the project. */
export function entryPayload(projectId: string, currency: string, seq: bigint, entry: LedgerEntry) {
  return { v: LEDGER_HASH_VERSION, projectId, currency, seq, entry };
}

export function hashEntry(
  prevHash: string,
  projectId: string,
  currency: string,
  seq: bigint,
  entry: LedgerEntry,
): string {
  if (!HEX64.test(prevHash)) throw new Error("prev hash must be 64 lowercase hex characters");
  const text = `${prevHash}\n${canonical(entryPayload(projectId, currency, seq, entry))}`;
  return sha256Hex(utf8ToBytes(text));
}

export interface ChainedEntry {
  readonly seq: bigint;
  readonly prevHash: string;
  readonly entryHash: string;
  readonly entry: LedgerEntry;
}

/** The point a new batch is appended after. */
export interface ChainHead {
  readonly seq: bigint;
  readonly hash: string;
}

export const EMPTY_HEAD: ChainHead = { seq: 0n, hash: GENESIS };

/** Chain new entries onto `head`; seqs continue from head.seq + 1. */
export function chainEntries(
  projectId: string,
  currency: string,
  head: ChainHead,
  entries: readonly LedgerEntry[],
): ChainedEntry[] {
  const out: ChainedEntry[] = [];
  let prev = head.hash;
  let seq = head.seq;
  for (const entry of entries) {
    seq += 1n;
    const entryHash = hashEntry(prev, projectId, currency, seq, entry);
    out.push({ seq, prevHash: prev, entryHash, entry });
    prev = entryHash;
  }
  return out;
}

export type ChainCheck =
  | { ok: true; head: ChainHead; count: number }
  | { ok: false; seq: bigint; reason: string };

/**
 * Recompute a project's whole chain from stored rows (any order) and report
 * the first break: a gap or duplicate in seq, a prev_hash that doesn't match
 * the previous row, or a stored hash that doesn't match the content.
 */
export function verifyChain(
  projectId: string,
  currency: string,
  rows: readonly ChainedEntry[],
): ChainCheck {
  const sorted = [...rows].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  let prev = GENESIS;
  let expected = 1n;
  for (const r of sorted) {
    if (r.seq !== expected) {
      return { ok: false, seq: r.seq, reason: `expected seq ${expected}, found ${r.seq}` };
    }
    if (r.prevHash !== prev) {
      return { ok: false, seq: r.seq, reason: "prev_hash does not match the previous entry" };
    }
    const actual = hashEntry(prev, projectId, currency, r.seq, r.entry);
    if (actual !== r.entryHash) {
      return { ok: false, seq: r.seq, reason: "entry content does not match its stored hash" };
    }
    prev = r.entryHash;
    expected += 1n;
  }
  return { ok: true, head: { seq: expected - 1n, hash: prev }, count: sorted.length };
}

// --- Merkle root (RFC 6962-style domain separation) ---------------------------

const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

/**
 * Merkle root over 32-byte hex leaves, in the given order. Leaves and inner
 * nodes are prefixed 0x00 / 0x01 so a leaf can never be passed off as a node.
 * An odd node at any level is promoted unchanged. Empty input hashes "".
 */
export function merkleRoot(leavesHex: readonly string[]): string {
  if (leavesHex.length === 0) return sha256Hex(new Uint8Array());
  let level: Uint8Array[] = leavesHex.map((h) => {
    if (!HEX64.test(h)) throw new Error("merkle leaves must be 64 lowercase hex characters");
    return sha256(concatBytes(LEAF, hexToBytes(h)));
  });
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right ? sha256(concatBytes(NODE, left, right)) : left);
    }
    level = next;
  }
  return bytesToHex(level[0]!);
}

/** Root over one period's entries, in chain order. */
export function periodRoot(rows: readonly ChainedEntry[], periodId: string): string {
  const inPeriod = rows
    .filter((r) => r.entry.periodId === periodId)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
    .map((r) => r.entryHash);
  return merkleRoot(inPeriod);
}
