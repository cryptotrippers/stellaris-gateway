/**
 * Signature collection for M-of-N accruals.
 *
 * A draft is portable: one operator builds it, the others receive it as a
 * link (or a pasted blob), sign with their own wallet, and send back either
 * the whole updated draft or just their witness. This module owns the
 * encoding, the witness→operator attribution, and the merge rules.
 *
 * Attribution matters: a witness is only accepted when the public key inside
 * it hashes to an operator the transaction actually requires. That stops a
 * stray signature from being counted toward the threshold.
 */

import { blake2b } from "@noble/hashes/blake2.js";
import { decodePlutusDatum, type PlutusData } from "./plutus-cbor";
import type { AccrualDraft } from "./vault-accrual";

/** Draft envelope version — bump if the shape changes. */
const DRAFT_VERSION = 1;
const MAX_DRAFT_CHARS = 200_000;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error("Not valid hex.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cardano key hash: blake2b-224 of the ed25519 public key. */
function keyHashOf(pubKeyHex: string): string {
  return bytesToHex(blake2b(hexToBytes(pubKeyHex), { dkLen: 28 }));
}

function collectBytes(node: PlutusData, out: string[]): void {
  if (node.kind === "bytes") out.push(node.value);
  else if (node.kind === "list") for (const i of node.items) collectBytes(i, out);
  else if (node.kind === "constr") for (const f of node.fields) collectBytes(f, out);
  else if (node.kind === "map") {
    for (const [k, v] of node.entries) {
      collectBytes(k, out);
      collectBytes(v, out);
    }
  }
}

/**
 * Key hashes of every vkey witness in a witness-set CBOR blob. A vkey witness
 * is a 32-byte public key paired with a 64-byte signature, so we pull out the
 * 32-byte strings and hash them.
 */
export function witnessKeyHashes(witnessHex: string): string[] {
  let decoded: PlutusData;
  try {
    decoded = decodePlutusDatum(witnessHex);
  } catch {
    throw new Error("That doesn't look like a transaction witness — expected CBOR hex.");
  }
  const bytes: string[] = [];
  collectBytes(decoded, bytes);
  const hashes = bytes.filter((b) => b.length === 64).map(keyHashOf);
  if (hashes.length === 0) {
    throw new Error("No public key found in that witness.");
  }
  return Array.from(new Set(hashes));
}

/**
 * Merge a pasted witness into a draft. Rejects witnesses that belong to no
 * required operator, and duplicate signatures from the same operator.
 */
export function addWitnessToDraft(draft: AccrualDraft, witnessHex: string): AccrualDraft {
  const clean = witnessHex.trim().toLowerCase().replace(/\s+/g, "");
  if (!clean) throw new Error("Paste a witness first.");
  const hashes = witnessKeyHashes(clean);
  const match = hashes.find((h) => draft.requiredSigners.includes(h));
  if (!match) {
    throw new Error(
      `That witness was made by ${hashes[0]!.slice(0, 12)}…, who is not a required signer on this transaction.`,
    );
  }
  if (draft.witnesses.some((w) => w.keyHash === match)) {
    throw new Error("That operator has already signed this transaction.");
  }
  return { ...draft, witnesses: [...draft.witnesses, { keyHash: match, witness: clean }] };
}

/** Merge another copy of the same draft, keeping every distinct signature. */
export function mergeDrafts(a: AccrualDraft, b: AccrualDraft): AccrualDraft {
  if (a.txCbor !== b.txCbor) {
    throw new Error("These drafts are for different transactions and cannot be merged.");
  }
  const merged = [...a.witnesses];
  for (const w of b.witnesses) {
    if (!merged.some((m) => m.keyHash === w.keyHash) && a.requiredSigners.includes(w.keyHash)) {
      merged.push(w);
    }
  }
  return { ...a, witnesses: merged };
}

// --- portable encoding ---------------------------------------------------

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode a draft for a link or a copy-paste handoff. */
export function encodeDraft(draft: AccrualDraft): string {
  return toBase64Url(JSON.stringify({ v: DRAFT_VERSION, draft }));
}

/** Decode a draft, validating the envelope before trusting any of it. */
export function decodeDraft(encoded: string): AccrualDraft {
  const clean = encoded.trim().replace(/\s+/g, "");
  if (!clean) throw new Error("Paste a draft first.");
  if (clean.length > MAX_DRAFT_CHARS) throw new Error("That draft is implausibly large.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(clean));
  } catch {
    throw new Error("That isn't a valid accrual draft.");
  }
  const env = parsed as { v?: number; draft?: Partial<AccrualDraft> };
  if (env?.v !== DRAFT_VERSION || !env.draft) {
    throw new Error("That draft was made by an incompatible version of the console.");
  }
  const d = env.draft;
  if (
    typeof d.txCbor !== "string" ||
    !/^[0-9a-f]+$/i.test(d.txCbor) ||
    typeof d.assetId !== "string" ||
    !Array.isArray(d.requiredSigners) ||
    !Array.isArray(d.witnesses)
  ) {
    throw new Error("That draft is missing required fields.");
  }
  const required = d.requiredSigners.filter(
    (s): s is string => typeof s === "string" && /^[0-9a-f]{56}$/.test(s),
  );
  if (required.length === 0) throw new Error("That draft names no valid signers.");

  const witnesses = (d.witnesses as AccrualDraft["witnesses"]).filter(
    (w) =>
      w &&
      typeof w.keyHash === "string" &&
      typeof w.witness === "string" &&
      /^[0-9a-f]+$/i.test(w.witness) &&
      required.includes(w.keyHash),
  );

  return { ...(d as AccrualDraft), requiredSigners: required, witnesses };
}

/** A link a co-signer can open straight into the operator console. */
export function draftShareLink(draft: AccrualDraft): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/operators#accrual=${encodeDraft(draft)}`;
}

/** Read a draft out of the current URL fragment, if one is there. */
export function readDraftFromLocation(): AccrualDraft | null {
  if (typeof window === "undefined") return null;
  const match = /(?:^#|&)accrual=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!match) return null;
  try {
    return decodeDraft(match[1]!);
  } catch {
    return null;
  }
}
