/**
 * Security Suite S1.6 — the sign guard must ask the confirmation handler
 * before the wallet is touched, and must obey the answer.
 *
 * Builds a real transaction with Lucid Evolution's in-memory Emulator (no
 * network, no keys outside the test) and runs it through signGuarded, the same
 * door every builder in this app uses.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  Emulator,
  Lucid,
  generateEmulatorAccount,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { setTxConfirmHandler, signGuarded, walletViewOf } from "../../lib/tx-sign-guarded";
import { trustDerivedScript } from "../../lib/tx-trust.shared";

const ADA = 1_000_000n;
type L = Awaited<ReturnType<typeof Lucid>>;

let lucid: L;
let wallet: Awaited<ReturnType<typeof walletViewOf>>;
let vault: { address: string; hash: string };

const depositTx = () =>
  lucid.newTx().pay.ToAddress(vault.address, { lovelace: 10n * ADA }).complete();
const depositIntent = () => ({
  action: "vault.deposit",
  pay: [vault.address],
  spend: { lovelace: 10n * ADA },
});

describe("the confirmation step in front of the wallet", () => {
  before(async () => {
    const user = generateEmulatorAccount({ lovelace: 1_000n * ADA });
    lucid = await Lucid(new Emulator([user]), "Custom");
    lucid.selectWallet.fromSeed(user.seedPhrase);
    const vaultScript = scriptFromNative({ type: "after", slot: 1 });
    vault = {
      address: validatorToAddress("Preprod", vaultScript),
      hash: validatorToScriptHash(vaultScript),
    };
    trustDerivedScript(vault.hash, "vault:test");
    wallet = await walletViewOf(lucid as never);
  });

  test("the guard asks first, and shows what the transaction will do", async () => {
    const asked: Array<{ action: string; lines: readonly string[] }> = [];
    setTxConfirmHandler(async (action, lines) => {
      asked.push({ action, lines });
      return true;
    });
    try {
      const tx = await depositTx();
      await signGuarded(lucid as never, tx as never, depositIntent());
    } finally {
      setTxConfirmHandler(null);
    }
    assert.equal(asked.length, 1);
    assert.equal(asked[0].action, "vault.deposit");
    assert.ok(
      asked[0].lines.some((l) => l.includes("10.000000 ADA") && l.includes("vault:test")),
      asked[0].lines.join(" | "),
    );
    assert.ok(asked[0].lines.some((l) => l.startsWith("Network fee ")), asked[0].lines.join(" | "));
  });

  test("answering no stops the transaction before the wallet signs", async () => {
    setTxConfirmHandler(async () => false);
    try {
      const tx = await depositTx();
      await assert.rejects(
        () => signGuarded(lucid as never, tx as never, depositIntent()),
        /Cancelled before signing/,
      );
    } finally {
      setTxConfirmHandler(null);
    }
  });
});
