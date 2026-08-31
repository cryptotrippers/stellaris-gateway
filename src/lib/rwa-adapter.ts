/**
 * Open RWA vault adapter interface (Wing B).
 *
 * Stellaris' own yield vault is one implementation of this interface, not the
 * interface itself. Anything that can (a) name its deposit denomination as a
 * Cardano ledger unit, (b) quote a share price, and (c) build deposit /
 * withdraw transactions, can be listed by this app — RealFi, USDM, iUSD, or a
 * future issuer — without an exclusive partnership or a change to the UI.
 *
 * Standards alignment:
 *   * CIP-0113 (programmable tokens) — a deposit denomination is identified by
 *     `(policyId, assetNameHex)` plus an optional metadata pointer, never by a
 *     hard-coded symbol. `cip113MetadataUrl` on a registry row carries the
 *     issuer's own token description.
 *   * CIP-0143 (fungible vault / share accounting) — a vault reports
 *     `totalShares` / `totalAssets` and prices shares as
 *     `totalAssets / totalShares`, so redeemable value is derived, never stored
 *     per depositor.
 *
 * The interface is intentionally transaction-shaped rather than
 * validator-shaped: an adapter may be a Plutus vault, a multi-sig custody
 * arrangement, or an off-chain venue, as long as it can answer these calls.
 */

import type { DepositAsset } from "./deposit-assets.shared";

/** Aggregate accounting for a vault, in the deposit asset's base units. */
export interface RwaVaultAccounting {
  /** Total shares outstanding, including any unclaimed fee shares. */
  totalShares: bigint;
  /** Total accounted assets backing those shares, in base units. */
  totalAssets: bigint;
  /** `totalAssets / totalShares`, or 1 for an un-bootstrapped vault. */
  sharePrice: number;
  /** Annual management fee in basis points, if the adapter charges one. */
  feeBps: number;
  /** Deposits closed while true; redemptions must stay open. */
  paused: boolean;
  /** Accrual epoch or equivalent monotonic counter. */
  epoch: number;
}

/** One holder's stake as the adapter reports it. */
export interface RwaPosition {
  shares: bigint;
  /** Value the holder could redeem right now, in base units. */
  redeemable: bigint;
}

/** Everything the UI needs to describe a listing without knowing its backend. */
export interface RwaVaultDescriptor {
  /** Stable id of the real-world asset this vault funds. */
  assetId: string;
  /** Adapter implementation id, e.g. `"stellaris-yield-v3"`. */
  adapterId: string;
  /** Ledger unit deposits are denominated in. */
  depositAsset: DepositAsset;
  /** Bech32 script address, when the adapter is on-chain. */
  scriptAddress: string | null;
  /** Network the descriptor is valid on. */
  network: string;
}

export interface RwaSubmittedTx {
  txHash: string;
  /**
   * Shares the transaction actually mints or burns, as computed by the same
   * arithmetic the validator enforces. Present when the adapter knows it at
   * build time; the UI must prefer this over its own projection.
   */
  shares?: bigint;
  /** Share price the transaction settled at. */
  sharePrice?: number;
}

/**
 * The contract every listing backend implements. Methods that a given backend
 * cannot support (e.g. a read-only mirror of an external issuer's vault) may
 * be omitted; the UI hides the corresponding action rather than failing.
 */
export interface RwaVaultAdapter {
  readonly adapterId: string;
  /** Describe the vault for one asset, or null when it is not deployed. */
  describe(assetId: string): Promise<RwaVaultDescriptor | null>;
  /** Read aggregate accounting from the source of truth (chain, usually). */
  readAccounting(assetId: string): Promise<RwaVaultAccounting>;
  /** Read the connected wallet's position, if any. */
  readPosition?(assetId: string, ownerAddress: string): Promise<RwaPosition | null>;
  /** Build, sign and submit a deposit of `amount` base units. */
  deposit?(assetId: string, amount: bigint): Promise<RwaSubmittedTx>;
  /** Redeem `shares`, or the whole position when omitted. */
  withdraw?(assetId: string, shares?: bigint): Promise<RwaSubmittedTx>;
}

/** Derive a share price without dividing by zero on an empty vault. */
export function sharePriceOf(totalAssets: bigint, totalShares: bigint): number {
  if (totalShares <= 0n) return 1;
  return Number(totalAssets) / Number(totalShares);
}

/** CIP-0143 style redemption value for a share count. */
export function redeemableFor(
  shares: bigint,
  totalAssets: bigint,
  totalShares: bigint,
): bigint {
  if (totalShares <= 0n || shares <= 0n) return 0n;
  return (shares * totalAssets) / totalShares;
}

const registry = new Map<string, RwaVaultAdapter>();

/** Register an adapter implementation under its id. */
export function registerRwaAdapter(adapter: RwaVaultAdapter): void {
  registry.set(adapter.adapterId, adapter);
}

/** Look up a registered adapter, or undefined when nothing handles it. */
export function getRwaAdapter(adapterId: string): RwaVaultAdapter | undefined {
  return registry.get(adapterId);
}

/** Every registered adapter, for diagnostics and the developer reference. */
export function listRwaAdapters(): RwaVaultAdapter[] {
  return [...registry.values()];
}
