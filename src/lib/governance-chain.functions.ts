/**
 * Chain-derived timestamps for governance.
 *
 * Execution times shown next to a proposal come from the block that carried
 * the transaction, not from when a row happened to be written to the
 * database.
 */

import { createServerFn } from "@tanstack/react-start";

export interface TxChainTime {
  txHash: string;
  found: boolean;
  blockTime: number | null;
  blockHeight: number | null;
  epoch: number | null;
  slot: number | null;
}

const HASH_RE = /^[0-9a-f]{64}$/;

export const getTxChainTimes = createServerFn({ method: "GET" })
  .inputValidator((data: { txHashes: string[] }) => {
    const list = Array.from(
      new Set((data?.txHashes ?? []).map((h) => String(h).trim().toLowerCase())),
    ).filter((h) => HASH_RE.test(h));
    return { txHashes: list.slice(0, 25) };
  })
  .handler(async ({ data }): Promise<TxChainTime[]> => {
    if (data.txHashes.length === 0) return [];
    const { bfGet } = await import("./blockfrost-fetch.server");

    return Promise.all(
      data.txHashes.map(async (txHash): Promise<TxChainTime> => {
        try {
          const tx = await bfGet<{
            block_time: number;
            block_height: number;
            slot: number;
            block: string;
          }>(`/txs/${txHash}`);
          if (!tx) {
            return { txHash, found: false, blockTime: null, blockHeight: null, epoch: null, slot: null };
          }
          const block = await bfGet<{ epoch: number | null }>(`/blocks/${tx.block}`).catch(() => null);
          return {
            txHash,
            found: true,
            blockTime: tx.block_time * 1000,
            blockHeight: tx.block_height,
            epoch: block?.epoch ?? null,
            slot: tx.slot,
          };
        } catch {
          return { txHash, found: false, blockTime: null, blockHeight: null, epoch: null, slot: null };
        }
      }),
    );
  });
