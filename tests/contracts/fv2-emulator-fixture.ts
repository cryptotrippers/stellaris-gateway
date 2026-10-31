/**
 * E07 — shared Emulator fixture for the fraction_vault v2 tests: one
 * TSRA-denominated offering opened with the real compiled scripts, a
 * three-member committee (2-of-3), a keeper, a treasury, an SPV and investors.
 * Test-only.
 */
import assert from "node:assert/strict";
import * as L from "@lucid-evolution/lucid";
import {
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  getAddressDetails,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";
import { deriveV2, type V2Scripts } from "../../src/lib/fraction-vault-v2";
import { EMPTY_BOOK, type V2State } from "../../src/lib/offering-v2-chain";
import {
  buildOpen,
  buildPledge,
  type Built,
  type LucidModTx,
  type V2Context,
} from "../../src/lib/offering-v2-tx";
import { assertIntent, walletViewOf } from "../../src/lib/tx-sign-guarded";

export const TSRA_POLICY = "938b32e0".padEnd(56, "7");
export const TSRA_NAME = "54535241"; // "TSRA"
export const TSRA = `${TSRA_POLICY}${TSRA_NAME}`;
export const T = (n: number) => BigInt(n) * 1_000_000n; // whole TSRA, 6 decimals
export const ADA = 1_000_000n;
/** A token nobody reviewed, for token-flood attempts. */
export const JUNK = `${"6a".repeat(28)}4a554e4b`;

export const keyHash = (a: string) => getAddressDetails(a).paymentCredential!.hash;
export type Account = ReturnType<typeof generateEmulatorAccountFromPrivateKey>;

const acct = (lovelace: bigint, tsra = 0n): Account =>
  generateEmulatorAccountFromPrivateKey(tsra ? { lovelace, [TSRA]: tsra } : { lovelace });

export interface World {
  emulator: Emulator;
  lucid: LucidEvolution;
  issuer: Account;
  committee: Account[];
  keeper: Account;
  treasury: Account;
  spv: Account;
  investors: Account[];
  /** An attacker with ADA, TSRA and junk tokens. */
  mallory: Account;
  scripts: V2Scripts;
  ctx: V2Context;
  boardKeys: string[];
}

/** Sign as `wallet` plus `cosigners`, after the intent guard has passed. */
export async function run(w: World, wallet: Account, built: Built, cosigners: Account[] = []) {
  w.lucid.selectWallet.fromPrivateKey(wallet.privateKey);
  await assertIntent(built.tx.toCBOR(), built.intent, await walletViewOf(w.lucid));
  let s = built.tx.sign.withWallet();
  for (const c of cosigners) s = s.sign.withPrivateKey(c.privateKey);
  const hash = await (await s.complete()).submit();
  w.emulator.awaitBlock(1);
  assert.ok(await w.lucid.awaitTx(hash), "confirmed");
  return hash;
}

/** As `wallet`: select it before building so coin selection uses its UTxOs. */
export function as(w: World, a: Account) {
  w.lucid.selectWallet.fromPrivateKey(a.privateKey);
  return w.ctx;
}

export async function setup(opts: { investors?: number; windowMs?: number } = {}): Promise<World> {
  const issuer = acct(5_000n * ADA, T(1_000_000));
  const committee = [acct(100n * ADA), acct(100n * ADA), acct(100n * ADA)];
  const keeper = acct(500n * ADA);
  const treasury = acct(10n * ADA);
  const spv = acct(10n * ADA);
  const investors = Array.from({ length: opts.investors ?? 3 }, () => acct(200n * ADA, T(100_000)));
  const mallory = generateEmulatorAccountFromPrivateKey({
    lovelace: 500n * ADA,
    [TSRA]: T(100_000),
    [JUNK]: 1_000n,
  });
  const emulator = new Emulator([
    issuer,
    ...committee,
    keeper,
    treasury,
    spv,
    ...investors,
    mallory,
  ]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(issuer.privateKey);
  const seedUtxo = (await lucid.wallet().getUtxos())[0]!;
  const scripts = deriveV2(
    L as never,
    "ph-solar-01",
    { policyId: TSRA_POLICY, assetNameHex: TSRA_NAME },
    { txHash: seedUtxo.txHash, outputIndex: seedUtxo.outputIndex },
    "Custom",
  );
  const ctx: V2Context = { lucid, mod: L as unknown as LucidModTx, scripts };
  const boardKeys = committee.map((c) => keyHash(c.address));
  const w: World = {
    emulator,
    lucid,
    issuer,
    committee,
    keeper,
    treasury,
    spv,
    investors,
    mallory,
    scripts,
    ctx,
    boardKeys,
  };

  const now = emulator.now();
  const state: V2State = {
    status: "raising",
    terms: {
      totalFractions: 1_000n,
      softCap: 400n,
      price: T(10),
      deadline: BigInt(now + 3_600_000),
      settleWindow: BigInt(opts.windowMs ?? 600_000),
      retained: 0n,
      docsHash: "d0".repeat(32),
      spvPayout: { type: "key", hash: keyHash(spv.address) },
      treasury: keyHash(treasury.address),
      issuer: keyHash(issuer.address),
      keeper: keyHash(keeper.address),
      fractionPolicy: scripts.fraction.policyId,
      eligibilityPolicy: null,
      unitPolicy: TSRA_POLICY,
      unitName: TSRA_NAME,
    },
    book: EMPTY_BOOK,
    feeBps: 100,
    period: 0n,
    manifestRoot: "",
    committee: boardKeys,
    threshold: 2,
  };
  const open = await buildOpen(
    ctx,
    seedUtxo,
    state,
    [keyHash(issuer.address), ...boardKeys.slice(0, 2)],
    now,
  );
  await run(w, issuer, open, committee.slice(0, 2));
  return w;
}

/** Each investor i pledges qtys[i] fractions (one pledge each). */
export async function pledgeAll(w: World, qtys: bigint[]) {
  for (const [i, q] of qtys.entries()) {
    const inv = w.investors[i % w.investors.length]!;
    await run(w, inv, await buildPledge(as(w, inv), inv.address, q, w.emulator.now()));
  }
}

export const tsraOf = (u: UTxO[]) => u.reduce((a, x) => a + (x.assets[TSRA] ?? 0n), 0n);

/** Sum of the execution units the builder set on every redeemer. */
export function txBudget(cbor: string): { mem: bigint; cpu: bigint; bytes: number } {
  const tx = L.CML.Transaction.from_cbor_hex(cbor);
  const rs = tx.witness_set().redeemers();
  let mem = 0n;
  let cpu = 0n;
  if (rs) {
    const legacy = rs.as_arr_legacy_redeemer();
    if (legacy) {
      for (let i = 0; i < legacy.len(); i++) {
        const u = legacy.get(i).ex_units();
        mem += u.mem();
        cpu += u.steps();
      }
    }
    const map = rs.as_map_redeemer_key_to_redeemer_val();
    if (map) {
      const keys = map.keys();
      for (let i = 0; i < keys.len(); i++) {
        const u = map.get(keys.get(i))!.ex_units();
        mem += u.mem();
        cpu += u.steps();
      }
    }
  }
  return { mem, cpu, bytes: cbor.length / 2 };
}

/** Conway per-transaction limits. */
export const TX_MAX = { mem: 14_000_000n, cpu: 10_000_000_000n, bytes: 16_384 };
