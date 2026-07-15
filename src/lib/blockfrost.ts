import { useEffect, useState } from "react";

/**
 * Blockfrost browser client.
 *
 * Requires `VITE_BLOCKFROST_PROJECT_ID` in your environment (mainnet by default).
 * Override the network by setting `VITE_BLOCKFROST_NETWORK` to one of
 * `mainnet` | `preprod` | `preview`.
 *
 * NOTE: this key is embedded in the browser bundle by design (see the user's
 * chosen refresh model). Use a Blockfrost project scoped to public read
 * traffic and rely on Blockfrost's per-project rate limiting.
 */

const NETWORK = (import.meta.env.VITE_BLOCKFROST_NETWORK ?? "mainnet") as
  | "mainnet"
  | "preprod"
  | "preview";

const PROJECT_ID = import.meta.env.VITE_BLOCKFROST_PROJECT_ID as string | undefined;

const BASE_URLS: Record<typeof NETWORK, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

export const BLOCKFROST_CONFIGURED = Boolean(PROJECT_ID);
export const BLOCKFROST_NETWORK = NETWORK;

export class BlockfrostError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function bfGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  if (!PROJECT_ID) {
    throw new BlockfrostError(0, "VITE_BLOCKFROST_PROJECT_ID is not configured");
  }
  const res = await fetch(`${BASE_URLS[NETWORK]}${path}`, {
    headers: { project_id: PROJECT_ID },
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new BlockfrostError(res.status, `Blockfrost ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ---- Types (subset of Blockfrost responses) ------------------------------

export interface BfEpoch {
  epoch: number;
  start_time: number;
  end_time: number;
  first_block_time: number;
  last_block_time: number;
  block_count: number;
  tx_count: number;
  output: string;
  fees: string;
  active_stake: string | null;
}

export interface BfTip {
  time: number;
  height: number;
  hash: string;
  slot: number;
  epoch: number;
  epoch_slot: number;
  slot_leader: string;
  size: number;
  tx_count: number;
  fees: string;
  block_vrf: string;
}

export interface BfNetwork {
  supply: {
    max: string;
    total: string;
    circulating: string;
    locked: string;
    treasury: string;
    reserves: string;
  };
  stake: { live: string; active: string };
}

// ---- Live tip hook -------------------------------------------------------

export interface CardanoTip {
  epoch: number;
  slot: number;
  epochSlot: number;
  block: number;
  blockHash: string;
  blockTime: number;
  activeStakeAda: number | null;
}

export function useCardanoTip(intervalMs = 20_000) {
  const [tip, setTip] = useState<CardanoTip | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(BLOCKFROST_CONFIGURED);

  useEffect(() => {
    if (!BLOCKFROST_CONFIGURED) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();

    async function pull() {
      try {
        const [latestBlock, latestEpoch] = await Promise.all([
          bfGet<BfTip>("/blocks/latest", controller.signal),
          bfGet<BfEpoch>("/epochs/latest", controller.signal),
        ]);
        if (cancelled) return;
        setTip({
          epoch: latestBlock.epoch,
          slot: latestBlock.slot,
          epochSlot: latestBlock.epoch_slot,
          block: latestBlock.height,
          blockHash: latestBlock.hash,
          blockTime: latestBlock.time * 1000,
          activeStakeAda: latestEpoch.active_stake
            ? Number(latestEpoch.active_stake) / 1_000_000
            : null,
        });
        setError(null);
      } catch (e) {
        if (cancelled || (e as Error).name === "AbortError") return;
        setError(e as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    pull();
    const id = window.setInterval(pull, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return { tip, error, loading, configured: BLOCKFROST_CONFIGURED, network: NETWORK };
}
