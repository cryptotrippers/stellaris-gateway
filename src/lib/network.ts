/**
 * Central network configuration.
 *
 * Reads `VITE_BLOCKFROST_NETWORK` and the matching `VITE_BLOCKFROST_PROJECT_ID`.
 * Every transaction-signing action MUST call `assertWalletMatchesAppNetwork()`
 * before building/submitting a tx.
 *
 * This project is Preprod-only, and that is enforced HERE rather than trusted
 * to the environment: a request for mainnet never resolves to mainnet config.
 * Previously a `VITE_BLOCKFROST_NETWORK=mainnet` env flipped the Blockfrost URL,
 * the Lucid network and the wallet guard to mainnet and only logged an error.
 */

export type AppNetwork = "mainnet" | "preprod";

/**
 * Hard guard — do not weaken (CLAUDE.md, NETWORK.md). While true, the app can
 * only ever resolve to Preprod; lifting it is a reviewed mainnet-launch change.
 */
export const MAINNET_NOT_ALLOWED = true;

function requestedNetwork(): string {
  return (import.meta.env.VITE_BLOCKFROST_NETWORK ?? "preprod").toString().trim().toLowerCase();
}

/** True when the environment ASKED for mainnet. The app still runs on Preprod. */
export const IS_UNEXPECTED_MAINNET = MAINNET_NOT_ALLOWED && requestedNetwork() === "mainnet";

function readNetwork(): AppNetwork {
  if (requestedNetwork() === "mainnet" && !MAINNET_NOT_ALLOWED) return "mainnet";
  return "preprod";
}

export const APP_NETWORK: AppNetwork = readNetwork();

if (IS_UNEXPECTED_MAINNET) {
  console.error(
    '[network] CONFIGURATION ERROR: VITE_BLOCKFROST_NETWORK="mainnet" was refused — this deployment is Preprod-only. ' +
      "The app stays on Preprod (Blockfrost URL, Lucid network and wallet guard) and the network badge is red. " +
      'Set VITE_BLOCKFROST_NETWORK="preprod".',
  );
}

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
