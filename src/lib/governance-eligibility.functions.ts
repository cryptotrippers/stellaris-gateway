/**
 * Eligible voting weight (the quorum denominator).
 *
 * Read live from the chain: unspent genuine Position UTxOs owned by wallets a
 * user has proven with a signed link — the same rule castVote and
 * finalizeProposal use. Only totals are returned, never a per-user breakdown.
 */

import { createServerFn } from "@tanstack/react-start";

export interface EligibleWeights {
  total: number;
  byAsset: Record<string, number>;
}

export const getEligibleWeights = createServerFn({ method: "GET" }).handler(
  async (): Promise<EligibleWeights> => {
    const w = await import("./governance-weight.server");
    const owners = await w.linkedOwners();
    const perAsset = await w.liveOwnerWeightsByAsset();
    const byAsset: Record<string, number> = {};
    let total = 0n;
    for (const [assetId, weights] of perAsset) {
      let sum = 0n;
      for (const v of w.weightsPerUser(weights, owners).values()) sum += v;
      byAsset[assetId] = w.toAda(sum);
      total += sum;
    }
    return { total: w.toAda(total), byAsset };
  },
);
