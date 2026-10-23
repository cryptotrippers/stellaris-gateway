/**
 * Generate TEST-ONLY Preprod payment keys for the operator and the committee.
 *
 *   npx tsx scripts/tessera/new-preprod-keys.ts --out C:\Users\<you>\stellaris-preprod-keys
 *   npx tsx scripts/tessera/new-preprod-keys.ts --out <dir> --names operator,c1,c2,c3,c4,c5,registry
 *
 * Writes one cardano-cli style `<name>.skey` per name (usable as
 * STELLARIS_OPERATOR_SKEY_FILE) plus `addresses.json`. Refuses to write
 * inside this repository or over existing files. Never prints a private key.
 *
 * These keys guard test ADA only. Never reuse them on mainnet.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { CML, credentialToAddress, generatePrivateKey } from "@lucid-evolution/lucid";

function die(msg: string): never {
  console.error(`[new-preprod-keys] ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const namesIdx = argv.indexOf("--names");
const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
if (!out) die("--out <directory outside the repo> is required");
const names = (namesIdx >= 0 ? (argv[namesIdx + 1] ?? "") : "operator,c1,c2,c3,c4,c5,registry")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!names.every((n) => /^[a-z0-9-]+$/.test(n))) die("--names: a-z, 0-9 and '-' only");

const dir = resolve(out);
const repo = resolve(".");
if (dir === repo || dir.startsWith(repo + sep))
  die(`Refusing to write keys inside the repo (${repo}).`);
mkdirSync(dir, { recursive: true });

const addresses: Record<string, { address: string; keyHash: string }> = {};
for (const name of names) {
  const file = resolve(dir, `${name}.skey`);
  if (existsSync(file)) die(`${file} already exists — refusing to overwrite a key.`);
  const sk = CML.PrivateKey.from_bech32(generatePrivateKey());
  const keyHash = sk.to_public().hash().to_hex();
  const address = credentialToAddress("Preprod", { type: "Key", hash: keyHash });
  writeFileSync(
    file,
    JSON.stringify(
      {
        type: "PaymentSigningKeyShelley_ed25519",
        description: `Stellaris PREPROD test key: ${name}`,
        cborHex: "5820" + Buffer.from(sk.to_raw_bytes()).toString("hex"),
      },
      null,
      4,
    ) + "\n",
    { mode: 0o600 },
  );
  addresses[name] = { address, keyHash };
  console.log(`${name.padEnd(10)} ${address}`);
}
writeFileSync(resolve(dir, "addresses.json"), JSON.stringify(addresses, null, 2) + "\n");
console.log(`\nKeys and addresses.json written to ${dir}. Back this folder up; never commit it.`);
