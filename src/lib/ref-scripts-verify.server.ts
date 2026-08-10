/**
 * Server-only verification for published reference scripts.
 *
 * Never trusts the client's claim about what was published: the expected
 * script identity is re-established here, then the transaction is read back
 * from Blockfrost and compared byte-for-byte (or hash-for-hash when the
 * applied CBOR cannot be derived in this runtime).
 */

import { REF_SCRIPT_HOME_ADDRESS, isPlaceholderHome, type ValidatorKey } from "./ref-scripts.shared";
import { YIELD_VAULT_VERSION } from "./yield-vault";
import { VAULT_VERSION } from "./vault-params";
import { readStateDatum } from "./yield-chain-decode";
import blueprintSource from "../../contracts/vault/plutus.json?raw";

const blueprint = JSON.parse(blueprintSource) as {
  validators?: Array<{ title?: string; compiledCode?: string }>;
};

const TITLES: Record<ValidatorKey, string> = {
  vault: "vault.vault.spend",
  yield_vault: "yield_vault.yield_vault.spend",
  receipt: "receipt.receipt.mint",
};

function unappliedCbor(key: ValidatorKey): string {
  const found = blueprint.validators?.find((v) => v.title === TITLES[key]);
  if (!found?.compiledCode) {
    throw new Error(`The compiled blueprint has no "${TITLES[key]}" validator.`);
  }
  return found.compiledCode;
}

function textToHex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface LucidLike {
  applyParamsToScript: (cbor: string, params: unknown[]) => string;
  validatorToScriptHash: (v: { type: "PlutusV3"; script: string }) => string;
}

/**
 * Derive the applied script for one validator of one asset.
 *
 * Parameter application is WASM (`@lucid-evolution/uplc`) and is not
 * guaranteed to run in the edge server runtime, so a failure here is not
 * fatal — the caller falls back to authoritative on-chain/registry hashes.
 */
async function deriveApplied(
  key: ValidatorKey,
  assetId: string,
): Promise<{ cbor: string; hash: string } | null> {
  try {
    const mod = (await import("@lucid-evolution/lucid")) as unknown as LucidLike;
    if (typeof mod.applyParamsToScript !== "function") return null;
    const assetNameHex = textToHex(assetId);

    if (key === "vault") {
      const cbor = mod.applyParamsToScript(unappliedCbor("vault"), [VAULT_VERSION, assetNameHex]);
      return { cbor, hash: mod.validatorToScriptHash({ type: "PlutusV3", script: cbor }) };
    }

    const yieldCbor = mod.applyParamsToScript(unappliedCbor("yield_vault"), [
      YIELD_VAULT_VERSION,
      assetNameHex,
    ]);
    const yieldHash = mod.validatorToScriptHash({ type: "PlutusV3", script: yieldCbor });
    if (key === "yield_vault") return { cbor: yieldCbor, hash: yieldHash };

    const receiptCbor = mod.applyParamsToScript(unappliedCbor("receipt"), [yieldHash, assetNameHex]);
    return {
      cbor: receiptCbor,
      hash: mod.validatorToScriptHash({ type: "PlutusV3", script: receiptCbor }),
    };
  } catch {
    return null;
  }
}

/**
 * Authoritative expected hash when parameter application is unavailable:
 * the registry hash recorded at bootstrap for the yield vault, and the
 * receipt policy the live vault datum is bound to.
 */
async function expectedHashFallback(
  key: ValidatorKey,
  vault: { script_hash: string; script_address: string },
): Promise<string> {
  if (key === "yield_vault") return vault.script_hash.toLowerCase();

  if (key === "receipt") {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const utxos =
      (await bfGet<Array<{ inline_datum: string | null }>>(
        `/addresses/${vault.script_address}/utxos?count=100`,
      )) ?? [];
    for (const u of utxos) {
      const state = readStateDatum(u.inline_datum);
      if (state?.receiptPolicy) return state.receiptPolicy.toLowerCase();
    }
    throw new Error(
      "The receipt policy cannot be verified: this vault has no readable State UTxO on chain yet. Bootstrap it before publishing its receipt reference script.",
    );
  }

  throw new Error(
    "The Stage 3 vault script cannot be re-derived in the server runtime, so its reference script cannot be verified. Publish the yield_vault and receipt reference scripts first.",
  );
}

export interface RefScriptVerification {
  txHash: string;
  outputIndex: 0;
  scriptHash: string;
  /** How the expected identity was established. */
  verifiedBy: "applied-cbor" | "registry-hash";
}

/**
 * Confirm that output 0 of `txHash` sits at the reference-script home address
 * and carries a PlutusV3 reference script matching this asset's validator.
 * Throws with a plain-language reason on any mismatch.
 */
export async function verifyPublishedReferenceScript(input: {
  assetId: string;
  validatorKey: ValidatorKey;
  txHash: string;
  vault: { script_hash: string; script_address: string };
}): Promise<RefScriptVerification> {
  if (isPlaceholderHome()) {
    throw new Error(
      "The reference-script home address is still the Step 0 placeholder — no publication can be verified until it is set.",
    );
  }

  const { bfGet } = await import("./blockfrost-fetch.server");

  const tx = await bfGet<{
    outputs: Array<{
      address: string;
      output_index: number;
      reference_script_hash: string | null;
    }>;
  }>(`/txs/${input.txHash}/utxos`);
  if (!tx) throw new Error(`Transaction ${input.txHash} is not visible on chain yet.`);

  const out = tx.outputs.find((o) => o.output_index === 0);
  if (!out) throw new Error("That transaction has no output at index 0.");
  if (out.address !== REF_SCRIPT_HOME_ADDRESS) {
    throw new Error(
      "Output 0 of that transaction is not at the dedicated reference-script address. Refusing to record it.",
    );
  }
  const onChainHash = (out.reference_script_hash ?? "").toLowerCase();
  if (!onChainHash) {
    throw new Error("Output 0 carries no reference script.");
  }

  const meta = await bfGet<{ type?: string }>(`/scripts/${onChainHash}`);
  if (!meta) throw new Error("Blockfrost does not know that script hash yet.");
  if ((meta.type ?? "").toLowerCase() !== "plutusv3") {
    throw new Error(`The published script is ${meta.type ?? "of unknown type"}, not PlutusV3.`);
  }

  const derived = await deriveApplied(input.validatorKey, input.assetId);

  if (derived) {
    if (derived.hash.toLowerCase() !== onChainHash) {
      throw new Error(
        `The published script hashes to ${onChainHash}, but this build derives ${derived.hash} for ${input.validatorKey} on ${input.assetId}.`,
      );
    }
    const cborRes = await bfGet<{ cbor?: string }>(`/scripts/${onChainHash}/cbor`);
    const onChainCbor = (cborRes?.cbor ?? "").toLowerCase();
    if (!onChainCbor) throw new Error("Could not read the published script's bytes from chain.");
    if (onChainCbor !== derived.cbor.toLowerCase()) {
      throw new Error(
        "The published script's bytes do not match the applied script this build derives. Refusing to record it.",
      );
    }
    return {
      txHash: input.txHash,
      outputIndex: 0,
      scriptHash: onChainHash,
      verifiedBy: "applied-cbor",
    };
  }

  const expected = await expectedHashFallback(input.validatorKey, input.vault);
  if (expected !== onChainHash) {
    throw new Error(
      `The published script hashes to ${onChainHash}, but the expected ${input.validatorKey} script for ${input.assetId} is ${expected}.`,
    );
  }
  return {
    txHash: input.txHash,
    outputIndex: 0,
    scriptHash: onChainHash,
    verifiedBy: "registry-hash",
  };
}
