/**
 * Operator script: the Shield multisig treasury on Preprod (G1 stopgap).
 *
 *   npx tsx scripts/shield/treasury.ts --create
 *       derive the 3-of-5 native-script treasury from
 *       deployments/committee.preprod.json and record it in
 *       deployments/shield-preprod.json. No transaction: the address exists
 *       as soon as the script does.
 *
 *   npx tsx scripts/shield/treasury.ts --status
 *       what the treasury holds.
 *
 *   npx tsx scripts/shield/treasury.ts --spend --to <addr> --ada <n> [--tsra <n>]
 *           --keys-dir <dir> --signers c1,c2,c3 [--submit]
 *       pay out of the treasury; dry run unless --submit. Needs 3 distinct
 *       committee signatures; the operator wallet pays the fee.
 *
 * Preprod note: the five test keys are the reserve committee's and sit on one
 * PC, so they are NOT independent signers. Mainnet needs separate holders and
 * hardware wallets (build guide 14.5, X-3).
 *
 * Environment: BLOCKFROST_PREPROD_PROJECT_ID, STELLARIS_OPERATOR_SKEY_FILE.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blockfrost, CML, Lucid } from "@lucid-evolution/lucid";
import {
  args,
  ada,
  keyHashOf,
  makeDie,
  preprodKey,
  selectOperator,
  skeyFileToBech32,
} from "../tessera/lib/cli";
import { tsraToUnits } from "../tessera/lib/genesis";
import { TESSERA_PREPROD } from "../../src/lib/tessera-preprod";
import {
  buildTreasurySpend,
  keyHashOfAddress,
  treasuryAddress,
  type MultisigSpec,
} from "./lib/multisig";

const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const die: (msg: string) => never = makeDie("[shield-treasury]");
const FILE = "deployments/shield-preprod.json";
const COMMITTEE = "deployments/committee.preprod.json";
const TSRA = TESSERA_PREPROD.reserve.tsraUnit;

const a = args();
try {
  for (const o of ["--to", "--ada", "--tsra", "--keys-dir", "--signers"]) a.opt(o);
} catch (e) {
  die((e as Error).message);
}

type Rec = {
  treasury?: {
    type: string;
    threshold: number;
    signers: string[];
    scriptHash: string;
    address: string;
    note: string;
    createdAt: string;
  };
};
const dep: Rec = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Rec) : {};

function spec(): MultisigSpec {
  if (dep.treasury) return { signers: dep.treasury.signers, threshold: dep.treasury.threshold };
  const c = JSON.parse(readFileSync(COMMITTEE, "utf8")) as {
    operators: string[];
    threshold: number;
  };
  return { signers: c.operators.map(keyHashOfAddress), threshold: c.threshold };
}

async function main() {
  const s = spec();
  const t = treasuryAddress("Preprod", s);

  if (a.flag("--create")) {
    if (dep.treasury) die(`${FILE} already records a treasury at ${dep.treasury.address}.`);
    dep.treasury = {
      type: "native-multisig",
      threshold: s.threshold,
      signers: s.signers,
      scriptHash: t.hash,
      address: t.address,
      note: "Shield G1 stopgap. Preprod test keys (reserve committee c1-c5), not independent signers.",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(FILE, JSON.stringify(dep, null, 2) + "\n");
    console.log(`treasury   ${t.address}`);
    console.log(`script     ${t.hash} (at least ${s.threshold} of ${s.signers.length} signatures)`);
    console.log(`Recorded in ${FILE}. Commit it (no keys in it).`);
    return;
  }

  if (!dep.treasury) die(`No treasury recorded yet. Run with --create first.`);
  if (dep.treasury.address !== t.address)
    die("The recorded address does not match the recorded signers.");
  const lucid = await Lucid(new Blockfrost(BF, preprodKey(die)), "Preprod");
  const utxos = await lucid.utxosAt(t.address);
  const held = (unit: string) => utxos.reduce((x, u) => x + (u.assets[unit] ?? 0n), 0n);
  console.log(
    `== Shield treasury (${a.flag("--submit") ? "SUBMIT" : a.flag("--spend") ? "DRY RUN" : "STATUS"}) ==`,
  );
  console.log(`address    ${t.address}`);
  console.log(`rule       at least ${s.threshold} of ${s.signers.length} committee signatures`);
  console.log(
    `holds      ${ada(held("lovelace"))} · ${(Number(held(TSRA)) / 1e6).toLocaleString()} TSRA · ${utxos.length} UTxO(s)`,
  );
  if (!a.flag("--spend")) return;

  const to = a.opt("--to") ?? die("Give --to <addr_test1…>.");
  if (!to.startsWith("addr_test1")) die("--to must be a Preprod address.");
  const lovelace = BigInt(a.opt("--ada") ?? "2") * 1_000_000n;
  const tsra = a.opt("--tsra") ? tsraToUnits(a.opt("--tsra")!) : 0n;
  const dir = a.opt("--keys-dir") ?? die("Give --keys-dir <dir>.");
  const names = (a.opt("--signers") ?? "c1,c2,c3").split(",").map((x) => x.trim());
  const keys = names.map((n) => {
    const f = join(dir, `${n}.skey`);
    if (!existsSync(f)) die(`${f} not found.`);
    return skeyFileToBech32(f);
  });
  const hashes = keys.map(keyHashOf);
  for (const [i, h] of hashes.entries())
    if (!s.signers.includes(h)) die(`${names[i]!} is not a treasury signer.`);
  if (new Set(hashes).size < s.threshold) die(`Needs ${s.threshold} distinct signers.`);

  selectOperator(lucid, die);
  const assets: Record<string, bigint> = { lovelace };
  if (tsra > 0n) assets[TSRA] = tsra;
  const tx = await buildTreasurySpend(lucid, t, utxos, [{ address: to, assets }], hashes);
  const fee = CML.Transaction.from_cbor_hex(tx.toCBOR()).body().fee();
  console.log(
    `pay        ${to.slice(0, 20)}… ${ada(lovelace)}${tsra ? ` + ${Number(tsra) / 1e6} TSRA` : ""}`,
  );
  console.log(`signers    ${names.join(", ")} · fee ${ada(fee)} (operator)`);
  if (!a.flag("--submit")) {
    console.log("\nDRY RUN — nothing signed or submitted.");
    return;
  }
  let w = tx.sign.withWallet();
  for (const k of keys) w = w.sign.withPrivateKey(k);
  const hash = await (await w.complete()).submit();
  console.log(`\nsubmitted  ${hash}\n  https://preprod.cardanoscan.io/transaction/${hash}`);
  if (!(await lucid.awaitTx(hash, 5_000))) die("Not confirmed yet; check the link.");
  console.log("confirmed.");
}

main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
