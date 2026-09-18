/**
 * Fraction events — recorded only after the chain confirms them.
 *
 * Nothing here trusts the caller's description of what happened. The server
 * refetches the transaction from Blockfrost, decodes the offering state before
 * and after, and writes the difference. A transaction that did not touch this
 * offering is rejected, so the activity list can never drift from the ledger.
 */

import { createServerFn } from "@tanstack/react-start";
import { readOfferingDatum, type OfferingDatum } from "./offering-chain";
import { publicSupabase } from "./asset-vaults.shared";
import { OFFERING_COLS, type OfferingRow } from "./offerings.shared";

export interface RecordedFractionEvent {
  eventType: "buy" | "redeem" | "distribute" | "set_status" | "set_fees" | "claim_fee";
  txHash: string;
  fractions: string;
  amount: string;
  feeAmount: string;
  blockTime: string | null;
}

interface BfTxIo {
  inputs: Array<{ address: string; inline_datum: string | null }>;
  outputs: Array<{ address: string; inline_datum: string | null }>;
}

function classify(
  before: OfferingDatum,
  after: OfferingDatum,
): { eventType: RecordedFractionEvent["eventType"]; fractions: bigint; amount: bigint; fee: bigint } {
  const mintedDelta = BigInt(after.minted) - BigInt(before.minted);
  const outstandingDelta = BigInt(after.outstanding) - BigInt(before.outstanding);
  const poolDelta = BigInt(after.pool) - BigInt(before.pool);
  const feeDelta = BigInt(after.fees) - BigInt(before.fees);

  if (mintedDelta > 0n) {
    return { eventType: "buy", fractions: mintedDelta, amount: poolDelta + feeDelta, fee: feeDelta };
  }
  if (outstandingDelta < 0n) {
    return {
      eventType: "redeem",
      fractions: -outstandingDelta,
      amount: -poolDelta - feeDelta,
      fee: feeDelta,
    };
  }
  if (feeDelta < 0n) {
    return { eventType: "claim_fee", fractions: 0n, amount: -feeDelta, fee: 0n };
  }
  if (poolDelta > 0n) {
    return { eventType: "distribute", fractions: 0n, amount: poolDelta, fee: 0n };
  }
  if (before.status !== after.status) {
    return { eventType: "set_status", fractions: 0n, amount: 0n, fee: 0n };
  }
  return { eventType: "set_fees", fractions: 0n, amount: 0n, fee: 0n };
}

/**
 * Verify a submitted transaction against the chain and record what it did.
 * Open to anyone: a buyer need not hold an account to have their purchase
 * appear in the public activity list, and only chain-confirmed facts are kept.
 */
export const recordFractionEvent = createServerFn({ method: "POST" })
  .inputValidator((input: { assetId: string; txHash: string }) => input)
  .handler(async ({ data }): Promise<RecordedFractionEvent | null> => {
    if (!/^[0-9a-f]{64}$/.test(data.txHash)) throw new Error("That is not a transaction hash.");

    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("offerings")
      .select(OFFERING_COLS)
      .eq("asset_id", data.assetId)
      .order("vault_version", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const offering = (rows?.[0] as unknown as OfferingRow) ?? null;
    if (!offering) throw new Error("No offering is registered for that asset.");

    const { bfGet } = await import("./blockfrost-fetch.server");
    const io = await bfGet<BfTxIo>(`/txs/${data.txHash}/utxos`);
    if (!io) return null; // Not yet visible on chain; the caller can retry.

    const before = io.inputs
      .filter((i) => i.address === offering.script_address)
      .map((i) => readOfferingDatum(i.inline_datum))
      .find((d): d is OfferingDatum => d !== null);
    const after = io.outputs
      .filter((o) => o.address === offering.script_address)
      .map((o) => readOfferingDatum(o.inline_datum))
      .find((d): d is OfferingDatum => d !== null);

    if (!after) throw new Error("That transaction does not touch this offering.");
    if (!before) {
      // No offering input: this is the transaction that opened the offering.
      return await insert(offering, {
        eventType: "buy",
        txHash: data.txHash,
        fractions: "0",
        amount: "0",
        feeAmount: "0",
        blockTime: null,
      });
    }

    const { eventType, fractions, amount, fee } = classify(before, after);
    const meta = await bfGet<{ block_time: number }>(`/txs/${data.txHash}`);

    return await insert(offering, {
      eventType,
      txHash: data.txHash,
      fractions: fractions.toString(),
      amount: amount.toString(),
      feeAmount: fee.toString(),
      blockTime: meta ? new Date(meta.block_time * 1000).toISOString() : null,
    });
  });

async function insert(
  offering: OfferingRow,
  event: RecordedFractionEvent,
): Promise<RecordedFractionEvent> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("fraction_events").upsert(
    {
      offering_id: offering.id,
      asset_id: offering.asset_id,
      event_type: event.eventType,
      tx_hash: event.txHash,
      fractions: Number(event.fractions),
      amount: Number(event.amount),
      fee_amount: Number(event.feeAmount),
      network: offering.network,
      block_time: event.blockTime,
    } as never,
    { onConflict: "tx_hash,event_type,offering_id" },
  );
  if (error) throw new Error(error.message);
  return event;
}

/** Public activity for one offering, newest first. */
export const listFractionEvents = createServerFn({ method: "GET" })
  .inputValidator((input: { assetId: string }) => input)
  .handler(async ({ data }) => {
    const supabase = publicSupabase();
    const { data: rows, error } = await supabase
      .from("fraction_events")
      .select("id, event_type, tx_hash, fractions, amount, fee_amount, block_time, created_at")
      .eq("asset_id", data.assetId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
