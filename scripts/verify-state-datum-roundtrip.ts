#!/usr/bin/env bun
/**
 * AUDIT.md O-02 regression test.
 *
 * `encodeStateDatum()` (src/lib/yield-chain-decode.ts) is the single writer
 * for the yield vault's 11-field State datum, used by every builder that
 * used to hand-roll the same `Constr(1, [...])` independently
 * (vault-bootstrap.ts, vault-accrual.ts, yield-position.ts). A field written
 * in the wrong position or CBOR type produces a UTxO the validator can never
 * spend, with no build-time error to warn anyone.
 *
 * This encodes a representative State with the production encoder, decodes
 * it back with the production decoder (`decodeState`, the same function that
 * reads on-chain inline datums), and diffs every field. Run:
 *
 *   bun run scripts/verify-state-datum-roundtrip.ts
 */
import { Data, Constr } from "@lucid-evolution/lucid";
import { encodeStateDatum, decodeState, type VaultStateDatum } from "../src/lib/yield-chain-decode";
import { decodePlutusDatum } from "../src/lib/plutus-cbor";

const samples: VaultStateDatum[] = [
  {
    totalShares: "123456789",
    totalAssets: "987654321",
    epoch: 7,
    operators: [
      "aabbccddeeff00112233445566778899aabbccddeeff001122334455",
      "112233445566778899aabbccddeeff00112233445566778899aabbcc",
    ],
    threshold: 2,
    paused: true,
    feeBps: 250,
    treasury: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    treasuryShares: "42",
    lastFeeTime: "1700000000000",
    receiptPolicy: "ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d",
  },
  // Bootstrap-shaped: zeroed accounting, single operator, unpaused.
  {
    totalShares: "0",
    totalAssets: "0",
    epoch: 0,
    operators: ["00112233445566778899aabbccddeeff00112233445566778899aabb"],
    threshold: 1,
    paused: false,
    feeBps: 0,
    treasury: "",
    treasuryShares: "0",
    lastFeeTime: "1699999999999",
    receiptPolicy: "ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d",
  },
];

let failed = false;

for (const [i, sample] of samples.entries()) {
  const hex = encodeStateDatum({ Data, Constr }, sample);
  const decoded = decodeState(decodePlutusDatum(hex));

  if (!decoded) {
    console.error(`FAIL[${i}]: decodeState() rejected the encoder's own output.`);
    failed = true;
    continue;
  }

  const mismatches = (Object.keys(sample) as Array<keyof VaultStateDatum>).filter((key) => {
    const a = sample[key];
    const b = decoded[key];
    return Array.isArray(a) ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
  });

  if (mismatches.length > 0) {
    console.error(`FAIL[${i}]: round-trip mismatch on field(s): ${mismatches.join(", ")}`);
    console.error("  encoded from:", sample);
    console.error("  decoded to:  ", decoded);
    failed = true;
    continue;
  }

  console.log(`OK[${i}]: encodeStateDatum() <-> decodeState() round-trips field-for-field.`);
}

if (failed) {
  console.error("\nencodeStateDatum() and decodeState() have drifted apart — fix before shipping.");
  process.exit(1);
}
