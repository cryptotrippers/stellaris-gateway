/**
 * Security Suite S1 — intent guard tests.
 * Run: npx tsx --test src/lib/tx-intent-guard.test.ts
 *
 * Real transactions are built with Lucid Evolution's in-memory Emulator (no
 * network, no keys outside the test), decoded with CML and checked. Shapes the
 * Emulator cannot build (withdrawals, governance, foreign collateral) are
 * checked on decoded fixtures.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CML,
  Emulator,
  Lucid,
  generateEmulatorAccount,
  getAddressDetails,
  mintingPolicyToId,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import {
  checkTx,
  decodeTx,
  summariseTx,
  TxIntentRejected,
  type DecodedTx,
  type TxIntent,
  type WalletView,
} from "./tx-intent-guard.shared";
import { trustOf, type TrustView } from "./tx-trust.shared";
import { assertIntent, signGuarded, walletViewOf } from "./tx-sign-guarded";
import { DEPLOYED_ALLOWLIST } from "./tx-allowlist.generated";
// @ts-expect-error plain .mjs generator without types
import { generate } from "../../scripts/security/gen-tx-allowlist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADA = 1_000_000n;
type L = Awaited<ReturnType<typeof Lucid>>;

let lucid: L;
let wallet: WalletView;
let userKey: string;
let attacker: { address: string; key: string };
let vault: { address: string; hash: string };
let rogue: { address: string; hash: string };
let policy: { id: string; script: ReturnType<typeof scriptFromNative> };
let rogueMint: { id: string; script: ReturnType<typeof scriptFromNative> };
let trusted: TrustView;

const codes = (tx: DecodedTx, intent: TxIntent, t: TrustView = trusted) =>
  checkTx(tx, intent, wallet, t).map((x) => x.code);
const decode = (cbor: string) => decodeTx(CML, cbor);

before(async () => {
  const user = generateEmulatorAccount({ lovelace: 1_000n * ADA });
  const other = generateEmulatorAccount({ lovelace: 5n * ADA });
  lucid = await Lucid(new Emulator([user, other]), "Custom");
  lucid.selectWallet.fromSeed(user.seedPhrase);
  userKey = getAddressDetails(user.address).paymentCredential!.hash;
  const otherKey = getAddressDetails(other.address).paymentCredential!.hash;
  attacker = { address: other.address, key: otherKey };

  // Stand-in "vault" and "rogue" scripts: native scripts give real script
  // addresses without compiling Plutus.
  const vaultScript = scriptFromNative({ type: "after", slot: 1 });
  const rogueScript = scriptFromNative({ type: "after", slot: 2 });
  vault = {
    address: validatorToAddress("Preprod", vaultScript),
    hash: validatorToScriptHash(vaultScript),
  };
  rogue = {
    address: validatorToAddress("Preprod", rogueScript),
    hash: validatorToScriptHash(rogueScript),
  };
  const p = scriptFromNative({ type: "sig", keyHash: userKey });
  policy = { id: mintingPolicyToId(p), script: p };
  const r = scriptFromNative({ type: "any", scripts: [{ type: "sig", keyHash: userKey }] });
  rogueMint = { id: mintingPolicyToId(r), script: r };

  trusted = trustOf({ scripts: { [vault.hash]: "vault:test", [policy.id]: "receipt:test" } });
  wallet = await walletViewOf(lucid as never);
});

const deposit = (lovelace: bigint) => lucid.newTx().pay.ToAddress(vault.address, { lovelace });
const DEPOSIT: TxIntent = {
  action: "vault.deposit",
  pay: [] as string[],
  spend: { lovelace: 10n * ADA },
};
const depositIntent = (): TxIntent => ({ ...DEPOSIT, pay: [vault.address] });

describe("allowed transactions pass", () => {
  test("a declared deposit to a reviewed script passes", async () => {
    const tx = decode((await deposit(10n * ADA).complete()).toCBOR());
    assert.deepEqual(codes(tx, depositIntent()), []);
  });

  test("a declared mint under a reviewed policy, paid to the wallet, passes", async () => {
    const unit = policy.id + "6162";
    const tx = decode(
      (
        await lucid
          .newTx()
          .mintAssets({ [unit]: 5n })
          .attach.MintingPolicy(policy.script)
          .complete()
      ).toCBOR(),
    );
    assert.deepEqual(codes(tx, { action: "mint", mint: { [unit]: 5n } }), []);
  });

  test("decoding reads addresses, amounts and tokens exactly", async () => {
    const unit = policy.id + "6162";
    const tx = decode(
      (
        await lucid
          .newTx()
          .mintAssets({ [unit]: 7n })
          .attach.MintingPolicy(policy.script)
          .pay.ToAddress(vault.address, { lovelace: 3n * ADA, [unit]: 7n })
          .complete()
      ).toCBOR(),
    );
    const out = tx.outputs.find((o) => o.address === vault.address)!;
    assert.equal(out.assets.lovelace, 3n * ADA);
    assert.equal(out.assets[unit], 7n);
    assert.equal(out.paymentKind, "script");
    assert.equal(out.paymentHash, vault.hash);
    assert.equal(tx.mint[unit], 7n);
  });
});

describe("hostile transactions are refused (S1.5)", () => {
  test("1. extra output to an undeclared address", async () => {
    const tx = decode(
      (
        await deposit(10n * ADA)
          .pay.ToAddress(attacker.address, { lovelace: 2n * ADA })
          .complete()
      ).toCBOR(),
    );
    assert.ok(codes(tx, depositIntent()).includes("unexpected_destination"));
  });

  test("2. vault address swapped for another script", async () => {
    const tx = decode(
      (
        await lucid
          .newTx()
          .pay.ToAddress(rogue.address, { lovelace: 10n * ADA })
          .complete()
      ).toCBOR(),
    );
    assert.ok(codes(tx, depositIntent()).includes("unexpected_destination"));
  });

  test("3. tampered parameters declare an unreviewed script", async () => {
    const tx = decode(
      (
        await lucid
          .newTx()
          .pay.ToAddress(rogue.address, { lovelace: 10n * ADA })
          .complete()
      ).toCBOR(),
    );
    assert.ok(codes(tx, { ...depositIntent(), pay: [rogue.address] }).includes("untrusted_script"));
  });

  test("4. surprise mint under an unreviewed policy", async () => {
    const unit = rogueMint.id + "ff";
    const tx = decode(
      (
        await deposit(10n * ADA)
          .mintAssets({ [unit]: 1n })
          .attach.MintingPolicy(rogueMint.script)
          .complete()
      ).toCBOR(),
    );
    const c = codes(tx, depositIntent());
    assert.ok(c.includes("unexpected_mint") && c.includes("untrusted_policy"));
  });

  test("5. inflated amount", async () => {
    const tx = decode((await deposit(50n * ADA).complete()).toCBOR());
    assert.ok(codes(tx, depositIntent()).includes("overspend"));
  });

  test("6. extra required signer", async () => {
    const tx = decode(
      (
        await deposit(10n * ADA)
          .addSignerKey(attacker.key)
          .complete()
      ).toCBOR(),
    );
    assert.ok(codes(tx, depositIntent()).includes("unexpected_signer"));
  });

  test("7. a declared thread-token mint is missing", async () => {
    const unit = policy.id + "7374617465";
    const tx = decode((await deposit(10n * ADA).complete()).toCBOR());
    assert.ok(codes(tx, { ...depositIntent(), mint: { [unit]: 1n } }).includes("unexpected_mint"));
  });

  test("8. oversized fee", async () => {
    const tx = decode((await deposit(10n * ADA).complete()).toCBOR());
    assert.ok(codes(tx, { ...depositIntent(), maxFee: 1_000n }).includes("fee_too_high"));
  });

  test("9. undeclared reference script on an output", async () => {
    const tx = decode(
      (
        await lucid
          .newTx()
          .pay.ToAddressWithData(
            vault.address,
            undefined,
            { lovelace: 10n * ADA },
            rogueMint.script,
          )
          .complete()
      ).toCBOR(),
    );
    assert.ok(codes(tx, depositIntent()).includes("unexpected_script_ref"));
    assert.ok(
      codes(tx, { ...depositIntent(), allowScriptRefs: true }).includes("untrusted_script"),
    );
  });

  test("10. a co-signed draft that spends the co-signer's wallet", async () => {
    const tx = decode((await deposit(10n * ADA).complete()).toCBOR());
    assert.ok(codes(tx, { ...depositIntent(), coSign: true }).includes("cosign_spends_wallet"));
  });

  test("11. stake certificate the action did not declare", async () => {
    const reward = await lucid.wallet().rewardAddress();
    const tx = decode(
      (
        await deposit(10n * ADA)
          .registerStake(reward!)
          .complete()
      ).toCBOR(),
    );
    assert.ok(
      codes(tx, { ...depositIntent(), spend: { lovelace: 12n * ADA } }).includes(
        "unexpected_certificate",
      ),
    );
  });

  const base = (): DecodedTx => ({
    networkId: null,
    inputs: [],
    referenceInputs: [],
    outputs: [],
    mint: {},
    withdrawals: [],
    certificateCount: 0,
    governanceActionCount: 0,
    requiredSigners: [],
    fee: 200_000n,
    totalCollateral: null,
    collateralReturn: null,
  });

  test("12. hidden withdrawal", () => {
    const tx: DecodedTx = {
      ...base(),
      withdrawals: [
        { address: "stake_test1uxyz", paymentKind: "key", hash: attacker.key, amount: 5n * ADA },
      ],
    };
    assert.ok(codes(tx, depositIntent()).includes("unexpected_withdrawal"));
  });

  test("13. mainnet network id or a mainnet address", () => {
    assert.ok(codes({ ...base(), networkId: 1 }, depositIntent()).includes("wrong_network"));
    const out = {
      address: "addr1qmainnet",
      networkId: 1,
      paymentKind: "key" as const,
      paymentHash: attacker.key,
      assets: { lovelace: ADA },
      scriptRefHash: null,
    };
    assert.ok(
      codes({ ...base(), outputs: [out] }, { ...depositIntent(), pay: ["addr1qmainnet"] }).includes(
        "wrong_network",
      ),
    );
  });

  test("14. governance actions are never signed", () => {
    assert.ok(
      codes(
        { ...base(), governanceActionCount: 1 },
        { ...depositIntent(), allowCertificates: true },
      ).includes("governance_action"),
    );
  });

  test("15. oversized collateral or collateral returned elsewhere", () => {
    const c = codes(
      {
        ...base(),
        totalCollateral: 50n * ADA,
        collateralReturn: {
          address: attacker.address,
          networkId: 0,
          paymentKind: "key",
          paymentHash: attacker.key,
          assets: { lovelace: ADA },
          scriptRefHash: null,
        },
      },
      depositIntent(),
    );
    assert.equal(c.filter((x) => x === "collateral_risk").length, 2);
  });
});

describe("the one door to the wallet", () => {
  test("a rejected transaction never reaches the wallet", async () => {
    const completed = await deposit(10n * ADA)
      .pay.ToAddress(attacker.address, { lovelace: 2n * ADA })
      .complete();
    let walletCalled = false;
    const spy = {
      toCBOR: () => completed.toCBOR(),
      sign: { withWallet: () => ((walletCalled = true), completed.sign.withWallet()) },
      partialSign: { withWallet: async () => ((walletCalled = true), "") },
    };
    await assert.rejects(signGuarded(lucid as never, spy, depositIntent()), TxIntentRejected);
    assert.equal(walletCalled, false);
  });

  test("an allowed transaction is signed and accepted by the chain", async () => {
    const { trustDerivedScript } = await import("./tx-trust.shared");
    trustDerivedScript(vault.hash, "vault:test");
    const completed = await deposit(10n * ADA).complete();
    const signed = await signGuarded(lucid as never, completed, depositIntent());
    const hash = await signed.submit();
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test("assertIntent returns the decoded transaction when it passes", async () => {
    const completed = await deposit(10n * ADA).complete();
    const decoded = await assertIntent(
      completed.toCBOR(),
      depositIntent(),
      await walletViewOf(lucid as never),
      trusted,
    );
    const lines = summariseTx(decoded, wallet, trusted);
    assert.ok(lines.some((l) => l.includes("10.000000 ADA") && l.includes("vault:test")));
  });

  test("no file outside tx-sign-guarded.ts calls the wallet's sign methods", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          !/\.test\.ts$/.test(name) &&
          name !== "tx-sign-guarded.ts"
        ) {
          const src = readFileSync(p, "utf8");
          if (/\b(partialSign|sign)\s*\.\s*withWallet\s*\(/.test(src))
            offenders.push(p.slice(p.indexOf("src")));
        }
      }
    };
    walk(join(here, ".."));
    assert.deepEqual(offenders, []);
  });

  test("the allow-list matches deployments/preprod-v1.json", async () => {
    // Compare content, not layout, so the check also works without Prettier.
    const norm = (x: string) => x.replace(/\s+/g, "").replace(/,([\]}])/g, "$1");
    assert.equal(
      norm(readFileSync(join(here, "tx-allowlist.generated.ts"), "utf8")),
      norm(await generate()),
    );
    assert.ok(DEPLOYED_ALLOWLIST.scripts.length >= 8);
  });
});
