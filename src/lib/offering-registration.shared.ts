import { z } from "zod";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const policy = z.string().regex(/^[0-9a-f]{56}$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const offeringRegistrationSchema = z.object({
  assetId: z.string().min(1),
  network: z.string().min(1),
  vaultVersion: positiveInteger,
  scriptHash: policy,
  scriptAddress: z.string().min(1),
  fractionPolicyId: policy,
  fractionAssetNameHex: z.string().regex(/^[0-9a-f]*$/),
  depositAssetId: z.string().nullable().optional(),
  totalFractions: positiveInteger,
  pricePerFraction: positiveInteger,
  mintFeeBps: z.number().int().min(0).max(500),
  redeemFeeBps: z.number().int().min(0).max(500),
  issuerName: z.string().min(1),
  treasuryAddress: z.string().nullable().optional(),
  operatorKeyHashes: z.array(policy).min(1),
  signatureThreshold: positiveInteger,
  bootstrapTxHash: hash,
});

export type OfferingRegistrationInput = z.infer<typeof offeringRegistrationSchema>;

export const pendingOfferingSchema = z.object({
  payload: offeringRegistrationSchema,
  seed: z.object({ txHash: hash, outputIndex: z.number().int().nonnegative() }),
});

export type PendingOffering = z.infer<typeof pendingOfferingSchema>;
export const PENDING_OFFERING_KEY = "stellaris.pending-offering.v1";

/** Never round on-chain integers to fit a registry number. */
export function registryInteger(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The amount must be a positive integer within the registry's exact range.");
  }
  return Number(value);
}

/** Convert a decimal denomination price without floating-point rounding. */
export function priceInBaseUnits(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return 0n;
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match) return 0n;
  const whole = match[1];
  if (whole === undefined) return 0n;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return 0n;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

type RegisteredOpening = {
  asset_id: string;
  network: string;
  vault_version: number;
  script_address: string;
  script_hash: string;
  fraction_policy_id: string;
  bootstrap_tx_hash: string | null;
};

/** A retry may return an existing row, but must never replace another opening. */
export async function registerOpeningOnce<T extends RegisteredOpening>(
  payload: OfferingRegistrationInput,
  find: () => Promise<T | null>,
  insert: () => Promise<T>,
): Promise<T> {
  const accept = (row: T): T => {
    if (
      row.asset_id !== payload.assetId ||
      row.network !== payload.network ||
      row.vault_version !== payload.vaultVersion ||
      row.script_address !== payload.scriptAddress ||
      row.script_hash !== payload.scriptHash ||
      row.fraction_policy_id !== payload.fractionPolicyId ||
      row.bootstrap_tx_hash !== payload.bootstrapTxHash
    ) {
      throw new Error(
        "A different opening is already registered for this asset. Nothing was overwritten.",
      );
    }
    return row;
  };
  const existing = await find();
  if (existing) return accept(existing);
  try {
    return await insert();
  } catch (error) {
    // Handles concurrent retries and a response lost after the insert committed.
    const committed = await find();
    if (committed) return accept(committed);
    throw error;
  }
}

/** Retry only the listing request; no wallet/transaction builder is involved. */
export async function retryOfferingRegistration(
  pending: PendingOffering,
  register: (payload: OfferingRegistrationInput) => Promise<unknown>,
  wait: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await register(pending.payload);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("NOT_CONFIRMED") || attempt >= 30) throw error;
      await wait();
    }
  }
}
