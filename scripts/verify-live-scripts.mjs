import { readFileSync } from "node:fs";
import { applyParamsToScript, validatorToAddress, validatorToScriptHash, fromText } from "@lucid-evolution/lucid";
const KEY = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
const BF = "https://cardano-preprod.blockfrost.io/api/v0";
const bp = JSON.parse(readFileSync("contracts/vault/plutus.json","utf8"));
const get = (t)=>bp.validators.find(v=>v.title===t).compiledCode;
const src=(f)=>readFileSync(f,"utf8");

/** Reads a `NAME = <digits>n` bigint literal out of a source file. Fails loud
 *  (not a null-deref) if the file has been refactored and the pattern moved. */
function readVersion(file, name) {
  const match = src(file).match(new RegExp(`${name}\\s*=\\s*(\\d+)n`));
  if (!match) {
    throw new Error(
      `[verify-live-scripts] Could not find "${name} = <n>n" in ${file}. ` +
        `It may have moved to another module (check for a re-export) — update this script's source file.`,
    );
  }
  return match[1];
}

// VAULT_VERSION is defined in vault-params.ts; vault.ts only re-exports it
// (`export { VAULT_VERSION } from "./vault-params"`), so it has no `= <n>n`
// literal of its own to match against.
const V = readVersion("src/lib/vault-params.ts", "VAULT_VERSION");
const YV = readVersion("src/lib/yield-vault.ts", "YIELD_VAULT_VERSION");
const targets=[];
for (const a of ["sfm-01","sfm-02"]) {
  targets.push({label:`vault/${a}`,cbor:applyParamsToScript(get("vault.vault.spend"),[BigInt(V),fromText(a)])});
  targets.push({label:`yield_vault/${a}`,cbor:applyParamsToScript(get("yield_vault.yield_vault.spend"),[BigInt(YV),fromText(a)])});
}
async function bf(p){const r=await fetch(BF+p,{headers:{project_id:KEY}});return {s:r.status,b:await r.text()};}
for (const t of targets){
  const val={type:"PlutusV3",script:t.cbor};
  const hash=validatorToScriptHash(val), addr=validatorToAddress("Preprod",val);
  const meta=await bf(`/scripts/${hash}`);
  const cbor=await bf(`/scripts/${hash}/cbor`);
  const utxos=await bf(`/addresses/${addr}/utxos`);
  let live="not seen on-chain", match="n/a";
  if(meta.s===200){ live=JSON.parse(meta.b).type;
    if(cbor.s===200){const c=JSON.parse(cbor.b).cbor; match = c===t.cbor ? "EXACT MATCH" : `MISMATCH (live ${c.length} vs local ${t.cbor.length})`;}
  }
  const u = utxos.s===200 ? JSON.parse(utxos.b).length : (utxos.s===404?0:`err ${utxos.s}`);
  console.log(`${t.label}\n  hash: ${hash}\n  addr: ${addr}\n  onchain: ${live} | cbor: ${match} | utxos: ${u}\n`);
}
