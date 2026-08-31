/**
 * Plutus script CBOR comparison helpers.
 *
 * A compiled validator can be presented in two equivalent forms:
 *
 *   - double-encoded ("flat" script bytes wrapped in a CBOR bytestring, then
 *     wrapped again) — this is what `plutus.json` and `applyParamsToScript()`
 *     return, and what Lucid hashes;
 *   - single-encoded — what Blockfrost's `/scripts/{hash}/cbor` serves.
 *
 * Comparing the two strings directly reports a MISMATCH for a script that is
 * byte-identical on chain, which is exactly the false alarm this module exists
 * to prevent. Note the unwrap is deliberately applied at most ONE level: the
 * inner payload of a double-encoded script is frequently itself a well-formed
 * CBOR bytestring header, so unwrapping greedily walks past the real script.
 */

/** Strip exactly one CBOR bytestring header when it frames the whole payload. */
export function unwrapOnce(hex) {
  if (typeof hex !== "string" || hex.length < 4) return null;
  const major = parseInt(hex.slice(0, 2), 16);
  // Major type 2 (byte string) with a 1-, 2- or 4-byte explicit length.
  const lenBytes = { 0x58: 1, 0x59: 2, 0x5a: 4 }[major];
  if (!lenBytes) return null;
  const headerChars = 2 + lenBytes * 2;
  const declared = parseInt(hex.slice(2, headerChars), 16);
  const body = hex.slice(headerChars);
  if (Number.isNaN(declared) || body.length !== declared * 2) return null;
  return body;
}

/** True when two script CBOR strings denote the same on-chain script. */
export function sameScriptCbor(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || unwrapOnce(x) === y || x === unwrapOnce(y);
}

/**
 * Classify a yield-vault inline datum by its Plutus constructor tag.
 * Constr 0 (`d8799f`/`d87982`…) is a depositor Position, Constr 1 (`d87a…`)
 * is the vault State. Only State UTxOs are subject to the sole-state rule.
 */
export function datumKind(inlineDatumHex) {
  const hex = (inlineDatumHex ?? "").toLowerCase();
  if (hex.startsWith("d879")) return "position";
  if (hex.startsWith("d87a")) return "state";
  return "unknown";
}
