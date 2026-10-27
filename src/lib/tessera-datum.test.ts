import { test } from "node:test";
import assert from "node:assert/strict";
import { CML, Constr, Data } from "@lucid-evolution/lucid";
import { decodeTesseraDatum, tesseraAddressToBech32 } from "./tessera-datum.shared";

test("Worker-safe Tessera decoder preserves Lucid values and bigint precision", () => {
  const value = new Constr(0, [
    new Constr(9, [9_007_199_254_740_993n, -10n, "abcd", [1n, 2n]]),
    new Map([["aa", 3n]]),
  ]);
  const hex = Data.to(value);
  assert.deepEqual(decodeTesseraDatum(hex), Data.from(hex));
});

for (const paymentScript of [false, true]) {
  for (const stakeScript of [null, false, true]) {
    test(`Preprod address matches CML: payment script ${paymentScript}, stake script ${stakeScript}`, () => {
      const payHash = "12".repeat(28);
      const stakeHash = "34".repeat(28);
      const pay = paymentScript
        ? CML.Credential.new_script(CML.ScriptHash.from_hex(payHash))
        : CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(payHash));
      const stake = stakeScript
        ? CML.Credential.new_script(CML.ScriptHash.from_hex(stakeHash))
        : CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stakeHash));
      const value = new Constr(0, [
        new Constr(paymentScript ? 1 : 0, [payHash]),
        stakeScript === null
          ? new Constr(1, [])
          : new Constr(0, [new Constr(0, [new Constr(stakeScript ? 1 : 0, [stakeHash])])]),
      ]);
      const expected = stakeScript === null
        ? CML.EnterpriseAddress.new(0, pay).to_address().to_bech32()
        : CML.BaseAddress.new(0, pay, stake).to_address().to_bech32();
      assert.equal(tesseraAddressToBech32(value), expected);
    });
  }
}

test("Malformed address credentials fail rather than fabricating an address", () => {
  assert.throws(() => tesseraAddressToBech32(new Constr(0, [
    new Constr(0, ["bad"]), new Constr(1, []),
  ])), /Invalid address credential/);
});