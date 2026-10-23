/**
 * Types of the live Tessera Preprod snapshot returned by `getTesseraLive`
 * (src/lib/tessera-live.functions.ts). Amounts are bigint strings in 1e-6
 * units (TSRA, sTSRA, tUSD all have 6 decimals); times are POSIX ms.
 */
export interface TesseraLive {
  fetchedAt: number;
  reserve: {
    mintedSupply: string;
    attestedReserve: string;
    mintCap: string;
    attestationEpoch: number;
    attestedAt: number;
    /** Minting needs an attestation younger than 7 days. */
    attestationFreshUntil: number;
    committee: { threshold: number; size: number };
    paused: boolean;
    kyc: { mint: boolean; redeem: boolean; stake: boolean };
    vaultPolicy: string;
    configEpoch: number;
    supplyEpoch: number;
  };
  vault: {
    shortShares: string;
    shortAssets: string;
    longShares: string;
    longAssets: string;
    vestShort: string;
    vestLong: string;
    vestFrom: number;
    vestUntil: number;
    /** short-class TSRA per sTSRA ×1e6 at fetch time (booked + vested so far). */
    priceE6: string;
    ticketEscrow: string;
    lossIndex: string;
    bounds: {
      longWeightBps: number;
      shortCooldownMs: number;
      longLockMs: number;
      protocolBps: number;
    };
    treasuryAddress: string;
    epoch: number;
    tickets: Array<{ utxo: string; owner: string; value: string; claimAfter: number }>;
  };
  firstLoss: { balance: string; epoch: number };
  queue: {
    config: {
      settleDelayMs: number;
      minRequest: string;
      instantMax: string;
      settleTip: string;
      dailyLimit: string;
      monthlyLimit: string;
      shards: number;
      graceMs: number;
      suspendedUntil: number;
    };
    shortActive: boolean;
    shards: Array<{
      index: number;
      utxo: string;
      tusd: string;
      day: number;
      paidDay: string;
      month: number;
      paidMonth: string;
    }>;
    requests: Array<{
      utxo: string;
      owner: string;
      payoutTo: string;
      qty: string;
      payableAfter: number;
    }>;
    sinks: { count: number; tsra: string };
  };
}
