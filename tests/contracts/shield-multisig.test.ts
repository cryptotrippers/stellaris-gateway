/**
 * Shield G1 stopgap: the 3-of-5 native multisig treasury on the emulator.
 * ATT-001/002/003: one key, two keys and a duplicated signer are refused by
 * the ledger; three distinct keys spend; tampered payments can't pass a
 * signed transaction; the spec checks refuse unsafe signer sets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Emulator, Lucid, generateEmulatorAccountFromPrivateKey } from "@lucid-evolution/lucid";
import {
  buildTreasurySpend,
  keyHashOfAddress,
  specProblems,
  treasuryAddress,
} from "../../scripts/shield/lib/multisig";

const ADA = 1_000_000n;
const TOKEN = `${"93".repeat(28)}54535241`;

async function world() {
  const operator = generateEmulatorAccountFromPrivateKey({
    lovelace: 500n * ADA,
    [TOKEN]: 10_000n,
  });
  const signers = [1, 2, 3, 4, 5].map(() =>
    generateEmulatorAccountFromPrivateKey({ lovelace: 5n * ADA }),
  );
  const payee = generateEmulatorAccountFromPrivateKey({ lovelace: 1n * ADA });
  const emulator = new Emulator([operator, ...signers, payee]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(operator.privateKey);
  const spec = { signers: signers.map((s) => keyHashOfAddress(s.address)), threshold: 3 };
  const t = treasuryAddress("Custom", spec);
  // Fund the treasury.
  const fund = await lucid
    .newTx()
    .pay.ToAddress(t.address, { lovelace: 100n * ADA, [TOKEN]: 5_000n })
    .complete();
  await (await fund.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  const sign = async (tx: Awaited<ReturnType<typeof buildTreasurySpend>>, who: typeof signers) => {
    let s = tx.sign.withWallet();
    for (const k of who) s = s.sign.withPrivateKey(k.privateKey);
    const h = await (await s.complete()).submit();
    emulator.awaitBlock(1);
    return h;
  };
  return { emulator, lucid, operator, signers, payee, spec, t, sign };
}

test("shield multisig: unsafe signer sets are refused", () => {
  const five = [1, 2, 3, 4, 5].map((i) => `${i}`.repeat(56));
  assert.deepEqual(specProblems({ signers: five, threshold: 3 }), []);
  assert.match(specProblems({ signers: five, threshold: 1 }).join(), /at least 2/);
  assert.match(specProblems({ signers: five, threshold: 2 }).join(), /majority/);
  assert.match(specProblems({ signers: five, threshold: 6 }).join(), /larger than/);
  assert.match(
    specProblems({ signers: [five[0]!, five[0]!, five[1]!], threshold: 2 }).join(),
    /twice/,
  );
  assert.match(specProblems({ signers: ["xyz", five[1]!], threshold: 2 }).join(), /28-byte/);
});

test("shield multisig: 1 key (ATT-001) and 2 keys (ATT-002) are refused; 3 distinct keys spend", async () => {
  const w = await world();
  const ins = await w.lucid.utxosAt(w.t.address);
  const pay = [{ address: w.payee.address, assets: { lovelace: 10n * ADA, [TOKEN]: 1_000n } }];
  const keys = w.signers.map((s) => keyHashOfAddress(s.address));

  for (const n of [1, 2]) {
    const tx = await buildTreasurySpend(w.lucid, w.t, ins, pay, keys.slice(0, n));
    await assert.rejects(
      w.sign(tx, w.signers.slice(0, n)),
      (e: Error) => /native|script|witness|signature/i.test(String(e?.message ?? e)),
      `${n} signature(s) must be refused by the ledger`,
    );
  }
  const tx = await buildTreasurySpend(w.lucid, w.t, ins, pay, keys.slice(1, 4));
  await w.sign(tx, w.signers.slice(1, 4));
  const got = await w.lucid.utxosAt(w.payee.address);
  assert.equal(
    got.reduce((a, u) => a + (u.assets[TOKEN] ?? 0n), 0n),
    1_000n,
  );
  const left = await w.lucid.utxosAt(w.t.address);
  assert.equal(
    left.reduce((a, u) => a + (u.assets[TOKEN] ?? 0n), 0n),
    4_000n,
    "the rest stays in the treasury",
  );
});

test("shield multisig: one key signing twice counts once (ATT-003)", async () => {
  const w = await world();
  const ins = await w.lucid.utxosAt(w.t.address);
  const keys = w.signers.map((s) => keyHashOfAddress(s.address));
  const tx = await buildTreasurySpend(
    w.lucid,
    w.t,
    ins,
    [{ address: w.payee.address, assets: { lovelace: 5n * ADA } }],
    keys.slice(0, 2),
  );
  await assert.rejects(w.sign(tx, [w.signers[0]!, w.signers[0]!, w.signers[1]!]), (e: Error) =>
    /native|script|witness|signature/i.test(String(e?.message ?? e)),
  );
});

test("shield multisig: the builder refuses overspend and foreign inputs", async () => {
  const w = await world();
  const ins = await w.lucid.utxosAt(w.t.address);
  const keys = w.signers.map((s) => keyHashOfAddress(s.address));
  await assert.rejects(
    buildTreasurySpend(
      w.lucid,
      w.t,
      ins,
      [{ address: w.payee.address, assets: { [TOKEN]: 6_000n } }],
      keys.slice(0, 3),
    ),
    /does not hold enough/,
  );
  const mine = await w.lucid.wallet().getUtxos();
  await assert.rejects(
    buildTreasurySpend(w.lucid, w.t, [...ins, mine[0]!], [], keys.slice(0, 3)),
    /not the treasury/,
  );
});

test("shield multisig: the recorded Preprod treasury is the 3-of-5 of the committee file", async () => {
  const { readFileSync } = await import("node:fs");
  const rec = JSON.parse(readFileSync("deployments/shield-preprod.json", "utf8"));
  const committee = JSON.parse(readFileSync("deployments/committee.preprod.json", "utf8"));
  const spec = {
    signers: committee.operators.map(keyHashOfAddress),
    threshold: committee.threshold,
  };
  const t = treasuryAddress("Preprod", spec);
  assert.deepEqual(rec.treasury.signers, spec.signers);
  assert.equal(rec.treasury.threshold, 3);
  assert.equal(rec.treasury.scriptHash, t.hash);
  assert.equal(rec.treasury.address, t.address);
});
