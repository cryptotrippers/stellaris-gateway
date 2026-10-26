/**
 * Security Suite S3.3 — shared input schemas for server functions.
 *
 * Every server function validates its input against a schema before it does
 * anything. These are the building blocks: tight formats for the identifiers
 * the app passes around (asset ids, transaction hashes, Preprod addresses,
 * token units), with length caps so nothing oversized reaches the database or
 * Blockfrost.
 */
import { z } from "zod";

/** Asset / vault / offering id, e.g. "sfm-01", "ph-solar-01". */
export const assetIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "That is not a valid asset id.");

export const txHashSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, "That is not a transaction hash.");

/** A Preprod bech32 address (payment or script). */
export const preprodAddressSchema = z
  .string()
  .trim()
  .regex(/^addr_test1[02-9ac-hj-np-z]{50,110}$/, "That is not a Cardano Preprod address.");

/** A Preprod bech32 stake address. */
export const preprodStakeAddressSchema = z
  .string()
  .trim()
  .regex(/^stake_test1[02-9ac-hj-np-z]{50,60}$/, "That is not a Cardano Preprod stake address.");

/** A native token unit: policy id (56 hex) + asset name (0–64 hex). */
export const tokenUnitSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{56}([0-9a-f]{2}){0,32}$/, "That is not a token unit.");

/** "lovelace" or a token unit. */
export const valueUnitSchema = z.union([z.literal("lovelace"), tokenUnitSchema]);

export const vaultTxInputSchema = z.object({
  vaultId: assetIdSchema,
  type: z.enum(["deposit", "withdraw", "yield"]),
  amountAda: z.number().finite().nonnegative().max(45_000_000_000),
  txHash: txHashSchema,
  blockHeight: z.number().int().nonnegative().nullable().optional(),
});

const shortText = (max: number) => z.string().max(max);

/** Shape and size only; the business rules stay in funding-requests' validate(). */
export const fundingRequestInputSchema = z.object({
  assetSlug: shortText(64),
  name: shortText(160),
  category: shortText(64),
  issuer: shortText(160),
  location: shortText(160).optional(),
  description: shortText(8_000),
  targetAda: z.number().finite().positive().max(45_000_000_000),
  minDepositAda: z.number().finite().nonnegative().max(45_000_000_000),
  maturityMonths: z.number().int().nonnegative().max(1_200).optional(),
  reportingCadence: shortText(64).optional(),
  evidenceUrls: z.array(shortText(500)).max(20),
  proposedFeeBps: z.number().int(),
  treasuryAddress: shortText(120).optional(),
  termsAccepted: z.boolean(),
});

/** Run a schema and turn its first problem into a plain Error message. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(
      first?.message && first.message !== "Required" ? first.message : "Invalid input.",
    );
  }
  return r.data;
}

/**
 * Blockfrost paths are built from these identifiers; this is the last check
 * before one is sent with the server's key. Only API path characters and a
 * simple query string, never "..", "//", "#" or a scheme.
 */
export function isSafeBlockfrostPath(path: string): boolean {
  if (!/^\/[A-Za-z0-9_\-/]+(\?[A-Za-z0-9_\-=&.]*)?$/.test(path)) return false;
  return !path.includes("..") && !path.includes("//");
}
