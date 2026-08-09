/**
 * Server-side reads backing the reference-script helpers in `ref-scripts.ts`.
 *
 * Module scope holds only imports, types and server-function declarations —
 * the Blockfrost fetch helper is loaded lazily inside each handler so the
 * project id never enters the client graph.
 */

import { createServerFn } from "@tanstack/react-start";

const TX_HASH_RE = /^[0-9a-f]{64}$/;

export interface RefScriptUtxoRead {
  txHash: string;
  outputIndex: number;
  address: string;
  /** Asset unit -> quantity, as returned by Blockfrost (lovelace included). */
  assets: Record<string, string>;
  /** Script hash of the attached reference script, when present. */
  scriptHash: string | null;
  datumHash: string | null;
  inlineDatum: string | null;
}

/**
 * Live `coinsPerUTxOByte` from the current epoch's protocol parameters.
 * Never hardcode this — it is a governable protocol parameter.
 */
export const getCoinsPerUtxoByte = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ coinsPerUtxoByte: string; epoch: number | null }> => {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const params = await bfGet<{
      epoch?: number;
      coins_per_utxo_size?: string | null;
      coins_per_utxo_word?: string | null;
    }>("/epochs/latest/parameters");
    if (!params) throw new Error("Blockfrost returned no protocol parameters for the latest epoch.");
    const raw = params.coins_per_utxo_size ?? params.coins_per_utxo_word;
    if (!raw) throw new Error("Protocol parameters did not include coinsPerUTxOByte.");
    return { coinsPerUtxoByte: String(raw), epoch: params.epoch ?? null };
  },
);

/** Fetch a single UTxO by (txHash, outputIndex). Returns null when absent. */
export const getUtxoByRef = createServerFn({ method: "GET" })
  .inputValidator((data: { txHash: string; outputIndex: number }) => {
    const txHash = String(data?.txHash ?? "").trim().toLowerCase();
    if (!TX_HASH_RE.test(txHash)) throw new Error("Invalid tx hash");
    const outputIndex = Number(data?.outputIndex);
    if (!Number.isInteger(outputIndex) || outputIndex < 0) throw new Error("Invalid output index");
    return { txHash, outputIndex };
  })
  .handler(async ({ data }): Promise<RefScriptUtxoRead | null> => {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const utxos = await bfGet<{
      outputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
      }>;
    }>(`/txs/${data.txHash}/utxos`);
    if (!utxos) return null;
    const out = utxos.outputs.find(o => o.output_index === data.outputIndex);
    if (!out) return null;
    const assets: Record<string, string> = {};
    for (const a of out.amount) assets[a.unit] = a.quantity;
    return {
      txHash: data.txHash,
      outputIndex: out.output_index,
      address: out.address,
      assets,
      scriptHash: out.reference_script_hash,
      datumHash: out.data_hash,
      inlineDatum: out.inline_datum,
    };
  });
