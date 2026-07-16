import { createServerFn } from "@tanstack/react-start";

/**
 * Server-side proxy to Blockfrost Preprod for the RealFi testnet.
 * Uses the BLOCKFROST_PREPROD_PROJECT_ID server secret so it never ships to the browser.
 */

const BASE = "https://cardano-preprod.blockfrost.io/api/v0";

async function bf<T>(path: string): Promise<T> {
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) throw new Error("BLOCKFROST_PREPROD_PROJECT_ID not configured");
  const res = await fetch(`${BASE}${path}`, { headers: { project_id: key } });
  const body = await res.text();
  if (!res.ok) throw new Error(`Blockfrost ${res.status}: ${body || res.statusText}`);
  return JSON.parse(body) as T;
}

export interface PreprodTip {
  network: "preprod";
  epoch: number;
  slot: number;
  epochSlot: number;
  block: number;
  blockHash: string;
  blockTime: number;
  txCount: number;
  activeStakeAda: number | null;
  fetchedAt: number;
}

export const getPreprodTip = createServerFn({ method: "GET" }).handler(async (): Promise<PreprodTip> => {
  const [latestBlock, latestEpoch] = await Promise.all([
    bf<{ epoch: number; slot: number; epoch_slot: number; height: number; hash: string; time: number; tx_count: number }>("/blocks/latest"),
    bf<{ active_stake: string | null }>("/epochs/latest"),
  ]);
  return {
    network: "preprod",
    epoch: latestBlock.epoch,
    slot: latestBlock.slot,
    epochSlot: latestBlock.epoch_slot,
    block: latestBlock.height,
    blockHash: latestBlock.hash,
    blockTime: latestBlock.time * 1000,
    txCount: latestBlock.tx_count,
    activeStakeAda: latestEpoch.active_stake ? Number(latestEpoch.active_stake) / 1_000_000 : null,
    fetchedAt: Date.now(),
  };
});

export interface PreprodAddress {
  address: string;
  balanceAda: number;
  txCount: number;
  stakeAddress: string | null;
}

export const getPreprodAddress = createServerFn({ method: "GET" })
  .inputValidator((data: { address: string }) => {
    const address = String(data?.address ?? "").trim();
    if (!/^addr_test1[0-9a-z]{20,}$/i.test(address)) throw new Error("Invalid preprod address (must start with addr_test1)");
    return { address };
  })
  .handler(async ({ data }): Promise<PreprodAddress> => {
    const info = await bf<{ amount: Array<{ unit: string; quantity: string }>; tx_count?: number; stake_address: string | null }>(
      `/addresses/${data.address}`,
    );
    const lovelace = info.amount.find(a => a.unit === "lovelace")?.quantity ?? "0";
    return {
      address: data.address,
      balanceAda: Number(lovelace) / 1_000_000,
      txCount: info.tx_count ?? 0,
      stakeAddress: info.stake_address,
    };
  });
