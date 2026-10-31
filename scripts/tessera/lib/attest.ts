/**
 * Re-attesting the TSRA reserve (SPEC.md §3: `Attest { reserve }`).
 *
 * The committee records the reserve backing TSRA; the reserve script then
 * allows a Mint only while that attestation is fresh: the Mint's validity must
 * end by `attested_at + 7 days` (`rules.fresh`). Attest itself needs a finite
 * validity window of at most a day whose lower bound is not before the previous
 * `attested_at` (`rules.window_ok`), M-of-N committee signatures, and changes
 * nothing but `attested_reserve`, `attestation_epoch + 1`, `attested_at` (= the
 * lower bound) and `epoch + 1`. The builder is `buildAttest` (Stage 5a).
 *
 * Shared by `scripts/tessera/attest.ts` and its emulator test.
 */
import type { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { buildAttest, supplyFields, type ReserveCtx, type Step } from "./build-actions";

/** `rules.fresh`: a Mint's validity must end within this long after `attested_at`. */
export const ATTEST_FRESH_MS = 7 * 86_400_000;

export interface Freshness {
  minted: bigint;
  attestedReserve: bigint;
  mintCap: bigint;
  attestationEpoch: bigint;
  /** POSIX ms. */
  attestedAt: number;
  /** A Mint must be valid entirely before this (POSIX ms). */
  freshUntil: number;
  fresh: boolean;
  /** Room to mint now: min(attested reserve, cap) − minted, 0 when stale. */
  mintable: bigint;
}

/** Read the Supply datum: what has been minted, what is attested, until when. */
export function freshness(supply: UTxO, nowMs: number): Freshness {
  const [minted, attestedReserve, mintCap, attestationEpoch, attestedAt] = supplyFields(
    supply.datum!,
  ) as [bigint, bigint, bigint, bigint, bigint];
  const freshUntil = Number(attestedAt) + ATTEST_FRESH_MS;
  const fresh = nowMs < freshUntil;
  const ceiling = attestedReserve < mintCap ? attestedReserve : mintCap;
  const room = ceiling > minted ? ceiling - minted : 0n;
  return {
    minted,
    attestedReserve,
    mintCap,
    attestationEpoch,
    attestedAt: Number(attestedAt),
    freshUntil,
    fresh,
    mintable: fresh ? room : 0n,
  };
}

export interface ReattestOptions {
  /** New attested reserve in TSRA base units; defaults to the current one. */
  reserve?: bigint;
  /**
   * Attesting below the minted supply is legal (SPEC §3: it blocks further
   * mints until the reserve recovers) but almost never what an operator means.
   */
  allowBelowMinted?: boolean;
}

/** Build a re-attestation against the live Supply, refusing the obvious mistakes early. */
export async function buildReattest(
  lucid: LucidEvolution,
  ctx: ReserveCtx,
  supply: UTxO,
  nowMs: number,
  opts: ReattestOptions = {},
): Promise<{ step: Step; before: Freshness; reserve: bigint }> {
  const before = freshness(supply, nowMs);
  const reserve = opts.reserve ?? before.attestedReserve;
  if (reserve < 0n) throw new Error("The attested reserve cannot be negative.");
  if (reserve < before.minted && !opts.allowBelowMinted)
    throw new Error(
      `Attesting ${reserve} base units is below the ${before.minted} already minted; no TSRA could be minted until it recovers. ` +
        "Pass --allow-below-minted if that is really intended.",
    );
  if (ctx.signers.length === 0) throw new Error("Attest needs the committee signers.");
  const step = await buildAttest(lucid, ctx, supply, reserve, nowMs);
  return { step, before, reserve };
}

/** "Fri 6 Nov, 21:10 Sydney" style, for operator output. */
export function sydney(ms: number): string {
  return new Date(ms).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
