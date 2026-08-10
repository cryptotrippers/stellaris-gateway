#!/usr/bin/env node
/**
 * Reference-script liveness guard.
 *
 * Every (asset, validator) pair recorded in `asset_vaults.ref_script_utxos`
 * points at one specific output — a transaction that spends it destroys the
 * pointer permanently. There is no way to republish the *same* output: a fresh
 * reference UTxO has to be published and every future transaction repointed at
 * it. So this check exists to catch that the moment it happens, not the next
 * time somebody tries to build a deposit.
 *
 * Reads the registry from the public `asset_vaults` table (readable by anon)
 * and asks Blockfrost whether each output is still in the UTxO set at the
 * reference-script home address.
 *
 * Skips silently when the environment has no Supabase/Blockfrost credentials
 * (forks and PRs from outside the repo), unless run with `--strict`.
 *
 * Run manually: `node scripts/verify-ref-scripts.mjs`
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STRICT = process.env.VERIFY_REF_SCRIPTS_STRICT === "1" || process.argv.includes("--strict");
const TAG = "[verify-ref-scripts]";

function skip(reason) {
  if (STRICT) {
    console.error(`${TAG} STRICT mode: ${reason}`);
    process.exit(1);
  }
  console.log(`${TAG} ${reason} — skipping.`);
  process.exit(0);
}

// --- the one address that may ever hold a reference script -----------------
// Read from source rather than duplicated here, so Step 0 is only ever pasted
// into one place.
const SHARED_PATH = resolve("src/lib/ref-scripts.shared.ts");
const homeMatch = readFileSync(SHARED_PATH, "utf8").match(
  /REF_SCRIPT_HOME_ADDRESS\s*=\s*"([^"]+)"/,
);
if (!homeMatch) {
  console.error(`${TAG} could not read REF_SCRIPT_HOME_ADDRESS from ${SHARED_PATH}`);
  process.exit(1);
}
const HOME = homeMatch[1];
if (HOME.startsWith("<")) {
  skip("REF_SCRIPT_HOME_ADDRESS is still the Step 0 placeholder, so nothing can be published yet");
}

// --- credentials ------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const BF_KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
const BF = "https://cardano-preprod.blockfrost.io/api/v0";

if (!SUPABASE_URL || !SUPABASE_KEY) skip("no Supabase URL/key in the environment");
if (!BF_KEY) skip("no BLOCKFROST_PREPROD_PROJECT_ID in the environment");

// --- registry ---------------------------------------------------------------
const registryRes = await fetch(
  `${SUPABASE_URL}/rest/v1/asset_vaults?select=asset_id,vault_version,network,ref_script_utxos`,
  { headers: { apikey: SUPABASE_KEY, Accept: "application/json" } },
);
if (!registryRes.ok) {
  console.error(`${TAG} could not read asset_vaults (HTTP ${registryRes.status})`);
  console.error(await registryRes.text());
  process.exit(1);
}
const rows = await registryRes.json();

const pointers = [];
for (const row of rows) {
  const reg = row?.ref_script_utxos;
  if (!reg || typeof reg !== "object") continue;
  for (const [validator, pointer] of Object.entries(reg)) {
    if (!pointer || typeof pointer !== "object") continue;
    if (typeof pointer.txHash !== "string") continue;
    pointers.push({
      asset: row.asset_id,
      version: row.vault_version,
      network: row.network,
      validator,
      txHash: pointer.txHash,
      outputIndex: Number(pointer.outputIndex ?? 0),
      publishedAt: pointer.publishedAt ?? null,
    });
  }
}

if (pointers.length === 0) {
  console.log(`${TAG} no reference scripts published yet — nothing to verify.`);
  process.exit(0);
}

// --- live UTxO set at the home address --------------------------------------
// One paged read beats one lookup per pointer, and it answers the only question
// that matters: is this exact output still unspent?
const live = new Set();
for (let page = 1; ; page += 1) {
  const res = await fetch(`${BF}/addresses/${HOME}/utxos?page=${page}&count=100`, {
    headers: { project_id: BF_KEY },
  });
  if (res.status === 404) break; // address has never been used
  if (!res.ok) {
    console.error(`${TAG} Blockfrost error reading ${HOME} utxos (HTTP ${res.status})`);
    console.error(await res.text());
    process.exit(1);
  }
  const batch = await res.json();
  for (const u of batch) live.add(`${u.tx_hash}#${u.output_index}`);
  if (batch.length < 100) break;
}

// --- report -----------------------------------------------------------------
const spent = [];
for (const p of pointers) {
  const ref = `${p.txHash}#${p.outputIndex}`;
  const ok = live.has(ref);
  if (!ok) spent.push(p);
  console.log(
    `${ok ? "OK  " : "GONE"} ${p.asset} / ${p.validator} (v${p.version}, ${p.network})\n     ${ref}${
      p.publishedAt ? `\n     published ${p.publishedAt}` : ""
    }`,
  );
}

if (spent.length > 0) {
  console.error("");
  console.error("=".repeat(72));
  console.error(`${TAG} ${spent.length} REFERENCE SCRIPT UTXO(S) HAVE BEEN SPENT`);
  console.error("=".repeat(72));
  for (const p of spent) {
    console.error(`  ${p.asset} / ${p.validator} → ${p.txHash}#${p.outputIndex}`);
  }
  console.error("");
  console.error("A spent reference output cannot be restored: the same (txHash, index)");
  console.error("will never exist again. Every transaction that reads from it will fail.");
  console.error("Recovery: publish a NEW reference UTxO for each validator above via the");
  console.error("Publish reference scripts step in /stewardship, then record it so the");
  console.error("registry — and every future transaction — points at the new output.");
  console.error("");
  console.error("Also worth asking how it got spent: the home address must never be used");
  console.error("for coin selection or change, or the wallet will eat these outputs as fees.");
  process.exit(1);
}

console.log("");
console.log(`${TAG} all ${pointers.length} published reference script(s) are still unspent.`);
