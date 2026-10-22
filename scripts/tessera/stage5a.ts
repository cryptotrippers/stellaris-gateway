/**
 * Operator script: Stage 5a on Preprod — first value through the protocol.
 * Needs the confirmed reserve, vault and queue in deployments/<label>.json.
 *
 *   npx tsx scripts/tessera/stage5a.ts --keys-dir <dir> --signers c1,c2,c3
 *       dry run (default): builds attest → mint → stake → fund as a chain,
 *       evaluates every script, prints the plan. Nothing signed.
 *   ... --submit
 *       submits step by step, recording each in deployments/<label>.json
 *       under "stage5a" before the next. Re-running resumes.
 *
 * Amounts (whole units; defaults): --attest 100000 (TSRA reserve attested)
 *   --mint 10000 (TSRA to the operator) --stake 1000 (TSRA staked for sTSRA)
 *   --fund 20000 (tUSD into queue shard --shard 0).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid, getAddressDetails, type UTxO } from "@lucid-evolution/lucid";
import {
  applyQueueScripts,
  applyRedeemQueue,
  applyReserve,
  applyVault,
  applyVaultOps,
  rewardAddress,
} from "./lib/blueprint";
import {
  buildAttest,
  buildFund,
  buildMint,
  buildStakeShort,
  supplyFields,
  type Step,
} from "./lib/build-actions";
import {
  ada,
  args,
  git,
  keyHashOf,
  makeDie,
  preprodKey,
  selectOperator,
  skeyFileToBech32,
} from "./lib/cli";
import { tsraToUnits } from "./lib/genesis";
import { committeeOf } from "./lib/vault-genesis";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[tessera-5a]");
const STEPS = ["attest", "mint", "stake", "fund"] as const;
type StepName = (typeof STEPS)[number];

const a = args();
try {
  for (const o of [
    "--label",
    "--keys-dir",
    "--signers",
    "--attest",
    "--mint",
    "--stake",
    "--fund",
    "--shard",
  ])
    a.opt(o);
} catch (e) {
  die((e as Error).message);
}
const SUBMIT = a.flag("--submit");
const LABEL = a.opt("--label") ?? "preprod-v1";
const KEYS_DIR = a.opt("--keys-dir");
const SIGNERS = (a.opt("--signers") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AMT = {
  attest: tsraToUnits(a.opt("--attest") ?? "100000"),
  mint: tsraToUnits(a.opt("--mint") ?? "10000"),
  stake: tsraToUnits(a.opt("--stake") ?? "1000"),
  fund: tsraToUnits(a.opt("--fund") ?? "20000"),
};
const SHARD = Number(a.opt("--shard") ?? "0");
const FILE = `deployments/${LABEL}.json`;
if (!existsSync(FILE)) die(`${FILE} not found — run from the repo root.`);
const KEY = preprodKey(die);

type Rec = Record<string, any>;
const dep = JSON.parse(readFileSync(FILE, "utf8")) as Rec;
for (const k of ["reserve", "vault", "setVault", "queue", "refAdmin", "queueStake", "tusd"])
  if (dep[k]?.status !== "confirmed")
    die(`${FILE}: "${k}" is not confirmed — finish the bootstrap first.`);
dep.stage5a ??= {};
const s5 = dep.stage5a as Record<string, Rec>;
for (const s of STEPS)
  if (s5[s]?.status && s5[s].status !== "confirmed")
    die(`${FILE}: stage5a.${s} is "${String(s5[s].status)}". Check it on Cardanoscan first.`);
const pending = STEPS.filter((s) => s5[s]?.status !== "confirmed");
if (!pending.length) {
  console.log("Stage 5a is already confirmed. Nothing to do.");
  process.exit(0);
}
const dirty = git(
  "status --porcelain -- contracts/tessera src/lib/tessera-blueprint.ts scripts/tessera",
);
if (SUBMIT && dirty)
  die(`Uncommitted changes under contracts/tessera or scripts/tessera:\n${dirty}`);
const save = () => writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");

async function main() {
  const lucid = await Lucid(new Blockfrost(BF, KEY), "Preprod");
  selectOperator(lucid, die);
  const operator = await lucid.wallet().address();
  if (!operator.startsWith("addr_test1")) die("Operator wallet is not a testnet address.");
  const opKey = getAddressDetails(operator).paymentCredential!.hash;

  // Scripts, re-derived from the recorded seeds and checked against the record.
  const reserve = applyReserve(dep.reserve.seed);
  if (reserve.hash !== dep.reserve.scriptHash)
    die("Re-derived reserve hash does not match the record.");
  const vault = applyVault(dep.vault.seed, reserve.hash, applyVaultOps(reserve.hash).hash);
  if (vault.hash !== dep.vault.scriptHash) die("Re-derived vault hash does not match the record.");
  const qs = applyQueueScripts(reserve.hash);
  const queue = applyRedeemQueue(dep.queue.seed, reserve.hash, {
    flow: qs.flow.hash,
    admin: qs.admin.hash,
    short: qs.short.hash,
  });
  if (queue.hash !== dep.queue.scriptHash) die("Re-derived queue hash does not match the record.");

  const one = async (addr: string, unit: string): Promise<UTxO> => {
    const xs = (await lucid.utxosAt(addr)).filter((u) => (u.assets[unit] ?? 0n) === 1n);
    if (xs.length !== 1)
      die(`Expected one UTxO holding ${unit} at ${addr}; found ${String(xs.length)}.`);
    return xs[0]!;
  };
  const configRef = await one(dep.reserve.address, dep.reserve.configUnit);
  let supply = await one(dep.reserve.address, dep.reserve.supplyUnit);
  const committee = committeeOf(configRef.datum!);

  let signerKeys: string[] = [];
  let signers: string[] = [];
  if (pending.some((s) => s !== "stake")) {
    const dir = KEYS_DIR;
    if (!dir || !SIGNERS.length)
      die("Attest, Mint and Fund need --keys-dir <dir> and --signers c1,c2,c3.");
    signerKeys = SIGNERS.map((n) => {
      const f = join(dir, `${n}.skey`);
      if (!existsSync(f)) die(`${f} not found.`);
      return skeyFileToBech32(f);
    });
    signers = signerKeys.map(keyHashOf);
    for (const [i, h] of signers.entries())
      if (!committee.operators.includes(h)) die(`${SIGNERS[i]!} is not on the reserve committee.`);
    if (new Set(signers).size < committee.threshold)
      die(`Need ${String(committee.threshold)} distinct committee signers.`);
  }
  const rc = { reserve, reserveAddress: dep.reserve.address as string, configRef, signers };
  const [adminRef] = await lucid.utxosByOutRef([
    {
      txHash: (dep.refAdmin.refUtxo as string).split("#")[0]!,
      outputIndex: Number((dep.refAdmin.refUtxo as string).split("#")[1]),
    },
  ]);
  if (!adminRef?.scriptRef) die("queue_admin reference script not found on chain.");
  const shardUnit = (dep.queue.shardUnits as string[])[SHARD];
  if (!shardUnit)
    die(`--shard must be 0–${String((dep.queue.shardUnits as string[]).length - 1)}.`);

  const now = Date.now();
  const built: Step[] = [];
  for (const s of pending) {
    if (s === "attest") {
      const st = await buildAttest(lucid, rc, supply, AMT.attest, now);
      supply = st.derived.find((u) => (u.assets[dep.reserve.supplyUnit] ?? 0n) === 1n)!;
      built.push(st);
    } else if (s === "mint") {
      built.push(await buildMint(lucid, rc, supply, AMT.mint, opKey, operator, now));
    } else if (s === "stake") {
      const state = await one(dep.vault.address, dep.vault.stateUnit);
      built.push(
        await buildStakeShort(
          lucid,
          { vault, reserveHash: reserve.hash, configRef },
          state,
          AMT.stake,
          opKey,
          operator,
          now,
        ),
      );
    } else {
      built.push(
        await buildFund(
          lucid,
          {
            queue,
            adminReward: rewardAddress("Preprod", qs.admin),
            adminRef,
            queueConfig: await one(dep.queue.address, dep.queue.configUnit),
            reserveConfig: configRef,
            payoutUnit: dep.tusd.unit,
            signers,
          },
          await one(dep.queue.address, shardUnit),
          AMT.fund,
          now,
        ),
      );
    }
  }

  const s0 = supplyFields((await one(dep.reserve.address, dep.reserve.supplyUnit)).datum!);
  console.log(`== Tessera Stage 5a — ${LABEL} (${SUBMIT ? "SUBMIT" : "DRY RUN"}) ==`);
  console.log(`operator     ${operator}`);
  console.log(
    `supply now   minted ${(s0[0]! / 1_000_000n).toString()} TSRA · attested ${(s0[1]! / 1_000_000n).toString()} · cap ${(s0[2]! / 1_000_000n).toString()}`,
  );
  if (STEPS.some((s) => s5[s]?.status === "confirmed"))
    console.log(`already done ${STEPS.filter((s) => s5[s]?.status === "confirmed").join(", ")}`);
  for (const b of built) {
    const fee = CML.Transaction.from_cbor_hex(b.tx.toCBOR()).body().fee();
    console.log(
      `\n[${b.name}]  ${String(b.tx.toCBOR().length / 2)} bytes · fee ${ada(fee)} · tx ${b.tx.toHash()}`,
    );
    for (const [k, v] of Object.entries(b.record))
      if (k !== "tx") console.log(`   ${k.padEnd(18)}${String(v)}`);
  }
  console.log("\nValidated: every script accepted these exact transactions in local evaluation.");
  if (!SUBMIT) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }
  for (const b of built) {
    let s = b.tx.sign.withWallet();
    if (b.name !== "stake") for (const k of signerKeys) s = s.sign.withPrivateKey(k);
    const hash = await (await s.complete()).submit();
    s5[b.name as StepName] = {
      ...b.record,
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
    save();
    console.log(
      `\n[${b.name}] submitted ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`,
    );
    if (!(await lucid.awaitTx(hash, 5_000)))
      die(`[${b.name}] not confirmed yet; recorded as submitted.`);
    s5[b.name as StepName] = {
      ...s5[b.name as StepName],
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    };
    save();
    console.log(`[${b.name}] confirmed.`);
  }
  console.log(`\nStage 5a confirmed. Commit ${FILE}.`);
}

main().catch((e: unknown) => {
  console.error(`[tessera-5a] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
