/**
 * fraction_vault v2 — Preprod test offering: terms, reference scripts, Open.
 *
 * Shared by the operator script (`scripts/fv2/bootstrap-offering.ts`) and its
 * emulator self-test (`tests/contracts/fv2-bootstrap.test.ts`), so what runs on
 * Preprod is exactly what was tested. Builds through the E07 builders and checks
 * every transaction with the S1 intent guard before it can be signed.
 *
 * Test-only terms. Not an investment; nothing here is offered to anyone.
 */
import { createHash } from "node:crypto";
import * as L from "@lucid-evolution/lucid";
import {
  getAddressDetails,
  scriptFromNative,
  validatorToAddress,
  type LucidEvolution,
  type Network,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import { deriveV2, type V2Scripts } from "../../../src/lib/fraction-vault-v2";
import { EMPTY_BOOK, checkOpening, type V2State } from "../../../src/lib/offering-v2-chain";
import {
  STATE_RIDER,
  buildOpen,
  type LucidModTx,
  type V2Context,
} from "../../../src/lib/offering-v2-tx";
import { assertIntent, walletViewOf } from "../../../src/lib/tx-sign-guarded";
import type { TxIntent } from "../../../src/lib/tx-intent-guard.shared";

/** TSRA on Preprod (deployments/preprod-v1.json → reserve.tsraUnit). */
export const PREPROD_TSRA = {
  policyId: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d7400",
  assetNameHex: "54535241",
};

/** The text whose SHA-256 is the test offering's `docs_hash`. */
export const TEST_DOCS_TEXT =
  "Stellaris fraction_vault v2 Preprod TEST offering. Not an investment, not an offer of " +
  "securities, no real asset. Test TSRA only. Terms: 1,000 fractions at 10 TSRA, soft cap 100, " +
  "1% settlement fee, 2-of-3 offering committee.";

export interface TestOfferingOptions {
  assetId: string;
  totalFractions: bigint;
  softCap: bigint;
  /** Deposit units (TSRA, 6 decimals) per fraction. */
  price: bigint;
  /** Days from now until the pledge deadline. */
  deadlineDays: number;
  /** Days after the deadline for settling. */
  settleWindowDays: number;
  feeBps: number;
}

export const TEST_OFFERING: TestOfferingOptions = {
  assetId: "fv2-test-01",
  totalFractions: 1_000n,
  softCap: 100n,
  price: 10_000_000n,
  deadlineDays: 14,
  settleWindowDays: 2,
  feeBps: 100,
};

const DAY = 86_400_000;
const keyHash = (addr: string) => {
  const c = getAddressDetails(addr).paymentCredential;
  if (!c || c.type !== "Key") throw new Error(`${addr} is not a key address.`);
  return c.hash;
};

/**
 * Where reference scripts are parked: the address of a native script no
 * transaction can ever satisfy (the same lock Tessera uses), so they can
 * never be spent, not even by the operator's own wallet.
 */
export function refLockAddress(network: Network): string {
  return validatorToAddress(network, scriptFromNative({ type: "any", scripts: [] }));
}

export function docsHash(text = TEST_DOCS_TEXT): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Derive the offering's scripts from its seed UTxO. */
export function deriveTestOffering(
  seed: { txHash: string; outputIndex: number },
  network: Network,
  opts: TestOfferingOptions = TEST_OFFERING,
  unit = PREPROD_TSRA,
): V2Scripts {
  return deriveV2(L as never, opts.assetId, unit, seed, network as never);
}

/**
 * The opening State. On Preprod the operator holds the test roles (issuer,
 * keeper, treasury, SPV payout); the offering committee is separate keys.
 */
export function testOpeningState(
  scripts: V2Scripts,
  roles: { operatorAddress: string; committee: string[]; threshold: number },
  nowMs: number,
  opts: TestOfferingOptions = TEST_OFFERING,
): V2State {
  const op = keyHash(roles.operatorAddress);
  const state: V2State = {
    status: "raising",
    terms: {
      totalFractions: opts.totalFractions,
      softCap: opts.softCap,
      price: opts.price,
      deadline: BigInt(nowMs + opts.deadlineDays * DAY),
      settleWindow: BigInt(opts.settleWindowDays * DAY),
      retained: 0n,
      docsHash: docsHash(),
      spvPayout: { type: "key", hash: op },
      treasury: op,
      issuer: op,
      keeper: op,
      fractionPolicy: scripts.fraction.policyId,
      eligibilityPolicy: null,
      unitPolicy: scripts.unit.policyId,
      unitName: scripts.unit.assetNameHex,
    },
    book: EMPTY_BOOK,
    feeBps: opts.feeBps,
    period: 0n,
    manifestRoot: "",
    committee: roles.committee.map((k) => k.toLowerCase()),
    threshold: roles.threshold,
  };
  checkOpening(state, BigInt(nowMs));
  return state;
}

export interface Stage {
  name: "refs" | "open";
  tx: TxSignBuilder;
  intent: TxIntent;
  record: Record<string, unknown>;
}

/** Lovelace parked with each reference script (above its min-ADA). */
export const REF_LOVELACE = { offering: 40_000_000n, pledge: 25_000_000n, fraction: 10_000_000n };

/** Publish the three scripts as reference scripts at the lock address. */
export async function buildRefsStage(lucid: LucidEvolution, scripts: V2Scripts): Promise<Stage> {
  const lock = refLockAddress(scripts.network as Network);
  const v3 = (script: string) => ({ type: "PlutusV3" as const, script });
  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      lock,
      undefined,
      { lovelace: REF_LOVELACE.offering },
      v3(scripts.offering.cbor),
    )
    .pay.ToAddressWithData(
      lock,
      undefined,
      { lovelace: REF_LOVELACE.pledge },
      v3(scripts.pledge.cbor),
    )
    .pay.ToAddressWithData(
      lock,
      undefined,
      { lovelace: REF_LOVELACE.fraction },
      v3(scripts.fraction.cbor),
    )
    .complete();
  const total = REF_LOVELACE.offering + REF_LOVELACE.pledge + REF_LOVELACE.fraction;
  const h = tx.toHash();
  return {
    name: "refs",
    tx,
    intent: {
      action: "offering_v2.publishRefs",
      pay: [lock],
      spend: { lovelace: total },
      allowScriptRefs: true,
    },
    record: {
      lockAddress: lock,
      offering: `${h}#0`,
      pledge: `${h}#1`,
      fraction: `${h}#2`,
      lovelaceLocked: total.toString(),
    },
  };
}

/** Open the offering: consume the seed, mint the thread token, pay the State. */
export async function buildOpenStage(
  lucid: LucidEvolution,
  scripts: V2Scripts,
  seedUtxo: UTxO,
  state: V2State,
  signers: string[],
  nowMs: number,
): Promise<Stage> {
  const ctx: V2Context = { lucid, mod: L as unknown as LucidModTx, scripts };
  const built = await buildOpen(ctx, seedUtxo, state, signers, nowMs);
  const t = state.terms;
  return {
    name: "open",
    tx: built.tx,
    intent: built.intent,
    record: {
      assetId: scripts.assetId,
      seed: { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex },
      offeringHash: scripts.offering.hash,
      offeringAddress: scripts.offering.address,
      threadUnit: scripts.offering.threadUnit,
      pledgeHash: scripts.pledge.hash,
      pledgeAddress: scripts.pledge.address,
      pledgeMarkerUnit: scripts.pledge.markerUnit,
      fractionPolicy: scripts.fraction.policyId,
      fractionUnit: scripts.fraction.unit,
      depositUnit: scripts.depositUnit,
      stateRiderLovelace: STATE_RIDER.toString(),
      terms: {
        totalFractions: t.totalFractions.toString(),
        softCap: t.softCap.toString(),
        price: t.price.toString(),
        deadline: new Date(Number(t.deadline)).toISOString(),
        deadlineMs: t.deadline.toString(),
        settleWindowMs: t.settleWindow.toString(),
        retained: t.retained.toString(),
        feeBps: state.feeBps,
        docsHash: t.docsHash,
        docsText: TEST_DOCS_TEXT,
        issuer: t.issuer,
        keeper: t.keeper,
        treasury: t.treasury,
        spvPayout: t.spvPayout.hash,
      },
      committee: state.committee,
      threshold: state.threshold,
    },
  };
}

/** Run the S1 intent guard on a stage as the selected wallet. */
export async function guard(lucid: LucidEvolution, stage: Stage): Promise<void> {
  await assertIntent(stage.tx.toCBOR(), stage.intent, await walletViewOf(lucid));
}

/** A seed for Open: a pure-ADA wallet UTxO (so the seed carries no tokens). */
export function pickSeed(utxos: UTxO[]): UTxO {
  const pure = utxos
    .filter((u) => Object.keys(u.assets).every((k) => k === "lovelace"))
    .sort((a, b) => Number((b.assets.lovelace ?? 0n) - (a.assets.lovelace ?? 0n)));
  if (!pure[0]) throw new Error("The operator wallet has no ADA-only UTxO to use as the seed.");
  return pure[0];
}
