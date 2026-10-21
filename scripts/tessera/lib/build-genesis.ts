/**
 * Build (never sign) the Tessera Reserve genesis transaction.
 *
 * One transaction that:
 *   - spends the seed UTxO (the reserve script is parameterised by it, so the
 *     policy can mint its thread tokens exactly once, ever);
 *   - mints exactly one `config` and one `supply` token under the reserve policy;
 *   - pays exactly two outputs to the reserve's ENTERPRISE address, no reference
 *     script: the Config (ADA + `config`, inline ConfigDatum) and the Supply
 *     (ADA + `supply`, inline SupplyDatum with attested_at == validity lower bound);
 *   - has a finite validity window of at most one day.
 *
 * `.complete()` evaluates the reserve policy against this exact transaction,
 * so a successful build means the validator accepts it.
 */
import {
  Data,
  slotToUnixTime,
  unixTimeToSlot,
  type LucidEvolution,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { applyEligibility, applyReserve, enterpriseAddress, type AppliedScript } from "./blueprint";
import {
  configDatumCbor,
  genesisProblems,
  reserveUnits,
  supplyDatumCbor,
  windowProblems,
  type GenesisParams,
} from "./genesis";

/** Lovelace each genesis UTxO carries (min-ADA headroom for later, larger datums). */
export const GENESIS_UTXO_LOVELACE = 5_000_000n;
/** Validity starts this far in the past so the tx is valid on arrival. */
const LOWER_SLACK_MS = 120_000;
/** Validity window: one hour (rules allow up to one day). */
const WINDOW_MS = 3_600_000;

export type GenesisInput = Omit<GenesisParams, "eligibilityPolicy">;

export interface GenesisPlan {
  tx: TxSignBuilder;
  reserve: AppliedScript;
  eligibility: AppliedScript;
  reserveAddress: string;
  units: ReturnType<typeof reserveUnits>;
  params: GenesisParams;
  lo: number;
  hi: number;
  /** attested_at recorded in the Supply datum (== lo). */
  attestedAt: number;
  seed: UTxO;
}

export async function buildGenesis(
  lucid: LucidEvolution,
  seed: UTxO,
  input: GenesisInput,
  nowMs: number,
): Promise<GenesisPlan> {
  const network = lucid.config().network;
  if (!network) throw new Error("Lucid has no network configured");

  const reserve = applyReserve({ txHash: seed.txHash, outputIndex: seed.outputIndex });
  // Eligibility is parameterised by the applied reserve hash; its hash is known
  // before genesis and is recorded in the Config (genesis_config_ok needs 28 bytes).
  const eligibility = applyEligibility(reserve.hash);
  const params: GenesisParams = { ...input, eligibilityPolicy: eligibility.hash };

  const problems = genesisProblems(params);
  if (problems.length)
    throw new Error(`Genesis parameters refused:\n  - ${problems.join("\n  - ")}`);

  // Snap both bounds to slot boundaries so the on-chain POSIX lower bound is
  // exactly `lo`, which genesis_supply_ok requires to equal attested_at.
  const lo = slotToUnixTime(network, unixTimeToSlot(network, nowMs - LOWER_SLACK_MS));
  const hi = slotToUnixTime(network, unixTimeToSlot(network, lo + WINDOW_MS));
  const wp = windowProblems(lo, hi);
  if (wp.length) throw new Error(`Validity window refused: ${wp.join("; ")}`);

  const reserveAddress = enterpriseAddress(network, reserve);
  const units = reserveUnits(reserve.hash);

  const tx = await lucid
    .newTx()
    .collectFrom([seed])
    .mintAssets({ [units.config]: 1n, [units.supply]: 1n }, Data.void())
    .attach.MintingPolicy(reserve.script)
    .pay.ToContract(
      reserveAddress,
      { kind: "inline", value: configDatumCbor(params) },
      { lovelace: GENESIS_UTXO_LOVELACE, [units.config]: 1n },
    )
    .pay.ToContract(
      reserveAddress,
      { kind: "inline", value: supplyDatumCbor(params, lo) },
      { lovelace: GENESIS_UTXO_LOVELACE, [units.supply]: 1n },
    )
    .validFrom(lo)
    .validTo(hi)
    .complete();

  return { tx, reserve, eligibility, reserveAddress, units, params, lo, hi, attestedAt: lo, seed };
}

/** A seed must be a plain wallet UTxO: no datum, no reference script. */
export function seedProblems(u: UTxO): string[] {
  const out: string[] = [];
  if (u.datum || u.datumHash) out.push("seed carries a datum");
  if (u.scriptRef) out.push("seed carries a reference script");
  if ((u.assets.lovelace ?? 0n) < 2_000_000n) out.push("seed holds less than 2 ADA");
  return out;
}
