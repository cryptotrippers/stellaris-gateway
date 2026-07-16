/**
 * CIP-45 WalletConnect integration for Cardano.
 *
 * Uses @walletconnect/sign-client v2 with the `cip34` namespace defined by
 * CIP-45. Users scan the pairing URI with any CIP-45 compatible mobile
 * Cardano wallet (Eternl mobile, Vespr, etc.) to establish a session.
 *
 * Required env: VITE_WALLETCONNECT_PROJECT_ID (obtain from
 * https://cloud.reown.com — free tier). Without it, pairing fails fast
 * with a clear error surfaced in the UI.
 */

import SignClient from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";

// CIP-34 chain IDs used by CIP-45.
//   testnet networkId 0 (preprod magic 1)  -> "cip34:0-1"
//   testnet networkId 0 (preview magic 2)  -> "cip34:0-2"
//   mainnet networkId 1 (magic 764824073)  -> "cip34:1-764824073"
export const CIP34_CHAINS = {
  preprod: "cip34:0-1",
  preview: "cip34:0-2",
  mainnet: "cip34:1-764824073",
} as const;

export type Cip34Chain = keyof typeof CIP34_CHAINS;

const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

const METADATA = {
  name: "Stellaris Gateway",
  description: "Institutional-grade RealFi gateway on Cardano.",
  url: typeof window === "undefined" ? "https://stellaris-gateway.lovable.app" : window.location.origin,
  icons: ["https://stellaris-gateway.lovable.app/favicon.ico"],
};

let clientPromise: Promise<SignClient> | null = null;

async function getClient(): Promise<SignClient> {
  if (!PROJECT_ID) {
    throw new Error(
      "WalletConnect is not configured. Set VITE_WALLETCONNECT_PROJECT_ID (get one at https://cloud.reown.com) and reload."
    );
  }
  if (!clientPromise) {
    clientPromise = SignClient.init({
      projectId: PROJECT_ID,
      metadata: METADATA,
    });
  }
  return clientPromise;
}

export interface WalletConnectAccount {
  chainId: string;         // e.g. cip34:0-1
  networkId: 0 | 1;        // 0 testnet, 1 mainnet
  stakeAddress: string;    // bech32 stake address from the CIP-45 account string
  topic: string;           // WC session topic — keep for later disconnect
}

export interface PairingHandle {
  /** wc:… URI to encode into a QR code. */
  uri: string;
  /** Resolves when the wallet approves (or rejects) the session. */
  approval: Promise<WalletConnectAccount>;
  /** Cancel the pending proposal. */
  cancel: () => Promise<void>;
}

export async function startPairing(chain: Cip34Chain = "preprod"): Promise<PairingHandle> {
  const client = await getClient();
  const chainId = CIP34_CHAINS[chain];

  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      cip34: {
        chains: [chainId],
        // CIP-30 methods surfaced through CIP-45.
        methods: [
          "cardano_signTx",
          "cardano_signData",
          "cardano_submitTx",
          "cardano_getUsedAddresses",
          "cardano_getUnusedAddresses",
          "cardano_getChangeAddress",
          "cardano_getRewardAddresses",
          "cardano_getBalance",
          "cardano_getNetworkId",
        ],
        events: ["cardano_onNetworkChange", "cardano_onAccountChange"],
      },
    },
  });

  if (!uri) {
    throw new Error("WalletConnect did not return a pairing URI.");
  }

  const account: Promise<WalletConnectAccount> = approval().then((session: SessionTypes.Struct) => {
    const accounts = session.namespaces.cip34?.accounts ?? [];
    if (accounts.length === 0) {
      throw new Error("Wallet approved the session but returned no Cardano accounts.");
    }
    // Account string format: `cip34:<netId>-<magic>:<bech32StakeAddr>`
    const [ns, ref, stakeAddress] = accounts[0].split(":");
    const netId = Number(ref?.split("-")[0]);
    if (ns !== "cip34" || Number.isNaN(netId) || !stakeAddress) {
      throw new Error(`Unexpected CIP-34 account format: ${accounts[0]}`);
    }
    return {
      chainId: `${ns}:${ref}`,
      networkId: netId === 1 ? 1 : 0,
      stakeAddress,
      topic: session.topic,
    };
  });

  return {
    uri,
    approval: account,
    cancel: async () => {
      // Best-effort — SignClient will time out the proposal server-side too.
      try {
        // No public "cancelProposal" — closing the client's pending proposal
        // is handled by the wallet timing out. We expose this for symmetry.
      } catch {
        /* noop */
      }
    },
  };
}

export async function disconnectSession(topic: string): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  try {
    await client.disconnect({
      topic,
      reason: { code: 6000, message: "User disconnected" },
    });
  } catch {
    /* already gone */
  }
}

export function isWalletConnectConfigured(): boolean {
  return Boolean(PROJECT_ID);
}
