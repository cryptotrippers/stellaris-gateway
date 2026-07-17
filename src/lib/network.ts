/**
 * Central network configuration.
 *
 * Reads `VITE_BLOCKFROST_NETWORK` (preprod | mainnet) and the matching
 * `VITE_BLOCKFROST_PROJECT_ID`. Every transaction-signing action MUST call
 * `assertWalletMatchesAppNetwork()` before building/submitting a tx.
 */

export type AppNetwork = "mainnet" | "preprod";

function readNetwork(): AppNetwork {
  const raw = (import.meta.env.VITE_BLOCKFROST_NETWORK ?? "preprod").toString().toLowerCase();
  if (raw === "mainnet") return "mainnet";
  return "preprod";
}

export const APP_NETWORK: AppNetwork = readNetwork();

export const BLOCKFROST_PROJECT_ID: string | undefined =
  import.meta.env.VITE_BLOCKFROST_PROJECT_ID as string | undefined;

export const BLOCKFROST_URL =
  APP_NETWORK === "mainnet"
    ? "https://cardano-mainnet.blockfrost.io/api/v0"
    : "https://cardano-preprod.blockfrost.io/api/v0";

/** CIP-30 networkId: 1 = mainnet, 0 = testnet (preprod/preview). */
export const EXPECTED_WALLET_NETWORK_ID: 0 | 1 = APP_NETWORK === "mainnet" ? 1 : 0;

export const LUCID_NETWORK: "Mainnet" | "Preprod" =
  APP_NETWORK === "mainnet" ? "Mainnet" : "Preprod";

export const NETWORK_LABEL = APP_NETWORK === "mainnet" ? "MAINNET" : "TESTNET";

export function networkNameFromId(id: 0 | 1 | null | undefined): string {
  if (id === 1) return "Mainnet";
  if (id === 0) return "Testnet";
  return "Unknown";
}

/**
 * Guard called before every transaction-signing action. Returns `{ ok: true }`
 * when the connected wallet is on the same network as the app, otherwise a
 * user-facing reason.
 */
export function assertWalletMatchesAppNetwork(walletNetworkId: 0 | 1 | null): { ok: true } | { ok: false; reason: string } {
  if (walletNetworkId === null || walletNetworkId === undefined) {
    return { ok: false, reason: "Connect a Cardano wallet first." };
  }
  if (walletNetworkId !== EXPECTED_WALLET_NETWORK_ID) {
    const appName = APP_NETWORK === "mainnet" ? "Mainnet" : "Preprod testnet";
    const walletName = networkNameFromId(walletNetworkId);
    return {
      ok: false,
      reason: `Network mismatch: this app is pointed at ${appName}, but your wallet is on ${walletName}. Switch your wallet's network to ${appName} and reconnect.`,
    };
  }
  return { ok: true };
}
