/**
 * Operator script: open the fraction_vault v2 TEST offering on Preprod.
 *
 *   npx tsx scripts/fv2/bootstrap-offering.ts --keys-dir <dir>
 *       dry run (default): picks a seed, derives the offering's scripts, builds
 *       both stages, has Blockfrost evaluate every script against those exact
 *       transactions, checks each with the S1 intent guard, prints the plan.
 *       Nothing is signed.
 *
 *   ... --submit
 *       submits the stages in order, waiting for each to confirm and recording
 *       it in deployments/<label>.json before the next. Re-running resumes.
 *
 * Stages
 *   open  — consume the seed, mint the thread token, pay the Raising State.
 *           Signed by the operator (issuer) and --signers (committee threshold).
 *   refs  — park the offering, pledge and fraction scripts as reference scripts
 *           at the permanent lock address (about 75 tADA stays locked).
 *
 * Test terms (scripts/fv2/lib/bootstrap.ts): asset id fv2-test-01, 1,000
 * fractions at 10 TSRA, soft cap 100, 1% fee, deadline in 14 days, 2-day settle
 * window. The operator holds the issuer, keeper, treasury and SPV roles; the
 * offering committee is --committee (2-of-3 by default). Test only.
 *
 * Options
 *   --keys-dir <dir>      folder with the committee .skey files
 *   --committee c1,c2,c3  key names in --keys-dir forming the offering committee
 *   --threshold 2         committee M-of-N
 *   --signers c1,c2       committee keys that sign Open (default: the first M)
 *   --label <name>        deployment label (default fv2-preprod-test)
 *   --submit
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 * Preprod only: refuses any key or address that is not Preprod.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, type UTxO } from "@lucid-evolution/lucid";
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
import {
  TEST_OFFERING,
  buildOpenStage,
  buildRefsStage,
  deriveTestOffering,
  guard,
  pickSeed,
  refLockAddress,
  testOpeningState,
  walletCaughtUp,
  type Stage,
} from "./lib/bootstrap";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[fv2-bootstrap]");

const a = args();
try {
  for (const o of ["--label", "--keys-dir", "--committee", "--threshold", "--signers"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const LABEL = a.opt("--label") ?? "fv2-preprod-test";
const KEYS_DIR = a.opt("--keys-dir");
const names = (s: string | undefined, d: string[]) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : d;
const COMMITTEE = names(a.opt("--committee"), ["c1", "c2", "c3"]);
const THRESHOLD = Number(a.opt("--threshold") ?? "2");
const SIGNERS = names(a.opt("--signers"), COMMITTEE.slice(0, THRESHOLD));
const FILE = `deployments/${LABEL}.json`;

if (!Number.isInteger(THRESHOLD) || THRESHOLD < 1 || THRESHOLD > COMMITTEE.length)
  die("--threshold must be between 1 and the committee size.");
if (new Set(SIGNERS).size < THRESHOLD) die(`Open needs ${THRESHOLD} distinct committee signers.`);
if (SIGNERS.some((s) => !COMMITTEE.includes(s)))
  die("Every --signers name must be in --committee.");
if (!KEYS_DIR) die("Give --keys-dir <dir> (the folder with c1.skey … c3.skey).");
const KEY = preprodKey(die);

type Rec = Record<string, unknown> & { status?: string };
const deployment: Record<string, unknown> & { open?: Rec; refs?: Rec } = existsSync(FILE)
  ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown>)
  : { label: LABEL, network: "Preprod", purpose: "fraction_vault v2 TEST offering" };
for (const s of ["open", "refs"] as const) {
  const st = deployment[s]?.status;
  if (st && st !== "confirmed")
    die(
      `${FILE}: stage ${s} is "${st}". Check its tx on Cardanoscan; mark it confirmed or remove it.`,
    );
}
if (deployment.open?.status === "confirmed" && deployment.refs?.status === "confirmed") {
  console.log(`Both stages are already confirmed in ${FILE}. Nothing to do.`);
  process.exit(0);
}

const dirty = git(
  "status --porcelain -- contracts/fraction-vault src/lib/fraction-vault-v2.ts src/lib/offering-v2-chain.ts src/lib/offering-v2-tx.ts scripts/fv2",
);
if (SUBMIT && dirty) die(`Uncommitted changes in the v2 code:\n${dirty}`);

function save() {
  writeFileSync(FILE, JSON.stringify(deployment, null, 2) + "\n");
}

function keyFile(n: string): string {
  const f = join(KEYS_DIR!, `${n}.skey`);
  if (!existsSync(f)) die(`${f} not found.`);
  return f;
}

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operatorAddress = await lucid.wallet().address();
  if (!operatorAddress.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const operatorHash = keyHashOf(
    process.env.STELLARIS_OPERATOR_SKEY_FILE
      ? skeyFileToBech32(process.env.STELLARIS_OPERATOR_SKEY_FILE)
      : (process.env.STELLARIS_OPERATOR_SKEY ?? "").trim() ||
          die("Use STELLARIS_OPERATOR_SKEY_FILE."),
  );

  const committeeKeys = COMMITTEE.map((n) => skeyFileToBech32(keyFile(n)));
  const committee = committeeKeys.map(keyHashOf);
  if (new Set(committee).size !== committee.length) die("The committee lists the same key twice.");
  const signerKeys = SIGNERS.map((n) => committeeKeys[COMMITTEE.indexOf(n)]!);

  // The seed: recorded if Open already happened, otherwise a fresh pure-ADA UTxO.
  const walletUtxos = await lucid.wallet().getUtxos();
  const recordedSeed = deployment.open?.seed as { txHash: string; outputIndex: number } | undefined;
  const seedUtxo: UTxO | undefined = recordedSeed ? undefined : pickSeed(walletUtxos);
  const seed = recordedSeed ?? { txHash: seedUtxo!.txHash, outputIndex: seedUtxo!.outputIndex };
  const scripts = deriveTestOffering(seed, "Preprod");
  if (recordedSeed && scripts.offering.hash !== deployment.open!.offeringHash)
    die(
      `Re-derived offering hash ${scripts.offering.hash} ≠ recorded ${String(deployment.open!.offeringHash)}.`,
    );

  const stages: Stage[] = [];
  if (deployment.open?.status !== "confirmed") {
    const now = Date.now();
    const state = testOpeningState(
      scripts,
      { operatorAddress, committee, threshold: THRESHOLD },
      now,
    );
    stages.push(
      await buildOpenStage(
        lucid,
        scripts,
        seedUtxo!,
        state,
        [operatorHash, ...signerKeys.map(keyHashOf)],
        now,
      ),
    );
  }
  // In a dry run the refs stage must not spend the seed, which Open spends.
  if (seedUtxo) lucid.overrideUTxOs(walletUtxos.filter((u) => u !== seedUtxo));
  stages.push(await buildRefsStage(lucid, scripts));
  lucid.overrideUTxOs([]);
  selectOperator(lucid, die);
  for (const s of stages) await guard(lucid, s);

  console.log(
    `== fraction_vault v2 test offering — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`,
  );
  console.log(`operator       ${operatorAddress}`);
  console.log(`asset id       ${scripts.assetId}`);
  console.log(`seed           ${seed.txHash}#${seed.outputIndex}`);
  console.log(`offering       ${scripts.offering.hash}`);
  console.log(`  address      ${scripts.offering.address}`);
  console.log(`pledge script  ${scripts.pledge.hash}`);
  console.log(`fraction       ${scripts.fraction.policyId}`);
  console.log(`deposit unit   TSRA (${scripts.depositUnit})`);
  console.log(
    `committee      ${THRESHOLD}-of-${COMMITTEE.length} (${COMMITTEE.join(", ")}); signing Open: ${SIGNERS.join(", ")}`,
  );
  console.log(
    `terms          ${TEST_OFFERING.totalFractions} fractions × 10 TSRA · soft cap ${TEST_OFFERING.softCap} · ` +
      `${TEST_OFFERING.feeBps / 100}% fee · deadline +${TEST_OFFERING.deadlineDays} d · window ${TEST_OFFERING.settleWindowDays} d`,
  );
  console.log(`ref lock       ${refLockAddress("Preprod")}`);
  for (const s of stages) {
    const fee = CML.Transaction.from_cbor_hex(s.tx.toCBOR()).body().fee();
    console.log(
      `\n[${s.name}]  ${String(s.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${s.tx.toHash()}`,
    );
  }
  console.log("\nValidated: Blockfrost evaluated every script on these exact transactions,");
  console.log("and each one passed the S1 intent guard.");

  if (!SUBMIT) {
    console.log(
      "\nDRY RUN — nothing signed or submitted. The seed is picked again on the --submit run.",
    );
    return;
  }

  for (let i = 0; i < stages.length; i++) {
    // Refs is rebuilt after Open confirms, from the wallet as it then is.
    let s = stages[i]!;
    if (s.name === "refs" && i > 0) {
      s = await buildRefsStage(lucid, scripts);
      await guard(lucid, s);
    }
    let w = s.tx.sign.withWallet();
    if (s.name === "open") for (const k of signerKeys) w = w.sign.withPrivateKey(k);
    const hash = await (await w.complete()).submit();
    const record = s.name === "refs" ? await buildRefsRecord(s, hash) : s.record;
    deployment[s.name] = {
      ...record,
      tx: hash,
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
    save();
    console.log(
      `\n[${s.name}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
    );
    if (!(await lucid.awaitTx(hash, 5_000)))
      die(`[${s.name}] not confirmed yet; ${FILE} records it as submitted. Re-check, then re-run.`);
    deployment[s.name] = {
      ...(deployment[s.name] as Rec),
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    };
    if (!(await walletCaughtUp(lucid, s.tx.toCBOR())))
      die(
        `The wallet view still lists inputs [${s.name}] spent. Wait a minute and re-run (it resumes).`,
      );
    save();
    console.log(`[${s.name}] confirmed.`);
  }

  // Read back.
  const states = (await lucid.utxosAt(scripts.offering.address)).filter(
    (u) => (u.assets[scripts.offering.threadUnit] ?? 0n) === 1n,
  );
  const parked = await lucid.utxosAt(refLockAddress("Preprod"));
  const refsTx = (deployment.refs as Rec).tx as string;
  const ok =
    states.length === 1 && parked.filter((u) => u.txHash === refsTx && u.scriptRef).length === 3;
  console.log(
    ok
      ? "\nConfirmed: the Raising State is on chain and the three reference scripts are parked."
      : "\nWARNING: read-back did not match; inspect the links above.",
  );
  console.log(`Commit ${FILE} (no keys in it), then pin the seed (see the step guide).`);
}

async function buildRefsRecord(s: Stage, hash: string) {
  return {
    ...s.record,
    offering: `${hash}#0`,
    pledge: `${hash}#1`,
    fraction: `${hash}#2`,
  };
}

main().catch((e: unknown) => {
  console.error(`[fv2-bootstrap] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
