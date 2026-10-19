/**
 * Offerings — public reads.
 *
 * The registry rows are public (anyone can audit what was listed), and the
 * live counters are read straight off the chain through Blockfrost so a page
 * never shows a database figure as if it were on-chain truth.
 */

import { createServerFn } from "@tanstack/react-start";
import { publicSupabase } from "./asset-vaults.shared";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertRole } from "./asset-vaults.shared";
import { genuineOfferingAt } from "./offering-chain";
import { bfVaultUtxos } from "./yield-chain-decode";
import {
  OFFERING_COLS,
  type FractionHolder,
  type OfferingChainState,
  type OfferingRow,
} from "./offerings.shared";

export type { OfferingRow, OfferingChainState, FractionHolder } from "./offerings.shared";

/** Every registered offering, newest first. Public. */
export const listOfferings = createServerFn({ method: "GET" }).handler(
  async (): Promise<OfferingRow[]> => {
    const supabase = publicSupabase();
    const { data, error } = await supabase
      .from("offerings")
      .select(OFFERING_COLS)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as OfferingRow[];
  },
);

/** One offering by the asset it fractionalises. Public. */
export const getOffering = createServerFn({ method: "GET" })
  .inputValidator((input: { assetId: string }) => input)
  .handler(async ({ data }): Promise<OfferingRow | null> => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("offerings")
      .select(OFFERING_COLS)
      .eq("asset_id", data.assetId)
      .order("vault_version", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    return ((rows?.[0] as unknown as OfferingRow) ?? null) || null;
  });

interface BfUtxo {
  tx_hash: string;
  output_index: number;
  amount: Array<{ unit: string; quantity: string }>;
  inline_datum: string | null;
}

/**
 * Live offering state from the chain. No wallet needed, so public pages can
 * show counters that anyone can re-derive from the same address.
 */
export const readOfferingChainState = createServerFn({ method: "GET" })
  .inputValidator((input: { address: string; unit?: string }) => input)
  .handler(async ({ data }): Promise<OfferingChainState> => {
    const { bfGet } = await import("./blockfrost-fetch.server");
    const unit = data.unit && data.unit !== "lovelace" ? data.unit : "lovelace";
    // F-6: read the offering where its thread token actually sits.
    const { utxos } = await bfVaultUtxos<BfUtxo>(bfGet, data.address);

    // F-1: the live offering is the UTxO carrying its state-thread token. The
    // old rule displayed whichever Offering datum came first, so a planted
    // datum could fake the counters (O-03, offering side).
    const genuine = genuineOfferingAt(utxos, data.address);
    const chosen = genuine.index >= 0 ? utxos[genuine.index] : undefined;
    const held = chosen?.amount.find((a) => a.unit === unit)?.quantity ?? "0";

    return {
      address: data.address,
      datum: genuine.datum,
      held,
      source: "blockfrost",
      readAt: Date.now(),
      warning:
        genuine.planted > 0
          ? `${String(genuine.planted)} Offering-shaped UTxO(s) without the offering's state token sit at this address. They are ignored and can never be spent.`
          : null,
    };
  });

/**
 * Public holder register: who holds this offering's fractions, straight from
 * the chain. This is what makes "fractions outstanding" checkable by anyone
 * rather than a number we assert.
 */
export const readFractionHolders = createServerFn({ method: "GET" })
  .inputValidator((input: { fractionUnit: string }) => input)
  .handler(
    async ({ data }): Promise<{ holders: FractionHolder[]; total: string; readAt: number }> => {
      const { bfGet } = await import("./blockfrost-fetch.server");
      const rows =
        (await bfGet<Array<{ address: string; quantity: string }>>(
          `/assets/${data.fractionUnit}/addresses?count=100`,
        )) ?? [];
      const holders = rows
        .map((r) => ({ address: r.address, fractions: r.quantity }))
        .sort((a, b) => (BigInt(b.fractions) > BigInt(a.fractions) ? 1 : -1));
      const total = holders.reduce((acc, h) => acc + BigInt(h.fractions), 0n);
      return { holders, total: total.toString(), readAt: Date.now() };
    },
  );

/** Register an offering that has just been opened on chain. Admin only. */
export const registerOffering = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      assetId: string;
      network: string;
      vaultVersion: number;
      scriptHash: string;
      scriptAddress: string;
      fractionPolicyId: string;
      fractionAssetNameHex: string;
      depositAssetId?: string | null;
      totalFractions: number;
      pricePerFraction: number;
      mintFeeBps: number;
      redeemFeeBps: number;
      issuerName: string;
      treasuryAddress?: string | null;
      operatorKeyHashes: string[];
      signatureThreshold: number;
      bootstrapTxHash: string;
    }) => input,
  )
  .handler(async ({ data, context }): Promise<OfferingRow> => {
    await assertRole(context.supabase, context.userId, "admin");
    if (!/^[0-9a-f]{64}$/.test(data.bootstrapTxHash)) throw new Error("Bad transaction hash.");

    // Only list what the chain confirms: the opening output must sit at the
    // offering address with a fresh datum matching exactly what was entered.
    const { bfGet } = await import("./blockfrost-fetch.server");
    const io = await bfGet<{
      outputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        inline_datum: string | null;
      }>;
    }>(`/txs/${data.bootstrapTxHash}/utxos`);
    if (!io) throw new Error("NOT_CONFIRMED: the opening transaction is not on chain yet.");
    // F-1: the opening output must carry the offering's state-thread token.
    const d = genuineOfferingAt(io.outputs, data.scriptAddress).datum;
    if (!d) {
      throw new Error(
        "The opening transaction has no offering state carrying the state token at that address.",
      );
    }
    const mismatches: string[] = [];
    if (d.minted !== "0" || d.outstanding !== "0") mismatches.push("fractions already minted");
    if (d.totalFractions !== String(data.totalFractions)) mismatches.push("total fractions");
    if (d.price !== String(data.pricePerFraction)) mismatches.push("price");
    if (d.mintFeeBps !== data.mintFeeBps) mismatches.push("buy fee");
    if (d.redeemFeeBps !== data.redeemFeeBps) mismatches.push("redeem fee");
    if (d.fractionPolicy !== data.fractionPolicyId) mismatches.push("token policy");
    if (d.threshold !== data.signatureThreshold) mismatches.push("threshold");
    if (d.operators.join() !== data.operatorKeyHashes.join()) mismatches.push("committee");
    if (mismatches.length) {
      throw new Error(`The chain disagrees with the form on: ${mismatches.join(", ")}. Not listed.`);
    }
    const { data: row, error } = await context.supabase
      .from("offerings")
      .insert({
        asset_id: data.assetId,
        network: data.network,
        vault_version: data.vaultVersion,
        script_hash: data.scriptHash,
        script_address: data.scriptAddress,
        fraction_policy_id: data.fractionPolicyId,
        fraction_asset_name_hex: data.fractionAssetNameHex,
        deposit_asset_id: data.depositAssetId ?? null,
        total_fractions: data.totalFractions,
        price_per_fraction: data.pricePerFraction,
        mint_fee_bps: data.mintFeeBps,
        redeem_fee_bps: data.redeemFeeBps,
        issuer_name: data.issuerName,
        treasury_address: data.treasuryAddress ?? null,
        operator_key_hashes: data.operatorKeyHashes,
        signature_threshold: data.signatureThreshold,
        bootstrap_tx_hash: data.bootstrapTxHash,
        bootstrapped_at: new Date().toISOString(),
      } as never)
      .select(OFFERING_COLS)
      .single();
    if (error) throw new Error(error.message);
    return row as unknown as OfferingRow;
  });
