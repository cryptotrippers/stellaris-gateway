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

export type BlockfrostHealthStatus = "ok" | "missing" | "wrong_network" | "invalid" | "unreachable";

export interface BlockfrostHealth {
  status: BlockfrostHealthStatus;
  expectedNetwork: "preprod";
  detectedNetwork: "mainnet" | "preprod" | "preview" | "unknown" | null;
  detail: string;
  checkedAt: number;
}

/**
 * Return the Blockfrost project ID + base URL to the browser so Lucid can
 * talk to Blockfrost directly for wallet UTxO queries and tx submission.
 * The project ID is not a signing key — it identifies a Blockfrost account
 * for rate-limiting. It's exposed to the browser deliberately here; rotate
 * via the `BLOCKFROST_PREPROD_PROJECT_ID` secret if it leaks or is abused.
 */
export const getBlockfrostClientConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ projectId: string; url: string; network: "preprod" }> => {
    const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
    if (!key) throw new Error("BLOCKFROST_PREPROD_PROJECT_ID not configured on the server.");
    return { projectId: key, url: BASE, network: "preprod" };
  },
);

/** Startup / on-demand validation of the BLOCKFROST_PREPROD_PROJECT_ID secret. */
export const getBlockfrostHealth = createServerFn({ method: "GET" }).handler(async (): Promise<BlockfrostHealth> => {
  const now = Date.now();
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  if (!key) {
    return {
      status: "missing",
      expectedNetwork: "preprod",
      detectedNetwork: null,
      detail: "BLOCKFROST_PREPROD_PROJECT_ID is not set. Add a Preprod project ID from blockfrost.io.",
      checkedAt: now,
    };
  }
  const prefix = key.slice(0, 7).toLowerCase();
  const prefixNetwork: BlockfrostHealth["detectedNetwork"] =
    prefix.startsWith("preprod") ? "preprod"
    : prefix.startsWith("preview") ? "preview"
    : prefix.startsWith("mainnet") ? "mainnet"
    : "unknown";
  if (prefixNetwork !== "preprod" && prefixNetwork !== "unknown") {
    return {
      status: "wrong_network",
      expectedNetwork: "preprod",
      detectedNetwork: prefixNetwork,
      detail: `Key prefix indicates ${prefixNetwork}. Create a Cardano preprod project at blockfrost.io and update the secret.`,
      checkedAt: now,
    };
  }
  // Live probe against Preprod
  try {
    const res = await fetch(`${BASE}/network`, { headers: { project_id: key } });
    if (res.status === 403) {
      const body = await res.text().catch(() => "");
      const netMismatch = /Network token mismatch/i.test(body);
      return {
        status: netMismatch ? "wrong_network" : "invalid",
        expectedNetwork: "preprod",
        detectedNetwork: netMismatch ? "unknown" : null,
        detail: netMismatch
          ? "Blockfrost rejected the key as belonging to a different network. Use a Cardano preprod project ID."
          : "Blockfrost rejected the key (403). Regenerate it in your Blockfrost dashboard.",
        checkedAt: now,
      };
    }
    if (!res.ok) {
      return {
        status: "unreachable",
        expectedNetwork: "preprod",
        detectedNetwork: null,
        detail: `Blockfrost /network returned ${res.status}. Try again shortly.`,
        checkedAt: now,
      };
    }
    return {
      status: "ok",
      expectedNetwork: "preprod",
      detectedNetwork: "preprod",
      detail: "Connected to Cardano Preprod.",
      checkedAt: now,
    };
  } catch (e) {
    return {
      status: "unreachable",
      expectedNetwork: "preprod",
      detectedNetwork: null,
      detail: `Network error contacting Blockfrost: ${(e as Error).message}`,
      checkedAt: now,
    };
  }
});


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
