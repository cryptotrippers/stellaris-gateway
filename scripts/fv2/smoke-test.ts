/**
 * Operator script: Preprod smoke test of the fraction_vault v2 TEST offering.
 *
 *   npx tsx scripts/fv2/smoke-test.ts --keys-dir <dir>
 *       dry run (default): checks balances, builds the NEXT pending stage
 *       against the chain as it is, has Blockfrost evaluate its scripts, runs
 *       the S1 intent guard, and lists the stages still to go. Nothing signed.
 *
 *   ... --submit [--until <stage>]
 *       runs the pending stages in order (or up to and including --until),
 *       each built fresh after the previous one confirms, and records each in
 *       deployments/<label>.json under "smoke". Re-running resumes.
 *
 * Stages (scripts/fv2/lib/smoke.ts)
 *   pledge-1..3  pledges of 40, 35 and 30 fractions (1,050 TSRA from the operator)
 *                for three owners: the operator, c1 and c2
 *   settle       the keeper (operator) settles all three: 105 ≥ soft cap 100
 *   close        CloseRaise → Operating            (operator + committee)
 *   release      100 TSRA to the SPV (operator)    (operator + committee)
 *   commit       CommitPeriod 1, test manifest root (operator + committee)
 *   claim        the 1% fee to the treasury (operator) (operator + committee)
 *
 * Options
 *   --keys-dir <dir>   folder with the committee .skey files
 *   --signers c1,c2    committee keys that co-sign (default c1,c2)
 *   --label <name>     deployment label (default fv2-preprod-test)
 *   --until <stage>    stop after this stage
 *   --submit
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 * Preprod only. Test TSRA only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as L from "@lucid-evolution/lucid";
import { Blockfrost, CML, Lucid, credentialToAddress } from "@lucid-evolution/lucid";
import {
  ada,
  args,
  git,
  keyHashOf,
  makeDie,
  preprodKey,
  selectOperator,
  skeyFileToBech32,
} from "../tessera/lib/cli";
import { PREPROD_TSRA, deriveTestOffering, guard, walletCaughtUp } from "./lib/bootstrap";
import {
  COMMITTEE_STAGES,
  SMOKE_PLEDGES,
  SMOKE_STAGES,
  buildSmokeStage,
  expectedEnd,
  type SmokeStageName,
} from "./lib/smoke";
import { findState, type LucidModTx, type V2Context } from "../../src/lib/offering-v2-tx";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[fv2-smoke]");
const TSRA = `${PREPROD_TSRA.policyId}${PREPROD_TSRA.assetNameHex}`;

const a = args();
try {
  for (const o of ["--label", "--keys-dir", "--signers", "--until"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const LABEL = a.opt("--label") ?? "fv2-preprod-test";
const KEYS_DIR = a.opt("--keys-dir");
const SIGNERS = (a.opt("--signers") ?? "c1,c2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const UNTIL = a.opt("--until") as SmokeStageName | undefined;
const FILE = `deployments/${LABEL}.json`;

if (!KEYS_DIR) die("Give --keys-dir <dir> (the folder with c1.skey, c2.skey).");
if (UNTIL && !SMOKE_STAGES.includes(UNTIL))
  die(`--until must be one of ${SMOKE_STAGES.join(", ")}.`);
if (!existsSync(FILE)) die(`${FILE} not found — run bootstrap-offering first, from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, unknown> & { status?: string };
const deployment = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown> & {
  open?: Rec;
  refs?: Rec;
  smoke?: Record<string, Rec>;
};
if (deployment.open?.status !== "confirmed" || deployment.refs?.status !== "confirmed")
  die(`${FILE}: the offering's open and refs stages must both be confirmed.`);
deployment.smoke ??= {};
const smoke = deployment.smoke;
for (const s of SMOKE_STAGES) {
  const st = smoke[s]?.status;
  if (st && st !== "confirmed")
    die(
      `${FILE}: smoke stage ${s} is "${st}". Check its tx on Cardanoscan; mark it confirmed or remove it.`,
    );
}
const pending = SMOKE_STAGES.filter((s) => smoke[s]?.status !== "confirmed");
const toRun = UNTIL ? pending.slice(0, pending.indexOf(UNTIL) + 1) : pending;
if (pending.length === 0) {
  console.log(`Every smoke stage is already confirmed in ${FILE}. Nothing to do.`);
  process.exit(0);
}
if (UNTIL && !pending.includes(UNTIL)) die(`--until ${UNTIL} is already confirmed.`);

const dirty = git(
  "status --porcelain -- contracts/fraction-vault src/lib/fraction-vault-v2.ts src/lib/offering-v2-chain.ts src/lib/offering-v2-tx.ts scripts/fv2",
);
if (SUBMIT && dirty) die(`Uncommitted changes in the v2 code:\n${dirty}`);

const save = () => writeFileSync(FILE, JSON.stringify(deployment, null, 2) + "\n");
const keyAddress = (hash: string) => credentialToAddress("Preprod", { type: "Key", hash });

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operatorAddress = await lucid.wallet().address();
  if (!operatorAddress.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const operatorKey = keyHashOf(
    process.env.STELLARIS_OPERATOR_SKEY_FILE
      ? skeyFileToBech32(process.env.STELLARIS_OPERATOR_SKEY_FILE)
      : die("Use STELLARIS_OPERATOR_SKEY_FILE."),
  );

  // The offering, re-derived from its recorded seed and checked.
  const open = deployment.open!;
  const scripts = deriveTestOffering(
    open.seed as { txHash: string; outputIndex: number },
    "Preprod",
  );
  if (scripts.offering.hash !== open.offeringHash)
    die(
      `Re-derived offering hash ${scripts.offering.hash} ≠ recorded ${String(open.offeringHash)}.`,
    );
  const committee = open.committee as string[];
  const refsRec = deployment.refs!;
  const outRef = (s: string) => {
    const [txHash, ix] = s.split("#");
    return { txHash: txHash!, outputIndex: Number(ix) };
  };
  const [r0, r1, r2] = await lucid.utxosByOutRef([
    outRef(refsRec.offering as string),
    outRef(refsRec.pledge as string),
    outRef(refsRec.fraction as string),
  ]);
  if (!r0?.scriptRef || !r1?.scriptRef || !r2?.scriptRef)
    die("A recorded reference script is missing on chain.");
  const ctx: V2Context = {
    lucid,
    mod: L as unknown as LucidModTx,
    scripts,
    refs: { offering: r0, pledge: r1, fraction: r2 },
  };

  // Committee signers and the pledge owners (operator, c1, c2).
  const signerKeys = SIGNERS.map((n) => {
    const f = join(KEYS_DIR!, `${n}.skey`);
    if (!existsSync(f)) die(`${f} not found.`);
    return skeyFileToBech32(f);
  });
  const signerHashes = signerKeys.map(keyHashOf);
  for (const [i, h] of signerHashes.entries())
    if (!committee.includes(h)) die(`${SIGNERS[i]!} (${h}) is not on this offering's committee.`);
  const { state: now0 } = await findState(ctx);
  if (new Set(signerHashes).size < now0.threshold)
    die(
      `Committee actions need ${now0.threshold} distinct signers; got ${new Set(signerHashes).size}.`,
    );
  const owners: [string, string, string] = [
    operatorAddress,
    keyAddress(signerHashes[0]!),
    keyAddress(signerHashes[1] ?? signerHashes[0]!),
  ];
  const roles = { operatorAddress, operatorKey, owners, signers: signerHashes };

  // Funds check: TSRA for the pledges still to make, ADA for riders and fees.
  const utxos = await lucid.wallet().getUtxos();
  const tsra = utxos.reduce((x, u) => x + (u.assets[TSRA] ?? 0n), 0n);
  const lovelace = utxos.reduce((x, u) => x + (u.assets.lovelace ?? 0n), 0n);
  const pledgesLeft = (["pledge-1", "pledge-2", "pledge-3"] as const)
    .map((s, i) => (smoke[s]?.status === "confirmed" ? 0n : SMOKE_PLEDGES[i]!))
    .reduce((x, y) => x + y, 0n);
  const needTsra = pledgesLeft * now0.terms.price;

  console.log(`== fraction_vault v2 smoke test — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator       ${operatorAddress}`);
  console.log(
    `offering       ${scripts.offering.hash} (${now0.status}, ${now0.book.settled} settled)`,
  );
  console.log(`co-signers     ${SIGNERS.join(", ")}`);
  console.log(`owners         operator, ${SIGNERS[0]}, ${SIGNERS[1] ?? SIGNERS[0]}`);
  console.log(
    `wallet         ${ada(lovelace)} · ${(Number(tsra) / 1e6).toFixed(6)} TSRA (pledges still need ${Number(needTsra) / 1e6} TSRA)`,
  );
  console.log(
    `done           ${SMOKE_STAGES.filter((s) => smoke[s]?.status === "confirmed").join(", ") || "-"}`,
  );
  console.log(`to run         ${toRun.join(" → ")}`);
  if (tsra < needTsra)
    die(`Not enough TSRA: have ${Number(tsra) / 1e6}, need ${Number(needTsra) / 1e6}.`);
  if (lovelace < 30_000_000n)
    die("Keep at least 30 tADA in the operator wallet for riders and fees.");

  if (!SUBMIT) {
    // Only the next stage can be built: each later one depends on the chain
    // after the one before it.
    const next = await buildSmokeStage(ctx, toRun[0]!, roles, Date.now());
    await guard(lucid, { name: "open", tx: next.tx, intent: next.intent, record: {} });
    const fee = CML.Transaction.from_cbor_hex(next.tx.toCBOR()).body().fee();
    console.log(`\n[${next.name}]  ${String(next.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)}`);
    for (const [k, v] of Object.entries(next.record)) console.log(`   ${k.padEnd(14)}${String(v)}`);
    console.log("\nValidated: Blockfrost evaluated its scripts and it passed the S1 intent guard.");
    console.log("Later stages are built and checked the same way, one at a time, on --submit.");
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }

  for (const name of toRun) {
    const stage = await buildSmokeStage(ctx, name, roles, Date.now());
    await guard(lucid, { name: "open", tx: stage.tx, intent: stage.intent, record: {} });
    let w = stage.tx.sign.withWallet();
    if (COMMITTEE_STAGES.has(name)) for (const k of signerKeys) w = w.sign.withPrivateKey(k);
    const hash = await (await w.complete()).submit();
    smoke[name] = {
      ...stage.record,
      tx: hash,
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
    save();
    console.log(
      `\n[${name}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
    );
    if (!(await lucid.awaitTx(hash, 5_000)))
      die(`[${name}] not confirmed yet; ${FILE} records it as submitted. Re-check, then re-run.`);
    smoke[name] = { ...smoke[name]!, status: "confirmed", confirmedAt: new Date().toISOString() };
    save();
    console.log(`[${name}] confirmed.`);
    if (!(await walletCaughtUp(lucid, stage.tx.toCBOR())))
      die(
        `The wallet view still lists inputs [${name}] spent. Wait a minute and re-run (it resumes).`,
      );
  }

  const { state, utxo } = await findState(ctx);
  console.log(
    `\nState now: ${state.status} · settled ${state.book.settled} · released ${Number(state.book.released) / 1e6} TSRA · ` +
      `fees ${Number(state.book.fees) / 1e6} TSRA · period ${state.period} · holds ${Number(utxo.assets[TSRA] ?? 0n) / 1e6} TSRA`,
  );
  if (SMOKE_STAGES.every((s) => smoke[s]?.status === "confirmed")) {
    const e = expectedEnd();
    const ok =
      state.status === e.status &&
      state.book.settled === e.settled &&
      state.book.released === e.released &&
      state.book.fees === e.fees &&
      state.book.escrowed === e.escrowed &&
      state.period === e.period &&
      state.manifestRoot === e.manifestRoot &&
      (utxo.assets[TSRA] ?? 0n) === state.book.escrowed - state.book.released + state.book.pool;
    console.log(
      ok
        ? "Smoke test PASSED: the State matches the expected end state, and its TSRA equals its books."
        : "WARNING: the State does not match the expected end state; paste this output to Claude.",
    );
  }
  console.log(`Commit ${FILE} (no keys in it).`);
}

main().catch((e: unknown) => {
  console.error(`[fv2-smoke] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
