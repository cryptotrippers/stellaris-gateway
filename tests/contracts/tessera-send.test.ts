/**
 * Sending test TSRA to testers (scripts/tessera/lib/send.ts): the address and
 * amount checks, and one transaction paying two testers on the emulator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  Emulator,
  Lucid,
  generateEmulatorAccountFromPrivateKey,
  scriptFromNative,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { buildSend, recipientProblems } from "../../scripts/tessera/lib/send";

const UNIT = `${"93".repeat(28)}54535241`;
const T = (n: number) => BigInt(n) * 1_000_000n;

test("send: refuses mainnet, script, duplicate, over-cap and rider-less recipients", () => {
  const a = generateEmulatorAccountFromPrivateKey({ lovelace: 1n }).address;
  const script = validatorToAddress("Preprod", scriptFromNative({ type: "any", scripts: [] }));
  const ok = { address: a, tsra: T(1000), lovelace: 25_000_000n };
  assert.deepEqual(recipientProblems([ok], T(5000)), []);
  const p = recipientProblems(
    [
      { ...ok, address: "addr1qxy" },
      { ...ok, address: script },
      ok,
      ok,
      {
        ...ok,
        address: generateEmulatorAccountFromPrivateKey({ lovelace: 1n }).address,
        tsra: T(6000),
      },
      {
        ...ok,
        address: generateEmulatorAccountFromPrivateKey({ lovelace: 1n }).address,
        lovelace: 1n,
      },
    ],
    T(5000),
  ).join("\n");
  assert.match(p, /not a Preprod/);
  assert.match(p, /script address/);
  assert.match(p, /listed twice/);
  assert.match(p, /per-tester cap/);
  assert.match(p, /at least 2 tADA/);
  assert.match(recipientProblems([], T(1)).join(), /No recipients/);
});

test("send: one transaction pays each tester its TSRA and tADA", async () => {
  const op = generateEmulatorAccountFromPrivateKey({ lovelace: 500_000_000n, [UNIT]: T(9000) });
  const t1 = generateEmulatorAccountFromPrivateKey({ lovelace: 1_000_000n });
  const t2 = generateEmulatorAccountFromPrivateKey({ lovelace: 1_000_000n });
  const emulator = new Emulator([op, t1, t2]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(op.privateKey);
  const tx = await buildSend(lucid, UNIT, [
    { address: t1.address, tsra: T(1000), lovelace: 25_000_000n },
    { address: t2.address, tsra: T(1000), lovelace: 25_000_000n },
  ]);
  const h = await (await tx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);
  assert.ok(await lucid.awaitTx(h));
  for (const t of [t1, t2]) {
    const us = await lucid.utxosAt(t.address);
    assert.equal(
      us.reduce((a, u) => a + (u.assets[UNIT] ?? 0n), 0n),
      T(1000),
    );
    assert.equal(
      us.reduce((a, u) => a + u.assets.lovelace!, 0n),
      26_000_000n,
    );
  }
});
