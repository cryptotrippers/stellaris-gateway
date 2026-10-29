/**
 * fraction_vault v2 — Preprod smoke test of the test offering (fv2-test-01).
 *
 * Takes the offering through its ordinary life with real transactions:
 * three pledges (for three owners), a keeper Settle past the soft cap,
 * CloseRaise, a Release to the SPV, CommitPeriod 1, and the treasury's fee
 * claim. Every stage is built by the E07 builders, re-reads the chain first,
 * and passes the S1 intent guard before it can be signed.
 *
 * Shared by `scripts/fv2/smoke-test.ts` (Preprod) and its emulator self-test
 * (`tests/contracts/fv2-smoke.test.ts`). Test only.
 */
import { createHash } from "node:crypto";
import type { TxSignBuilder } from "@lucid-evolution/lucid";
import {
  buildAction,
  buildPledge,
  buildSettle,
  findPledges,
  findState,
  type V2Context,
} from "../../../src/lib/offering-v2-tx";
import type { TxIntent } from "../../../src/lib/tx-intent-guard.shared";

/** Who does what in the smoke test. Addresses are bech32; keys are key hashes. */
export interface SmokeRoles {
  /** Pays for every pledge, is the keeper, and receives the SPV and treasury payouts. */
  operatorAddress: string;
  operatorKey: string;
  /** Owners of the three pledges, in order. */
  owners: [string, string, string];
  /** Committee key hashes that sign the committee actions (the threshold). */
  signers: string[];
}

export const SMOKE_PLEDGES = [40n, 35n, 30n] as const;
/** Released to the SPV, in TSRA base units (100 TSRA). */
export const SMOKE_RELEASE = 100_000_000n;

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const SMOKE_EVIDENCE_TEXT = "fv2-test-01 smoke test: release 1 evidence (test only)";
export const SMOKE_MANIFEST_TEXT =
  "fv2-test-01 smoke test: period 1 manifest (test only, no payouts)";

export type SmokeStageName =
  | "pledge-1"
  | "pledge-2"
  | "pledge-3"
  | "settle"
  | "close"
  | "release"
  | "commit"
  | "claim";

export const SMOKE_STAGES: readonly SmokeStageName[] = [
  "pledge-1",
  "pledge-2",
  "pledge-3",
  "settle",
  "close",
  "release",
  "commit",
  "claim",
];

/** Stages the committee co-signs (the rest only the operator wallet signs). */
export const COMMITTEE_STAGES: ReadonlySet<SmokeStageName> = new Set([
  "close",
  "release",
  "commit",
  "claim",
]);

export interface SmokeStage {
  name: SmokeStageName;
  tx: TxSignBuilder;
  intent: TxIntent;
  /** What to record for this stage (besides the tx hash). */
  record: Record<string, unknown>;
}

/** Build one stage against the chain as it is now. */
export async function buildSmokeStage(
  ctx: V2Context,
  name: SmokeStageName,
  roles: SmokeRoles,
  nowMs: number,
): Promise<SmokeStage> {
  const pledgeIx = ["pledge-1", "pledge-2", "pledge-3"].indexOf(name);
  if (pledgeIx >= 0) {
    const qty = SMOKE_PLEDGES[pledgeIx]!;
    const b = await buildPledge(ctx, roles.owners[pledgeIx]!, qty, nowMs);
    return { name, ...b, record: { owner: roles.owners[pledgeIx], qty: qty.toString() } };
  }
  switch (name) {
    case "settle": {
      const ps = (await findPledges(ctx)).filter((p) => p.marked);
      const b = await buildSettle(ctx, ps, [roles.operatorKey], nowMs);
      return {
        name,
        ...b,
        record: {
          pledges: ps.length,
          fractions: ps.reduce((a, p) => a + p.pledge.qty, 0n).toString(),
        },
      };
    }
    case "close": {
      const b = await buildAction(ctx, { kind: "closeRaise" }, { signers: roles.signers, nowMs });
      return { name, ...b, record: { netProceeds: b.next!.book.netProceeds.toString() } };
    }
    case "release": {
      const evidenceHash = sha256(SMOKE_EVIDENCE_TEXT);
      const b = await buildAction(
        ctx,
        { kind: "release", amount: SMOKE_RELEASE, evidenceHash },
        { signers: roles.signers, payTo: roles.operatorAddress, nowMs },
      );
      return { name, ...b, record: { amount: SMOKE_RELEASE.toString(), evidenceHash } };
    }
    case "commit": {
      const { state } = await findState(ctx);
      const manifestRoot = sha256(SMOKE_MANIFEST_TEXT);
      const period = state.period + 1n;
      const b = await buildAction(
        ctx,
        { kind: "commitPeriod", period, manifestRoot },
        { signers: roles.signers, nowMs },
      );
      return { name, ...b, record: { period: period.toString(), manifestRoot } };
    }
    case "claim": {
      const { state } = await findState(ctx);
      const amount = state.book.fees;
      const b = await buildAction(
        ctx,
        { kind: "claimFee", amount },
        { signers: roles.signers, payTo: roles.operatorAddress, nowMs },
      );
      return { name, ...b, record: { amount: amount.toString() } };
    }
    default:
      throw new Error(`Unknown stage ${name as string}`);
  }
}

/** What the State should look like after every stage has run. */
export function expectedEnd() {
  const fractions = SMOKE_PLEDGES.reduce((a, b) => a + b, 0n);
  const escrowed = fractions * 10_000_000n;
  const fees = escrowed / 100n;
  return {
    status: "operating" as const,
    settled: fractions,
    outstanding: fractions,
    released: SMOKE_RELEASE,
    fees: 0n,
    escrowed: escrowed - fees,
    netProceeds: escrowed - fees,
    period: 1n,
    manifestRoot: sha256(SMOKE_MANIFEST_TEXT),
  };
}
