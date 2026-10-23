#!/usr/bin/env node
/**
 * Blueprint drift guard.
 *
 * Fails if `contracts/vault/plutus.json` drifts from the *unapplied* blueprints
 * pinned in the app:
 *   - `vault.vault.spend`             → VAULT_BLUEPRINT_* in src/lib/vault.ts
 *   - `yield_vault.yield_vault.spend` → YIELD_BLUEPRINT_* in src/lib/yield-vault.ts
 *
 * Applied script hashes + addresses are derived at runtime by Lucid via
 * `applyParamsToScript(cbor, [version, assetId])`, so only the blueprints are
 * pinned here — bumping a version does NOT change these values.
 *
 * Skips silently if plutus.json is absent (contributors without Aiken installed
 * can still `bun run build`).
 *
 * Run manually: `node scripts/verify-vault-hash.mjs`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2.js";
import { verifyTokenRegistry } from "./verify-token-registry.mjs";

const PLUTUS_PATH = resolve("contracts/vault/plutus.json");
const SUSDR_PLUTUS_PATH = resolve("contracts/susdr-vault/plutus.json");
const MULTI_PLUTUS_PATH = resolve("contracts/multi-asset-vault/plutus.json");
const FRACTION_PLUTUS_PATH = resolve("contracts/fraction-vault/plutus.json");
const FRACTION_TS_PATH = resolve("src/lib/fraction-vault.ts");
const TESSERA_PLUTUS_PATH = resolve("contracts/tessera/plutus.json");
const TESSERA_TS_PATH = resolve("src/lib/tessera-blueprint.ts");
const VAULT_TS_PATH = resolve("src/lib/vault.ts");
const YIELD_TS_PATH = resolve("src/lib/yield-vault.ts");
const SUSDR_TS_PATH = resolve("src/lib/susdr-vault.ts");
const MULTI_TS_PATH = resolve("src/lib/multi-asset-vault.ts");

const STRICT = process.env.VERIFY_VAULT_STRICT === "1" || process.argv.includes("--strict");

if (!existsSync(PLUTUS_PATH)) {
  if (STRICT) {
    console.error(
      "[verify-vault-hash] STRICT mode: contracts/vault/plutus.json is missing — run `aiken build` before verifying.",
    );
    process.exit(1);
  }
  console.log(
    "[verify-vault-hash] contracts/vault/plutus.json not present — skipping (run `aiken build` locally to generate it).",
  );
  process.exit(0);
}

const blueprint = JSON.parse(readFileSync(PLUTUS_PATH, "utf8"));
const validators = blueprint?.validators ?? [];

function findIn(list, titlePrefix, purpose = ".spend") {
  const v = list.find(
    (x) =>
      typeof x?.title === "string" && x.title.startsWith(titlePrefix) && x.title.includes(purpose),
  );
  if (!v?.hash || !v?.compiledCode) {
    console.error(
      `[verify-vault-hash] plutus.json has no '${titlePrefix}${purpose}' validator with hash + compiledCode`,
    );
    process.exit(1);
  }
  return v;
}

function findValidator(titlePrefix, purpose = ".spend") {
  return findIn(validators, titlePrefix, purpose);
}

const susdrValidators = existsSync(SUSDR_PLUTUS_PATH)
  ? (JSON.parse(readFileSync(SUSDR_PLUTUS_PATH, "utf8"))?.validators ?? [])
  : null;

const multiValidators = existsSync(MULTI_PLUTUS_PATH)
  ? (JSON.parse(readFileSync(MULTI_PLUTUS_PATH, "utf8"))?.validators ?? [])
  : null;


function readPins(path) {
  const src = readFileSync(path, "utf8");
  return (name, fallback) => {
    const m = src.match(new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*\\n?\\s*"([0-9a-fA-F]+)"`));
    if (m) return m[1];
    if (fallback) return fallback;
    console.error(`[verify-vault-hash] ${name} not found in ${path}`);
    process.exit(1);
  };
}

const vaultPin = readPins(VAULT_TS_PATH);
const yieldPin = readPins(YIELD_TS_PATH);

/**
 * Recompute the script hash from the compiled CBOR so we never trust the
 * `hash` field plutus.json reports about itself: blake2b-224 over
 * (PlutusV3 language tag 0x03 || flat-encoded script bytes).
 */
function scriptHashOf(compiledCodeHex) {
  const body = Uint8Array.from(Buffer.from(compiledCodeHex, "hex"));
  const tagged = new Uint8Array(body.length + 1);
  tagged[0] = 0x03;
  tagged.set(body, 1);
  return Buffer.from(blake2b(tagged, { dkLen: 28 })).toString("hex");
}

const targets = [
  {
    label: "vault (Stage 3)",
    onChain: findValidator("vault.vault"),
    hash: vaultPin("VAULT_BLUEPRINT_HASH"),
    cbor: vaultPin("VAULT_BLUEPRINT_CBOR"),
    file: "src/lib/vault.ts",
  },
  {
    label: "yield_vault (Stage 4)",
    onChain: findValidator("yield_vault.yield_vault"),
    hash: yieldPin("YIELD_BLUEPRINT_HASH"),
    cbor: yieldPin("YIELD_BLUEPRINT_CBOR", "__BLUEPRINT_IMPORT__"),
    file: "src/lib/yield-vault.ts",
  },
  {
    label: "receipt (Stage 6)",
    onChain: findValidator("receipt.receipt", ".mint"),
    hash: yieldPin("RECEIPT_BLUEPRINT_HASH"),
    cbor: yieldPin("RECEIPT_BLUEPRINT_CBOR", "__BLUEPRINT_IMPORT__"),
    file: "src/lib/yield-vault.ts",
  },
];

if (susdrValidators) {
  const susdrPin = readPins(SUSDR_TS_PATH);
  targets.push(
    {
      label: "susdr_vault",
      onChain: findIn(susdrValidators, "susdr_vault.susdr_vault"),
      hash: susdrPin("SUSDR_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/susdr-vault.ts",
    },
    {
      label: "usdr policy",
      onChain: findIn(susdrValidators, "usdr.usdr", ".mint"),
      hash: susdrPin("USDR_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/susdr-vault.ts",
    },
  );
} else {
  console.log(
    "[verify-vault-hash] contracts/susdr-vault/plutus.json not present — skipping sUSDr pins.",
  );
}

if (multiValidators) {
  const multiPin = readPins(MULTI_TS_PATH);
  targets.push({
    label: "multi_asset_vault (Wing B)",
    onChain: findIn(multiValidators, "multi_asset_vault.multi_asset_vault"),
    hash: multiPin("MULTI_BLUEPRINT_HASH"),
    cbor: "__BLUEPRINT_IMPORT__",
    file: "src/lib/multi-asset-vault.ts",
  });
} else {
  console.log(
    "[verify-vault-hash] contracts/multi-asset-vault/plutus.json not present — skipping multi-asset pins.",
  );
}

const fractionValidators = existsSync(FRACTION_PLUTUS_PATH)
  ? (JSON.parse(readFileSync(FRACTION_PLUTUS_PATH, "utf8"))?.validators ?? [])
  : null;

if (fractionValidators) {
  const fractionPin = readPins(FRACTION_TS_PATH);
  targets.push(
    {
      label: "fraction_vault (offering)",
      onChain: findIn(fractionValidators, "fraction_vault.fraction_vault"),
      hash: fractionPin("FRACTION_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/fraction-vault.ts",
    },
    {
      label: "fraction (token policy)",
      onChain: findIn(fractionValidators, "fraction.fraction", ".mint"),
      hash: fractionPin("FRACTION_POLICY_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/fraction-vault.ts",
    },
  );
} else {
  console.log(
    "[verify-vault-hash] contracts/fraction-vault/plutus.json not present — skipping fraction pins.",
  );
}

const tesseraBlueprint = existsSync(TESSERA_PLUTUS_PATH)
  ? JSON.parse(readFileSync(TESSERA_PLUTUS_PATH, "utf8"))
  : null;
const tesseraValidators = tesseraBlueprint ? (tesseraBlueprint.validators ?? []) : null;

if (tesseraValidators) {
  const tesseraPin = readPins(TESSERA_TS_PATH);
  // Phase 2.2: the State NFT is minted by reserve.ak itself (thread pattern);
  // state_nft.ak is retired. 2.3 adds eligibility, 2.4 the sTSRA vault, 2.5b the
  // first-loss reserve.
  targets.push(
    {
      label: "tessera reserve (Config + Supply + TSRA + thread policy)",
      onChain: findIn(tesseraValidators, "reserve.reserve"),
      hash: tesseraPin("TESSERA_RESERVE_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera eligibility (allowlist policy + registry)",
      onChain: findIn(tesseraValidators, "eligibility.eligibility", ".mint"),
      hash: tesseraPin("TESSERA_ELIGIBILITY_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera stsra_vault (State, Positions, Tickets + sTSRA policy)",
      onChain: findIn(tesseraValidators, "stsra_vault.stsra_vault"),
      hash: tesseraPin("TESSERA_STSRA_VAULT_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera vault_ops (withdraw-zero: ReportLoss, ReportYield, SetBounds, Claim accounting)",
      onChain: findIn(tesseraValidators, "vault_ops.vault_ops", ".withdraw"),
      hash: tesseraPin("TESSERA_VAULT_OPS_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera first_loss (first-loss reserve State + thread policy)",
      onChain: findIn(tesseraValidators, "first_loss.first_loss"),
      hash: tesseraPin("TESSERA_FIRST_LOSS_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera redeem_queue (queue address, markers + thread tokens)",
      onChain: findIn(tesseraValidators, "redeem_queue.redeem_queue"),
      hash: tesseraPin("TESSERA_REDEEM_QUEUE_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera queue_flow (withdraw-zero: Request, Instant, Settle, PayShort, Sweep)",
      onChain: findIn(tesseraValidators, "queue_flow.queue_flow", ".withdraw"),
      hash: tesseraPin("TESSERA_QUEUE_FLOW_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera queue_admin (withdraw-zero: committee actions of the queue)",
      onChain: findIn(tesseraValidators, "queue_admin.queue_admin", ".withdraw"),
      hash: tesseraPin("TESSERA_QUEUE_ADMIN_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
    {
      label: "tessera queue_short (withdraw-zero: short mode and the Defund veto)",
      onChain: findIn(tesseraValidators, "queue_short.queue_short", ".withdraw"),
      hash: tesseraPin("TESSERA_QUEUE_SHORT_BLUEPRINT_HASH"),
      cbor: "__BLUEPRINT_IMPORT__",
      file: "src/lib/tessera-blueprint.ts",
    },
  );

  // Phase 2.6: queue_flow's Sweep reads the reserve's `Burn` redeemer by its
  // constructor index (an exact pin of `reserve_burn_tag` in queue_state.ak). A
  // reordering of `ReserveRedeemer` would silently turn the Sweep check into a
  // check for another reserve action, so it fails the build instead.
  const queueStateSrc = readFileSync(resolve("contracts/tessera/lib/tessera/queue_state.ak"), "utf8");
  const pinnedBurnTag = Number(queueStateSrc.match(/pub const reserve_burn_tag:\s*Int\s*=\s*(\d+)/)?.[1]);
  const burnCtor = tesseraBlueprint?.definitions?.["reserve/ReserveRedeemer"]?.anyOf?.find(
    (c) => c.title === "Burn",
  );
  if (!Number.isInteger(pinnedBurnTag) || burnCtor?.index !== pinnedBurnTag) {
    console.error(
      `[verify-vault-hash] reserve_burn_tag (${pinnedBurnTag}) does not match the Burn constructor index of ReserveRedeemer in the reserve blueprint (${burnCtor?.index}).`,
    );
    process.exit(1);
  }
  console.log(`[verify-vault-hash] OK — queue_state.reserve_burn_tag = ${pinnedBurnTag} matches ReserveRedeemer.Burn.`);
} else {
  console.log(
    "[verify-vault-hash] contracts/tessera/plutus.json not present — skipping Tessera pins.",
  );
}

for (const target of targets) {
  if (target.cbor === "__BLUEPRINT_IMPORT__") target.cbor = target.onChain.compiledCode;
}

// Size guard: a script must fit in the transaction that publishes it as a
// reference script (16,384 bytes max transaction size), so no validator in any
// project may compile above MAX_VALIDATOR_BYTES. The Tessera target is 13,000
// (headroom for the redemption queue); CI fails at 14,000.
const MAX_VALIDATOR_BYTES = 14_000;
let oversize = false;
for (const p of [
  PLUTUS_PATH,
  SUSDR_PLUTUS_PATH,
  MULTI_PLUTUS_PATH,
  FRACTION_PLUTUS_PATH,
  TESSERA_PLUTUS_PATH,
]) {
  if (!existsSync(p)) continue;
  for (const v of JSON.parse(readFileSync(p, "utf8"))?.validators ?? []) {
    const bytes = (v.compiledCode?.length ?? 0) / 2;
    if (bytes > MAX_VALIDATOR_BYTES) {
      console.error(
        `[verify-vault-hash] SIZE: ${v.title} in ${p} compiles to ${bytes} bytes (> ${MAX_VALIDATOR_BYTES}); it could not be published as a reference script.`,
      );
      oversize = true;
    }
  }
}
if (oversize) process.exit(1);

let drift = false;
for (const t of targets) {
  if (t.hash !== t.onChain.hash) {
    console.error(`[verify-vault-hash] ${t.label} BLUEPRINT HASH DRIFT`);
    console.error(`  pinned   (${t.file}): ${t.hash}`);
    console.error(`  on-chain (plutus.json):     ${t.onChain.hash}`);
    drift = true;
  }
  const recomputed = scriptHashOf(t.onChain.compiledCode);
  if (recomputed !== t.onChain.hash) {
    console.error(`[verify-vault-hash] ${t.label} SELF-INCONSISTENT BLUEPRINT`);
    console.error(`  plutus.json hash:  ${t.onChain.hash}`);
    console.error(`  hash of its CBOR:  ${recomputed}`);
    drift = true;
  }
  if (t.cbor !== t.onChain.compiledCode) {
    console.error(`[verify-vault-hash] ${t.label} BLUEPRINT CBOR DRIFT`);
    console.error(`  pinned CBOR length:   ${t.cbor.length}`);
    console.error(`  on-chain CBOR length: ${t.onChain.compiledCode.length}`);
    drift = true;
  }
}

if (drift) {
  console.error("");
  console.error("  The compiled validator no longer matches what the app applies at runtime.");
  console.error("  Either revert the Aiken change, or update the pinned hash + CBOR. If the");
  console.error("  on-chain logic itself changed (not just a rebuild), also bump the version");
  console.error("  and withdraw all live deposits before deploying.");
  process.exit(1);
}

for (const t of targets) {
  console.log(
    `[verify-vault-hash] OK — ${t.label} matches (hash=${t.hash.slice(0, 12)}…, cbor=${t.cbor.length} chars, hash recomputed from CBOR).`,
  );
}

// Phase 2.7 (D-42): the token registry bodies must match BRAND and, for submitted
// units, what was submitted. Needs no build output, so it runs in every mode.
{
  const registryProblems = verifyTokenRegistry();
  if (registryProblems.length) {
    for (const p of registryProblems) console.error(`[verify-vault-hash] token registry: ${p}`);
    process.exit(1);
  }
  console.log("[verify-vault-hash] OK — token registry bodies match BRAND and the submitted values.");
}
