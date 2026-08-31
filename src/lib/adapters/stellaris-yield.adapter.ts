/**
 * Reference `RwaVaultAdapter` implementation: the Stellaris shared yield vault
 * (`yield_vault` v3), denominated in ADA.
 *
 * This is the first concrete backend behind the aggregator's deposit ->
 * allocation flow. Everything the UI needs — denomination, accounting, the
 * caller's position, and deposit/withdraw transactions — is answered through
 * the open interface, so a second issuer can be listed by registering another
 * adapter rather than by editing the flow.
 */

import {
  registerRwaAdapter,
  sharePriceOf,
  type RwaPosition,
  type RwaSubmittedTx,
  type RwaVaultAccounting,
  type RwaVaultAdapter,
  type RwaVaultDescriptor,
} from "@/lib/rwa-adapter";
import type { DepositAsset } from "@/lib/deposit-assets.shared";
import { APP_NETWORK } from "@/lib/network";
import { getAssetVault } from "@/lib/asset-vaults.functions";
import { depositToYieldVault, loadMyVaultView, withdrawFromYieldVault } from "@/lib/yield-position";

export const STELLARIS_YIELD_ADAPTER_ID = "stellaris-yield-v3";

/** ADA row used when the registry has not been read yet. */
const ADA_FALLBACK: DepositAsset = {
  id: "ada",
  symbol: "ADA",
  display_name: "Cardano ADA",
  policy_id: "",
  asset_name_hex: "",
  decimals: 6,
  network: APP_NETWORK,
  status: "live",
  issuer_name: "Cardano",
  docs_url: null,
  cip113_metadata_url: null,
  sort_order: 0,
};

async function registryAddressFor(assetId: string): Promise<string | null> {
  try {
    const row = await getAssetVault({ data: { assetId } });
    return row?.script_address ?? null;
  } catch {
    return null;
  }
}

export function createStellarisYieldAdapter(depositAsset: DepositAsset = ADA_FALLBACK): RwaVaultAdapter {
  /**
   * `yield_vault` v3 accounts in lovelace only. A native-token denomination
   * needs the multi-asset validator, so refuse it loudly here rather than
   * quietly sending `amount` to an ADA vault as if it were lovelace — that
   * would mint shares against a deposit the depositor never made.
   */
  function assertAdaDenominated(): void {
    const isAda = depositAsset.policy_id === "" && depositAsset.asset_name_hex === "";
    if (!isAda) {
      throw new Error(
        `${depositAsset.symbol} deposits are not settled by this vault yet — it accounts in ADA. ` +
          `Choose ADA, or wait for the multi-asset vault to be deployed for this project.`,
      );
    }
  }

  return {
    adapterId: STELLARIS_YIELD_ADAPTER_ID,

    async describe(assetId: string): Promise<RwaVaultDescriptor | null> {
      const scriptAddress = await registryAddressFor(assetId);
      if (!scriptAddress) return null;
      return {
        assetId,
        adapterId: STELLARIS_YIELD_ADAPTER_ID,
        depositAsset,
        scriptAddress,
        network: APP_NETWORK,
      };
    },

    async readAccounting(assetId: string): Promise<RwaVaultAccounting> {
      const view = await loadMyVaultView(assetId, await registryAddressFor(assetId));
      const totalShares = BigInt(view.state.totalShares);
      const totalAssets = BigInt(view.state.totalAssets);
      return {
        totalShares,
        totalAssets,
        sharePrice: sharePriceOf(totalAssets, totalShares),
        feeBps: Number(view.state.feeBps ?? 0),
        paused: Boolean(view.state.paused),
        epoch: Number(view.state.epoch ?? 0),
      };
    },

    async readPosition(assetId: string): Promise<RwaPosition | null> {
      const view = await loadMyVaultView(assetId, await registryAddressFor(assetId));
      if (view.positions.length === 0) return null;
      return {
        shares: view.positions.reduce((a, p) => a + p.shares, 0n),
        redeemable: view.positions.reduce((a, p) => a + p.redeemable, 0n),
      };
    },

    async deposit(assetId: string, amount: bigint): Promise<RwaSubmittedTx> {
      assertAdaDenominated();
      const r = await depositToYieldVault({
        assetId,
        amountLovelace: amount,
        registryAddress: await registryAddressFor(assetId),
      });
      // The builder derives minted shares from the on-chain state it just
      // spent, so this is the settled figure, not a client-side projection.
      return {
        txHash: r.txHash,
        shares: BigInt(r.mintedShares),
        sharePrice: r.sharePrice,
      };
    },

    async withdraw(assetId: string): Promise<RwaSubmittedTx> {
      assertAdaDenominated();
      const r = await withdrawFromYieldVault({
        assetId,
        registryAddress: await registryAddressFor(assetId),
      });
      return { txHash: r.txHash, shares: BigInt(r.burnedShares) };
    },
  };
}

registerRwaAdapter(createStellarisYieldAdapter());
