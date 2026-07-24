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

/**
 * Resolve the list of payment addresses associated with a bech32 stake
 * address. Used by the "view by address" read-only mode so viewers can paste
 * a `stake1…` / `stake_test1…` address and still see their vault UTxOs.
 */
export const getAddressesForStakeAddress = createServerFn({ method: "GET" })
  .inputValidator((data: { stakeAddress: string }) => {
    const stakeAddress = String(data?.stakeAddress ?? "").trim();
    if (!/^stake(_test)?1[0-9a-z]{20,}$/i.test(stakeAddress)) {
      throw new Error("Invalid stake address (must start with stake1 / stake_test1)");
    }
    return { stakeAddress };
  })
  .handler(async ({ data }): Promise<{ addresses: string[] }> => {
    // Blockfrost paginates 100 at a time; a single page is more than enough for
    // consumer-scale accounts, and the UI has an "add more" path if needed later.
    const rows = await bf<Array<{ address: string }>>(
      `/accounts/${data.stakeAddress}/addresses?count=100`,
    );
    return { addresses: rows.map(r => r.address) };
  });

export interface TxConfirmationResult {
  state: "pending" | "confirmed" | "not_found" | "error";
  confirmations: number;
  block: number | null;
  blockTime: number | null;
  detail?: string;
}

/**
 * Check whether a tx hash has landed in a block on Preprod. Returns
 * `pending` while the mempool still holds it (Blockfrost 404s until
 * inclusion), `confirmed` once the tx has any depth, and includes the
 * current tip-based confirmation count so the UI can show "N confirmations".
 */
export const getTxConfirmation = createServerFn({ method: "GET" })
  .inputValidator((data: { txHash: string }) => {
    const txHash = String(data?.txHash ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txHash)) throw new Error("Invalid tx hash");
    return { txHash };
  })
  .handler(async ({ data }): Promise<TxConfirmationResult> => {
    const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
    if (!key) return { state: "error", confirmations: 0, block: null, blockTime: null, detail: "Blockfrost not configured" };
    try {
      const res = await fetch(`${BASE}/txs/${data.txHash}`, { headers: { project_id: key } });
      if (res.status === 404) {
        return { state: "pending", confirmations: 0, block: null, blockTime: null };
      }
      if (!res.ok) {
        return { state: "error", confirmations: 0, block: null, blockTime: null, detail: `Blockfrost ${res.status}` };
      }
      const tx = (await res.json()) as { block_height: number; block_time: number };
      const tip = await bf<{ height: number }>("/blocks/latest").catch(() => null);
      const confirmations = tip ? Math.max(0, tip.height - tx.block_height + 1) : 1;
      return {
        state: "confirmed",
        confirmations,
        block: tx.block_height,
        blockTime: tx.block_time * 1000,
      };
    } catch (e) {
      return { state: "error", confirmations: 0, block: null, blockTime: null, detail: (e as Error).message };
    }
  });
