/**
 * Sprint 1 E21 — refuse wrong-network wallets at connect.
 *
 * `assertWalletMatchesAppNetwork()` already stops every signing action, but a
 * mainnet wallet could still *connect*, show a balance and look usable until
 * the first transaction failed. This gate runs at connect time (CIP-30,
 * silent restore and WalletConnect) so a mainnet wallet is never promoted
 * into wallet state at all.
 *
 * Pure and dependency-free so it can be unit-tested in Node; callers pass the
 * app's expected network id (`EXPECTED_WALLET_NETWORK_ID` from network.ts).
 */

export type WalletNetworkRefusal = {
  kind: "wrong_network";
  message: string;
};

/** CIP-30 / CIP-34 network ids: 1 = mainnet, 0 = any testnet. */
export type WalletNetworkId = 0 | 1;

function networkName(id: WalletNetworkId): string {
  return id === 1 ? "Cardano mainnet" : "a Cardano test network";
}

/**
 * Returns `null` when the wallet may connect, otherwise a user-facing refusal.
 * A wallet that reports anything other than 0 or 1 is refused too: an
 * unreadable network is never assumed to be safe.
 */
export function checkWalletNetworkAtConnect(
  walletNetworkId: unknown,
  expected: WalletNetworkId,
): WalletNetworkRefusal | null {
  if (walletNetworkId !== 0 && walletNetworkId !== 1) {
    return {
      kind: "wrong_network",
      message:
        "Your wallet didn't report which Cardano network it is on, so it can't be connected. " +
        "Switch it to Preprod and try again.",
    };
  }
  if (walletNetworkId === expected) return null;
  if (walletNetworkId === 1) {
    return {
      kind: "wrong_network",
      message:
        "This wallet is on Cardano mainnet. Stellaris runs only on the Preprod test network " +
        "and never connects mainnet wallets, so no real funds can be used here. " +
        "Switch your wallet to Preprod (or use a separate test wallet) and connect again.",
    };
  }
  return {
    kind: "wrong_network",
    message: `This wallet is on ${networkName(walletNetworkId)}, but this app expects ${networkName(expected)}. Switch networks and connect again.`,
  };
}
