/**
 * Stage 4 — on-chain reads for the yield vault.
 *
 * Server-only so the Blockfrost project id never ships to the browser. These
 * functions are the app's ONLY source of yield numbers: share price, epoch and
 * accrual history all come from the vault's state UTxO and the transaction
 * history at its address. Nothing here is simulated.
 *
 * Module scope stays limited to imports, types and server-function
 * declarations — helpers live in `yield-chain-decode.ts` and
 * `blockfrost-fetch.server.ts`.
 */

import { createServerFn } from "@tanstack/react-start";
import {
  BECH32_ADDRESS_RE,
  TX_HASH_RE,
  annualisedReturnPct,
  deriveAccruals,
  lovelaceOf,
  readPositionDatum,
  readStateDatum,
  sharePriceOf,
  soleStateOrThrow,
  type BfAddressTx,
  type BfTxUtxos,
  type BfUtxo,
  type VaultChainState,
  type VaultHistory,
  type VaultStateDatum,
} from "./yield-chain-decode";

export type {
  VaultChainState,
  VaultHistory,
  VaultStateDatum,
  ChainAccrual,
  VaultPositionDatum,
} from "./yield-chain-decode";

/**
 * Read the single State UTxO (plus every Position UTxO) at a vault address.
 * Returns `found: false` when the vault has not been bootstrapped yet, so the
 * UI can say so instead of inventing a share price.
 */
export const getVaultChainState = createServerFn({ method: "GET" })
  .inputValidator((data: { address: string }) => {
    if (!data?.address || !BECH32_ADDRESS_RE.test(data.address)) {
      throw new Error("A valid bech32 vault address is required");
    }
    return { address: data.address };
  })
  .handler(async ({ data }): Promise<VaultChainState> => {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const utxos = (await bfGet<BfUtxo[]>(`/addresses/${data.address}/utxos?count=100`)) ?? [];

    const stateCandidates: Array<{
      state: VaultStateDatum;
      utxo: NonNullable<VaultChainState["stateUtxo"]>;
    }> = [];
    const positions: VaultChainState["positions"] = [];
    let locked = 0n;

    for (const u of utxos) {
      locked += lovelaceOf(u);
      const asState = readStateDatum(u.inline_datum);
      if (asState) {
        stateCandidates.push({
          state: asState,
          utxo: {
            txHash: u.tx_hash,
            outputIndex: u.output_index,
            lovelace: lovelaceOf(u).toString(),
          },
        });
        continue;
      }
      const asPosition = readPositionDatum(u.inline_datum);
      if (asPosition) {
        positions.push({
          ...asPosition,
          txHash: u.tx_hash,
          outputIndex: u.output_index,
          lovelace: lovelaceOf(u).toString(),
        });
      }
    }

    const sole = soleStateOrThrow(stateCandidates, data.address);
    const state = sole?.state ?? null;
    const stateUtxo = sole?.utxo ?? null;


    return {
      address: data.address,
      found: state !== null,
      state,
      sharePrice: state ? sharePriceOf(state) : null,
      stateUtxo,
      positions,
      lockedLovelace: locked.toString(),
      checkedAt: Date.now(),
    };
  });

/**
 * Walk the transaction history at a vault address, decode the State output of
 * each transaction, and derive the accrual events: an epoch bump where total
 * assets rose while total shares stayed constant.
 */
export const getVaultChainHistory = createServerFn({ method: "GET" })
  .inputValidator((data: { address: string; max?: number }) => {
    if (!data?.address || !BECH32_ADDRESS_RE.test(data.address)) {
      throw new Error("A valid bech32 vault address is required");
    }
    return { address: data.address, max: Math.min(Math.max(data.max ?? 50, 1), 100) };
  })
  .handler(async ({ data }): Promise<VaultHistory> => {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const txs =
      (await bfGet<BfAddressTx[]>(
        `/addresses/${data.address}/transactions?order=asc&count=${data.max}`,
      )) ?? [];

    const points: Array<{ tx: BfAddressTx; state: VaultStateDatum }> = [];
    for (const tx of txs) {
      const detail = await bfGet<BfTxUtxos>(`/txs/${tx.tx_hash}/utxos`);
      if (!detail) continue;
      for (const out of detail.outputs) {
        if (out.address !== data.address) continue;
        const decoded = readStateDatum(out.inline_datum);
        if (decoded) {
          points.push({ tx, state: decoded });
          break;
        }
      }
    }

    const accruals = deriveAccruals(points);

    return {
      address: data.address,
      accruals,
      bootstrapTxHash: points[0]?.tx.tx_hash ?? null,
      apyPct: annualisedReturnPct(accruals),
      scanned: txs.length,
      truncated: txs.length >= data.max,
      checkedAt: Date.now(),
    };
  });

/**
 * Verify that a transaction really is the accrual a proposal authorised.
 * Governance execution is only ever recorded off the back of this check —
 * the client never asserts that a proposal was executed.
 */
export const verifyAccrualTx = createServerFn({ method: "GET" })
  .inputValidator((data: { txHash: string; address: string; expectedLovelace?: string }) => {
    if (!TX_HASH_RE.test(data?.txHash ?? "")) throw new Error("Invalid transaction hash");
    if (!BECH32_ADDRESS_RE.test(data?.address ?? "")) {
      throw new Error("A valid bech32 vault address is required");
    }
    return {
      txHash: data.txHash,
      address: data.address,
      expectedLovelace: data.expectedLovelace ?? null,
    };
  })
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      reason: string;
      epoch: number | null;
      amountLovelace: string | null;
      blockTime: number | null;
    }> => {
      const { bfGet } = await import("./blockfrost-fetch.server");
      const detail = await bfGet<BfTxUtxos>(`/txs/${data.txHash}/utxos`);
      if (!detail) {
        return {
          ok: false,
          reason: "Transaction not found on chain.",
          epoch: null,
          amountLovelace: null,
          blockTime: null,
        };
      }

      const before = detail.inputs
        .filter((i) => i.address === data.address)
        .map((i) => readStateDatum(i.inline_datum))
        .find((s): s is VaultStateDatum => s !== null);

      const after = detail.outputs
        .filter((o) => o.address === data.address)
        .map((o) => readStateDatum(o.inline_datum))
        .find((s): s is VaultStateDatum => s !== null);

      if (!before || !after) {
        return {
          ok: false,
          reason: "This transaction does not spend and recreate the vault state at that address.",
          epoch: null,
          amountLovelace: null,
          blockTime: null,
        };
      }

      const delta = BigInt(after.totalAssets) - BigInt(before.totalAssets);
      if (after.epoch <= before.epoch) {
        return {
          ok: false,
          reason: "The vault epoch did not advance — this is not an accrual.",
          epoch: after.epoch,
          amountLovelace: null,
          blockTime: null,
        };
      }
      if (after.totalShares !== before.totalShares) {
        return {
          ok: false,
          reason: "Share supply changed — this is a deposit or withdrawal, not an accrual.",
          epoch: after.epoch,
          amountLovelace: null,
          blockTime: null,
        };
      }
      if (delta <= 0n) {
        return {
          ok: false,
          reason: "No yield was added to the vault in this transaction.",
          epoch: after.epoch,
          amountLovelace: null,
          blockTime: null,
        };
      }
      if (data.expectedLovelace && BigInt(data.expectedLovelace) !== delta) {
        return {
          ok: false,
          reason: `Amount mismatch: the proposal approved ${data.expectedLovelace} lovelace but this transaction accrued ${delta}.`,
          epoch: after.epoch,
          amountLovelace: delta.toString(),
          blockTime: null,
        };
      }

      const tx = await bfGet<{ block_time: number; block_height: number }>(`/txs/${data.txHash}`);

      return {
        ok: true,
        reason: "Verified on chain.",
        epoch: after.epoch,
        amountLovelace: delta.toString(),
        blockTime: tx?.block_time ?? null,
      };
    },
  );
