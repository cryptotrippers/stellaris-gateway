#!/usr/bin/env node
/**
 * Full-dApp readiness test.
 *
 * Answers one question with evidence instead of opinion: how much of this app
 * is actually a Cardano dApp today? Five layers are probed, every claim is
 * backed by a hash, an address, a UTxO reference or a transaction hash, and the
 * whole thing is written to `docs/dapp-readiness.md`.
 *
 *   1. contracts compile and match the pins
 *   2. pinned scripts are live on Preprod
 *   3. published reference scripts are still unspent
 *   4. registered vaults have exactly one state UTxO
 *   5. every user-facing flow has a real Preprod transaction behind it
 *
 * Read-only. Signs nothing, writes nothing on chain.
 *
 * Run: `bun run test:dapp`  (or `node scripts/dapp-readiness.mjs`)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const TAG = "[dapp-readiness]";
const NETWORK = "Preprod";
const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const BF_KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

/** live = proven on chain, wired = code exists but unproven, missing = absent. */
const GRADES = { live: "live", wired: "wired-but-unproven", missing: "not implemented" };

const layers = [];
function layer(name) {
  const l = { name, rows: [] };
  layers.push(l);
  return (grade, item, evidence) => l.rows.push({ grade, item, evidence });
}

async function bf(path) {
  if (!BF_KEY) return { status: 0, body: null };
  const res = await fetch(BF + path, { headers: { project_id: BF_KEY } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function rest(query) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { apikey: SUPABASE_KEY, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

function run(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — contracts compile and match the pins
// ---------------------------------------------------------------------------
const PACKAGES = ["contracts/vault", "contracts/susdr-vault", "contracts/multi-asset-vault"];
{
  const add = layer("1. Contracts compile and match the pinned blueprints");
  const hasAiken = run("sh", ["-c", "command -v aiken"]).ok;
  for (const pkg of PACKAGES) {
    if (!existsSync(resolve(pkg, "plutus.json"))) {
      add(GRADES.missing, `${pkg}`, "no plutus.json committed");
      continue;
    }
    if (!hasAiken) {
      add(GRADES.wired, `${pkg} — aiken check`, "aiken toolchain not installed here; CI runs it on every push");
      continue;
    }
    const check = run("aiken", ["check"], resolve(pkg));
    add(check.ok ? GRADES.live : GRADES.missing, `${pkg} — aiken check`, check.ok ? "validator tests pass" : check.out.slice(-400));
    const build = run("aiken", ["build"], resolve(pkg));
    add(build.ok ? GRADES.live : GRADES.missing, `${pkg} — aiken build`, build.ok ? "blueprint rebuilt" : build.out.slice(-400));
  }
  const pins = run("node", ["scripts/verify-vault-hash.mjs", "--strict"]);
  add(
    pins.ok ? GRADES.live : GRADES.missing,
    "pinned blueprint hashes vs plutus.json",
    pins.ok ? "all pins match a clean build" : pins.out.slice(-600),
  );
}

// ---------------------------------------------------------------------------
// Layer 2 — pinned scripts live on Preprod
// ---------------------------------------------------------------------------
const {
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  fromText,
} = await import("@lucid-evolution/lucid");

function src(path) {
  return readFileSync(resolve(path), "utf8");
}
function pinnedNumber(path, name) {
  const m = src(path).match(new RegExp(`${name}\\s*=\\s*(\\d+)n`));
  return m ? BigInt(m[1]) : 1n;
}
function compiled(pkg, title) {
  const bp = JSON.parse(src(`${pkg}/plutus.json`));
  return bp.validators.find((v) => v.title === title)?.compiledCode ?? null;
}

const vaultVersion = pinnedNumber("src/lib/vault.ts", "VAULT_VERSION");
const yieldVersion = pinnedNumber("src/lib/yield-vault.ts", "YIELD_VAULT_VERSION");
const multiVersion = pinnedNumber("src/lib/multi-asset-vault.ts", "MULTI_VAULT_VERSION");

const registeredVaults = (await rest("asset_vaults?select=asset_id,vault_version,network,script_hash,script_address,bootstrap_tx_hash,ref_script_utxos")) ?? [];
const depositAssets = (await rest("deposit_assets?select=symbol,policy_id,asset_name_hex,decimals,network,status")) ?? [];
const assetIds = [...new Set([...registeredVaults.map((v) => v.asset_id), "sfm-01", "sfm-02"])];

const derived = [];
for (const assetId of assetIds) {
  const yieldCode = compiled("contracts/vault", "yield_vault.yield_vault.spend");
  if (yieldCode) {
    derived.push({
      label: `yield_vault / ${assetId}`,
      cbor: applyParamsToScript(yieldCode, [yieldVersion, fromText(assetId)]),
    });
  }
  const vaultCode = compiled("contracts/vault", "vault.vault.spend");
  if (vaultCode) {
    derived.push({
      label: `vault / ${assetId}`,
      cbor: applyParamsToScript(vaultCode, [vaultVersion, fromText(assetId)]),
    });
  }
}
const multiCode = compiled("contracts/multi-asset-vault", "multi_asset_vault.multi_asset_vault.spend");
if (multiCode) {
  const live = depositAssets.filter((a) => a.status === "live" || a.status === "test");
  const units = live.length > 0 ? live : [{ symbol: "ADA", policy_id: "", asset_name_hex: "" }];
  for (const assetId of registeredVaults.map((v) => v.asset_id).concat(registeredVaults.length ? [] : ["ph-solar-01"])) {
    for (const u of units) {
      const policy = (u.policy_id ?? "").toLowerCase();
      // A registry row with an empty policy id *is* ADA on chain. Anything that
      // claims to be a token but carries no policy is a placeholder, and it
      // derives the exact same address as ADA — that is a registry bug, not a
      // second vault, so say so rather than printing a duplicate row.
      const placeholder = policy === "" && u.symbol !== "ADA";
      derived.push({
        label: `multi_asset_vault / ${assetId} / ${u.symbol}${placeholder ? " (placeholder policy)" : ""}`,
        note: placeholder
          ? `${u.symbol} has an empty policy id in deposit_assets, so it derives the ADA address — no real token vault exists for it`
          : null,
        cbor: applyParamsToScript(multiCode, [
          multiVersion,
          fromText(assetId),
          policy,
          policy === "" ? "" : (u.asset_name_hex ?? "").toLowerCase(),
        ]),
      });
    }
  }
}
const susdrCode = compiled("contracts/susdr-vault", "susdr_vault.susdr_vault.spend");
if (susdrCode) {
  const susdrVersion = pinnedNumber("src/lib/susdr-vault.ts", "SUSDR_VAULT_VERSION");
  try {
    derived.push({ label: "susdr_vault", cbor: applyParamsToScript(susdrCode, [susdrVersion]) });
  } catch {
    derived.push({ label: "susdr_vault", cbor: susdrCode, unapplied: true });
  }
}

const onChainAddresses = new Map();
{
  const add = layer("2. Pinned scripts on Preprod");
  if (!BF_KEY) {
    add(GRADES.wired, "Blockfrost", "no BLOCKFROST_PREPROD_PROJECT_ID in this environment");
  } else {
    for (const t of derived) {
      const validator = { type: "PlutusV3", script: t.cbor };
      const hash = validatorToScriptHash(validator);
      const address = validatorToAddress(NETWORK, validator);
      onChainAddresses.set(t.label, { hash, address });
      const meta = await bf(`/scripts/${hash}`);
      const suffix = t.note ? ` — ${t.note}` : "";
      if (meta.status !== 200) {
        add(GRADES.wired, t.label, `derived ${hash} — never seen on chain (addr ${address})${suffix}`);
        continue;
      }
      const cborRes = await bf(`/scripts/${hash}/cbor`);
      // Blockfrost serves the single-encoded script; the blueprint (and Lucid)
      // carry the double-encoded form. Compare through `sameScriptCbor` so an
      // encoding-depth difference is not reported as a blueprint drift.
      const match = cborRes.status === 200 && sameScriptCbor(cborRes.body?.cbor, t.cbor);
      const utxos = await bf(`/addresses/${address}/utxos`);
      const count = utxos.status === 200 ? utxos.body.length : utxos.status === 404 ? 0 : `err ${utxos.status}`;
      add(
        match && count !== 0 ? GRADES.live : GRADES.wired,
        t.label,
        `hash ${hash} · on chain · cbor ${match ? "EXACT MATCH — live script is the pinned blueprint" : "MISMATCH — the live script was compiled from a different blueprint than the one pinned today"} · ${count} utxo(s) at ${address}${suffix}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — reference scripts still unspent
// ---------------------------------------------------------------------------
{
  const add = layer("3. Reference scripts");
  const res = run("node", ["scripts/verify-ref-scripts.mjs"]);
  const published = registeredVaults.filter(
    (v) => v.ref_script_utxos && Object.keys(v.ref_script_utxos).length > 0,
  );
  add(
    published.length === 0 ? GRADES.missing : res.ok ? GRADES.live : GRADES.missing,
    "published reference UTxOs unspent",
    published.length === 0 ? "no vault has published reference scripts yet" : res.out.trim().split("\n").slice(-3).join(" | "),
  );
  for (const v of registeredVaults) {
    const keys = Object.keys(v.ref_script_utxos ?? {});
    add(
      keys.length > 0 ? GRADES.live : GRADES.missing,
      `${v.asset_id} reference scripts`,
      keys.length > 0 ? keys.join(", ") : "none published — every tx must inline the full script",
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 4 — vault state integrity
// ---------------------------------------------------------------------------
{
  const add = layer("4. Vault state integrity");
  if (registeredVaults.length === 0) {
    add(GRADES.missing, "asset_vaults registry", "no vault is registered on this network");
  }
  for (const v of registeredVaults) {
    if (!v.bootstrap_tx_hash) {
      add(GRADES.missing, `${v.asset_id} bootstrap`, "registered but never bootstrapped");
      continue;
    }
    const utxos = await bf(`/addresses/${v.script_address}/utxos`);
    const list = utxos.status === 200 ? utxos.body : [];
    const withDatum = list.filter((u) => u.inline_datum);
    // The state UTxO is the one carrying no depositor-specific token beyond ADA
    // plus the vault's own state marker; a healthy vault has exactly one.
    const stateLike = withDatum.length;
    add(
      stateLike === 1 ? GRADES.live : stateLike === 0 ? GRADES.missing : GRADES.wired,
      `${v.asset_id} state UTxO`,
      `${stateLike} datum-bearing utxo(s) of ${list.length} at ${v.script_address} · bootstrap ${v.bootstrap_tx_hash}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 5 — flow coverage: does a real Preprod tx exist?
// ---------------------------------------------------------------------------
{
  const add = layer("5. End-to-end flow coverage (real Preprod transactions)");
  const txs = (await rest("transactions?select=type,tx_hash,created_at&order=created_at.desc&limit=200")) ?? [];
  const accruals = (await rest("yield_accruals?select=tx_hash,asset_id,epoch,block_time&order=block_time.desc&limit=20")) ?? [];
  const fees = (await rest("vault_fee_schedules?select=asset_id,fee_bps,set_tx_hash&order=created_at.desc&limit=20")) ?? [];
  const proposals = (await rest("governance_proposals?select=sip_number,kind,status,executed_tx_hash&order=created_at.desc&limit=50")) ?? [];

  const bootstrapped = registeredVaults.filter((v) => v.bootstrap_tx_hash);
  add(
    bootstrapped.length > 0 ? GRADES.live : GRADES.missing,
    "bootstrap",
    bootstrapped.length > 0 ? bootstrapped.map((v) => `${v.asset_id}: ${v.bootstrap_tx_hash}`).join(" | ") : "no bootstrap tx recorded",
  );

  for (const kind of ["deposit", "withdraw", "yield"]) {
    const hit = txs.find((t) => t.type === kind);
    add(hit ? GRADES.live : GRADES.wired, kind, hit ? `${hit.tx_hash} (${hit.created_at})` : "builder exists, no recorded Preprod tx");
  }

  add(
    accruals.length > 0 ? GRADES.live : GRADES.wired,
    "accrue yield",
    accruals.length > 0 ? `${accruals[0].asset_id} epoch ${accruals[0].epoch}: ${accruals[0].tx_hash}` : "no accrual tx recorded",
  );

  const feeTx = fees.find((f) => f.set_tx_hash);
  add(feeTx ? GRADES.live : GRADES.wired, "set fee / settle fee", feeTx ? `${feeTx.asset_id} ${feeTx.fee_bps}bps: ${feeTx.set_tx_hash}` : "fee schedule never signed on chain");

  const executed = proposals.find((p) => p.executed_tx_hash);
  add(
    executed ? GRADES.live : GRADES.wired,
    "governance execution",
    executed
      ? `${executed.sip_number} (${executed.kind}): ${executed.executed_tx_hash}`
      : `${proposals.length} proposal(s) recorded, none carries an on-chain execution tx — voting and execution are off-chain`,
  );

  const multiWired = /getMultiVaultScript|deriveMultiVault/.test(
    [
      "src/lib/adapters/stellaris-yield.adapter.ts",
      "src/components/vault/AllocationFlow.tsx",
      "src/lib/rwa-adapter.ts",
    ]
      .filter((p) => existsSync(resolve(p)))
      .map((p) => src(p))
      .join("\n"),
  );
  add(
    multiWired ? GRADES.wired : GRADES.missing,
    "multi-asset deposit (native token)",
    multiWired
      ? "derivation reachable from the deposit flow, but no transaction builder signs against it"
      : "multi_asset_vault is derivation-only: no tx builder, no adapter, not reachable from the deposit flow",
  );

  const shareTransferable = /CIP-?113|transferable share/i.test(src("contracts/vault/validators/receipt.ak"));
  add(
    shareTransferable ? GRADES.wired : GRADES.missing,
    "transferable share tokens",
    shareTransferable ? "receipt policy mentions a share standard" : "receipts are vault-bound; no CIP-113 style transferable share token",
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const all = layers.flatMap((l) => l.rows);
const score = {
  live: all.filter((r) => r.grade === GRADES.live).length,
  wired: all.filter((r) => r.grade === GRADES.wired).length,
  missing: all.filter((r) => r.grade === GRADES.missing).length,
};
const pct = all.length === 0 ? 0 : Math.round((score.live / all.length) * 100);

const icon = (g) => (g === GRADES.live ? "PASS" : g === GRADES.wired ? "WARN" : "FAIL");

console.log(`\n${TAG} ${NETWORK} — ${new Date().toISOString()}\n`);
for (const l of layers) {
  console.log(l.name);
  for (const r of l.rows) console.log(`  ${icon(r.grade)}  ${r.item}\n        ${r.evidence}`);
  console.log("");
}
console.log(`${TAG} ${score.live} live · ${score.wired} wired-but-unproven · ${score.missing} missing → ${pct}% on chain\n`);

const md = [
  "# dApp readiness report",
  "",
  `Generated ${new Date().toISOString()} against **${NETWORK}**. Produced by \`bun run test:dapp\` (\`scripts/dapp-readiness.mjs\`), read-only.`,
  "",
  `**Score: ${pct}% on chain** — ${score.live} live, ${score.wired} wired-but-unproven, ${score.missing} not implemented.`,
  "",
  "Grades: **live** = proven by an on-chain artifact; **wired-but-unproven** = code path exists but nothing on chain demonstrates it; **not implemented** = absent.",
  "",
  ...layers.flatMap((l) => [
    `## ${l.name}`,
    "",
    "| | Item | Evidence |",
    "| --- | --- | --- |",
    ...l.rows.map((r) => `| ${icon(r.grade)} | ${r.item} | ${String(r.evidence).replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
  ]),
  "## Derived script addresses",
  "",
  "| Script | Hash | Address |",
  "| --- | --- | --- |",
  ...[...onChainAddresses.entries()].map(([label, v]) => `| ${label} | \`${v.hash}\` | \`${v.address}\` |`),
  "",
].join("\n");

mkdirSync(resolve("docs"), { recursive: true });
writeFileSync(resolve("docs/dapp-readiness.md"), `${md}\n`);
console.log(`${TAG} wrote docs/dapp-readiness.md`);
