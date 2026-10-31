/**
 * Stellaris Shield G1 (stopgap): the protocol treasury as an M-of-N native
 * multisig script. Spending needs signatures from at least M distinct keys of
 * the N listed; there is no other branch (no timelock, no backup key, no
 * admin). The Aiken treasury vault (proposal, delay, limits) replaces it later.
 *
 * Native scripts are the ledger's own multisig: no Plutus, no parameters to
 * get wrong, verified by every node. Shared by scripts/shield/* and
 * tests/contracts/shield-multisig.test.ts.
 */
import {
  getAddressDetails,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Network,
  type Script,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";

const HEX28 = /^[0-9a-f]{56}$/;

export interface MultisigSpec {
  /** Payment key hashes of the signers (28-byte hex), each held by a different person. */
  signers: string[];
  /** Minimum distinct signatures. */
  threshold: number;
}

/** Every reason a signer set would be unsafe or invalid. Empty = fine. */
export function specProblems(s: MultisigSpec): string[] {
  const out: string[] = [];
  const keys = s.signers.map((k) => k.toLowerCase());
  if (keys.some((k) => !HEX28.test(k))) out.push("Every signer must be a 28-byte key hash (hex).");
  if (new Set(keys).size !== keys.length) out.push("A signer is listed twice.");
  if (!Number.isInteger(s.threshold) || s.threshold < 2)
    out.push("The threshold must be at least 2: one key alone must never move treasury funds.");
  if (s.threshold > keys.length) out.push("The threshold is larger than the number of signers.");
  if (s.threshold * 2 <= keys.length)
    out.push("The threshold must be a majority of the signers (e.g. 3 of 5).");
  return out;
}

/** The native script: at least `threshold` of the listed key signatures. */
export function treasuryScript(s: MultisigSpec): Script {
  const p = specProblems(s);
  if (p.length) throw new Error(p.join(" "));
  return scriptFromNative({
    type: "atLeast",
    required: s.threshold,
    scripts: s.signers.map((k) => ({ type: "sig" as const, keyHash: k.toLowerCase() })),
  });
}

export function treasuryAddress(network: Network, s: MultisigSpec) {
  const script = treasuryScript(s);
  return {
    script,
    hash: validatorToScriptHash(script),
    address: validatorToAddress(network, script),
  };
}

/** Key hash of a bech32 key address (for building a spec from addresses). */
export function keyHashOfAddress(bech32: string): string {
  const c = getAddressDetails(bech32).paymentCredential;
  if (!c || c.type !== "Key") throw new Error(`${bech32} is not a key address.`);
  return c.hash;
}

export interface Payment {
  address: string;
  assets: Record<string, bigint>;
}

/**
 * Spend from the treasury: pay `payments`, return the rest to the treasury
 * (Lucid's change goes to the selected wallet, so the treasury's own change is
 * paid back explicitly). `signers` are the key hashes that will sign; the
 * caller adds their witnesses. The fee is paid by the selected (operator) wallet.
 */
export async function buildTreasurySpend(
  lucid: LucidEvolution,
  t: { script: Script; address: string },
  inputs: UTxO[],
  payments: Payment[],
  signers: string[],
): Promise<TxSignBuilder> {
  if (inputs.length === 0) throw new Error("The treasury has nothing to spend.");
  if (inputs.some((u) => u.address !== t.address))
    throw new Error("An input is not the treasury's.");
  const held: Record<string, bigint> = {};
  for (const u of inputs)
    for (const [k, v] of Object.entries(u.assets)) held[k] = (held[k] ?? 0n) + v;
  const rest = { ...held };
  for (const p of payments)
    for (const [k, v] of Object.entries(p.assets)) {
      rest[k] = (rest[k] ?? 0n) - v;
      if (rest[k]! < 0n) throw new Error(`The treasury does not hold enough ${k}.`);
    }
  let b = lucid.newTx().collectFrom(inputs).attach.SpendingValidator(t.script);
  for (const p of payments) b = b.pay.ToAddress(p.address, p.assets);
  const change = Object.fromEntries(Object.entries(rest).filter(([, v]) => v > 0n));
  if (Object.keys(change).length) {
    if ((change.lovelace ?? 0n) < 2_000_000n)
      throw new Error(
        "Leave at least 2 ADA in the treasury with the remaining tokens, or spend all of it.",
      );
    b = b.pay.ToAddress(t.address, change);
  }
  for (const k of signers) b = b.addSignerKey(k);
  return b.complete();
}
