/**
 * Sending test TSRA (and a little tADA) from the operator to tester wallets.
 * Shared by scripts/tessera/send-tsra.ts and its emulator test. Preprod only.
 */
import { getAddressDetails, type LucidEvolution, type TxSignBuilder } from "@lucid-evolution/lucid";

/** Most TSRA one tester gets per run unless the operator raises it explicitly. */
export const DEFAULT_CAP_TSRA = 5_000n;
/** tADA sent with the TSRA so the tester can pay fees and token riders. */
export const DEFAULT_ADA = 25n;

export interface Recipient {
  address: string;
  tsra: bigint; // base units (6 decimals)
  lovelace: bigint;
}

/** Every reason a recipient list would be refused. Empty = fine. */
export function recipientProblems(rs: Recipient[], capUnits: bigint): string[] {
  const out: string[] = [];
  if (rs.length === 0) out.push("No recipients.");
  if (rs.length > 20) out.push("At most 20 recipients per transaction.");
  const seen = new Set<string>();
  for (const r of rs) {
    if (!r.address.startsWith("addr_test1")) {
      out.push(`${r.address.slice(0, 16)}… is not a Preprod (addr_test1) address.`);
      continue;
    }
    let pay: { type: string } | undefined;
    try {
      pay = getAddressDetails(r.address).paymentCredential;
    } catch {
      out.push(`${r.address.slice(0, 16)}… is not a valid address.`);
      continue;
    }
    if (pay?.type !== "Key")
      out.push(`${r.address.slice(0, 16)}… is a script address; send to a wallet address.`);
    if (seen.has(r.address)) out.push(`${r.address.slice(0, 16)}… is listed twice.`);
    seen.add(r.address);
    if (r.tsra <= 0n) out.push("Each recipient needs a positive TSRA amount.");
    if (r.tsra > capUnits)
      out.push(`${r.address.slice(0, 16)}… would get more than the per-tester cap.`);
    if (r.lovelace < 2_000_000n) out.push("Send at least 2 tADA with the tokens.");
  }
  return out;
}

/** One transaction paying every recipient its TSRA and tADA from the selected wallet. */
export async function buildSend(
  lucid: LucidEvolution,
  tsraUnit: string,
  rs: Recipient[],
): Promise<TxSignBuilder> {
  let b = lucid.newTx();
  for (const r of rs) b = b.pay.ToAddress(r.address, { lovelace: r.lovelace, [tsraUnit]: r.tsra });
  return b.complete();
}
