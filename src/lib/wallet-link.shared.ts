/**
 * The exact message a wallet signs to prove it belongs to an account. The
 * server stores every field when it issues the nonce and rebuilds this text
 * itself, so nothing the browser sends back is trusted.
 */

export const WALLET_LINK_APP = "Stellaris Gateway";
export const WALLET_LINK_NETWORK = "preprod";
export const WALLET_LINK_TTL_MS = 10 * 60_000;

export interface WalletLinkFields {
  userId: string;
  address: string;
  nonce: string;
  expiresAt: string;
}

export function buildWalletLinkMessage(f: WalletLinkFields): string {
  return [
    `${WALLET_LINK_APP} — link this wallet to my account`,
    `Account: ${f.userId}`,
    `Wallet: ${f.address}`,
    `Nonce: ${f.nonce}`,
    `Network: ${WALLET_LINK_NETWORK}`,
    `Expires: ${f.expiresAt}`,
  ].join("\n");
}

export function utf8Hex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}
