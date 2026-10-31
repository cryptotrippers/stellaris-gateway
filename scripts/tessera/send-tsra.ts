/**
 * Operator script: send test TSRA (and tADA for fees) to tester wallets on Preprod.
 *
 *   npx tsx scripts/tessera/send-tsra.ts --to <addr_test1…> [--to <addr> …] [--tsra 1000] [--ada 25]
 *       dry run (default): checks the addresses and the operator's balance and
 *       builds the transaction. Nothing signed.
 *   ... --submit
 *       signs with the operator wallet, submits and waits for confirmation.
 *
 * Every recipient gets the same amounts. Per-tester cap 5,000 TSRA unless
 * --cap <TSRA> raises it. Only wallet (key) addresses on Preprod.
 *
 * Log: logs/tester-sends.jsonl (git-ignored: tester addresses stay out of the repo).
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 * Preprod only. Test TSRA only — no monetary value.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { Blockfrost, CML, Lucid } from "@lucid-evolution/lucid";
import { ada, makeDie, preprodKey, selectOperator } from "./lib/cli";
import { tsraToUnits } from "./lib/genesis";
import { DEFAULT_ADA, DEFAULT_CAP_TSRA, buildSend, recipientProblems } from "./lib/send";
import { TESSERA_PREPROD } from "../../src/lib/tessera-preprod";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[send-tsra]");

const argv = process.argv.slice(2);
const values = (name: string) =>
  argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? die(`${name} needs a value`)] : []));
const one = (name: string) => values(name)[0];
const SUBMIT = argv.includes("--submit");
const TO = values("--to").map((s) => s.trim());
const TSRA = tsraToUnits(one("--tsra") ?? "1000");
const LOVELACE = BigInt(one("--ada") ?? String(DEFAULT_ADA)) * 1_000_000n;
const CAP = tsraToUnits(one("--cap") ?? String(DEFAULT_CAP_TSRA));
const UNIT = TESSERA_PREPROD.reserve.tsraUnit;
const short = (a: string) => `${a.slice(0, 20)}…${a.slice(-6)}`;

const recipients = TO.map((address) => ({ address, tsra: TSRA, lovelace: LOVELACE }));
const problems = recipientProblems(recipients, CAP);
if (problems.length) die(problems.join("\n"));
const KEY = preprodKey(die);

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const utxos = await lucid.wallet().getUtxos();
  const haveT = utxos.reduce((a, u) => a + (u.assets[UNIT] ?? 0n), 0n);
  const haveL = utxos.reduce((a, u) => a + (u.assets.lovelace ?? 0n), 0n);
  const needT = TSRA * BigInt(recipients.length);
  const needL = LOVELACE * BigInt(recipients.length);
  console.log(`== Send test TSRA (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator   ${operator}`);
  console.log(`has        ${(Number(haveT) / 1e6).toLocaleString()} TSRA · ${ada(haveL)}`);
  for (const r of recipients)
    console.log(
      `to         ${short(r.address)}  ${(Number(r.tsra) / 1e6).toLocaleString()} TSRA + ${ada(r.lovelace)}`,
    );
  if (haveT < needT) die(`Not enough TSRA: need ${Number(needT) / 1e6}.`);
  if (haveL < needL + 10_000_000n) die("Not enough tADA (keep 10 tADA spare for fees).");

  const tx = await buildSend(lucid, UNIT, recipients);
  const fee = CML.Transaction.from_cbor_hex(tx.toCBOR()).body().fee();
  console.log(`fee        ${ada(fee)}`);
  if (!SUBMIT) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }
  const hash = await (await tx.sign.withWallet().complete()).submit();
  console.log(`\nsubmitted  ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`);
  mkdirSync("logs", { recursive: true });
  const log = (status: string) =>
    appendFileSync(
      "logs/tester-sends.jsonl",
      JSON.stringify({
        at: new Date().toISOString(),
        tx: hash,
        status,
        recipients: recipients.map((r) => ({
          address: r.address,
          tsra: r.tsra.toString(),
          lovelace: r.lovelace.toString(),
        })),
      }) + "\n",
    );
  log("submitted");
  if (!(await lucid.awaitTx(hash, 5_000))) die("Not confirmed yet; check the link above.");
  log("confirmed");
  console.log("confirmed. The wallet shows it within a minute.");
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
