/**
 * Reference-script helpers.
 *
 * Reference scripts remove the need to embed validator CBOR in every spending
 * transaction: the script lives once in a UTxO on chain and later transactions
 * point at it. See `contracts/vault/REFSCRIPTS.md` for the operational rules.
 *
 * The home address is a hardcoded constant on purpose — an env var could point
 * a different environment at the wrong address and strand or burn reference
 * UTxOs.
 */

import { supabase } from "@/integrations/supabase/client";
import { getCoinsPerUtxoByte, getUtxoByRef, type RefScriptUtxoRead } from "./ref-scripts.functions";

/** Dedicated address that holds every published reference-script UTxO. */
export const REF_SCRIPT_HOME_ADDRESS = "<PASTE THE ADDRESS FROM STEP 0 HERE>";

export type ValidatorKey = "vault" | "yield_vault" | "receipt";

/** Constant overhead (in bytes) the ledger adds to every UTxO entry. */
const UTXO_ENTRY_OVERHEAD_BYTES = 160n;
/** Extra headroom over the theoretical minimum, so rounding never blocks a tx. */
const SAFETY_MARGIN_PCT = 10n;

function isPlaceholderHome(): boolean {
  return REF_SCRIPT_HOME_ADDRESS.startsWith("<");
}

function assertHomeAddress(): void {
  if (isPlaceholderHome()) {
    throw new Error(
      "REF_SCRIPT_HOME_ADDRESS is still the placeholder. Complete Step 0 and paste the dedicated reference-script address into src/lib/ref-scripts.ts.",
    );
  }
}

/**
 * Minimum lovelace that must sit in a reference-script output, computed from
 * the live `coinsPerUTxOByte` protocol parameter plus a 10% safety margin.
 */
export async function minAdaForRefScript(cborHex: string): Promise<bigint> {
  const hex = cborHex.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Applied script CBOR must be an even-length hex string.");
  }
  const { coinsPerUtxoByte } = await getCoinsPerUtxoByte();
  const perByte = BigInt(coinsPerUtxoByte);
  if (perByte <= 0n) throw new Error("Invalid coinsPerUTxOByte returned by Blockfrost.");

  // script bytes + address + value + CBOR framing for the output itself
  const scriptBytes = BigInt(hex.length / 2);
  const estimatedOutputSizeBytes = scriptBytes + 80n;

  const base = (UTXO_ENTRY_OVERHEAD_BYTES + estimatedOutputSizeBytes) * perByte;
  return base + (base * SAFETY_MARGIN_PCT) / 100n;
}

/**
 * Build (but do NOT submit) a transaction that publishes `appliedCbor` as a
 * reference script at the home address, funded with the computed minimum.
 * No datum is attached: reference-script UTxOs are pure carriers.
 */
export async function buildPublishReferenceScriptTx(
  lucid: {
    newTx: () => {
      pay: {
        ToAddressWithData: (
          address: string,
          datum: undefined,
          assets: { lovelace: bigint },
          scriptRef: { type: "PlutusV3"; script: string },
        ) => { complete: () => Promise<unknown> };
      };
    };
  },
  appliedCbor: string,
) {
  assertHomeAddress();
  const lovelace = await minAdaForRefScript(appliedCbor);
  const completed = await lucid
    .newTx()
    .pay.ToAddressWithData(
      REF_SCRIPT_HOME_ADDRESS,
      undefined,
      { lovelace },
      { type: "PlutusV3", script: appliedCbor },
    )
    .complete();
  return { tx: completed, lovelace, address: REF_SCRIPT_HOME_ADDRESS };
}

interface RefPointer {
  txHash: string;
  outputIndex: number;
}

function readPointer(raw: unknown, key: ValidatorKey): RefPointer | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = (raw as Record<string, unknown>)[key];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const txHash = String(e["txHash"] ?? e["tx_hash"] ?? "").trim().toLowerCase();
  const outputIndex = Number(e["outputIndex"] ?? e["output_index"] ?? NaN);
  if (!/^[0-9a-f]{64}$/.test(txHash) || !Number.isInteger(outputIndex) || outputIndex < 0) return null;
  return { txHash, outputIndex };
}

/**
 * Resolve the published reference UTxO for one validator of one asset vault.
 * Returns `null` when nothing is published for that key — callers then fall
 * back to the old embedded-script path.
 */
export async function getRefUtxoIfPublished(
  assetId: string,
  vaultVersion: number,
  validatorKey: ValidatorKey,
): Promise<RefScriptUtxoRead | null> {
  const { data, error } = await supabase
    .from("asset_vaults")
    .select("ref_script_utxos")
    .eq("asset_id", assetId)
    .eq("vault_version", vaultVersion)
    .maybeSingle();
  if (error) throw new Error(`Could not read reference-script registry: ${error.message}`);
  const pointer = readPointer(data?.ref_script_utxos, validatorKey);
  if (!pointer) return null;

  const utxo = await getUtxoByRef({ data: pointer });
  if (!utxo) return null;
  if (!isPlaceholderHome() && utxo.address !== REF_SCRIPT_HOME_ADDRESS) {
    throw new Error(
      `Reference UTxO ${pointer.txHash}#${pointer.outputIndex} is not at the reference-script home address. Refusing to use it.`,
    );
  }
  return utxo;
}

export type { RefScriptUtxoRead };
