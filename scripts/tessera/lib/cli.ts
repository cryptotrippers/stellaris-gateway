/** Shared helpers for the Tessera operator scripts: args, keys, wallet, repo state. */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CML, type LucidEvolution } from "@lucid-evolution/lucid";

export function makeDie(tag: string) {
  return (msg: string): never => {
    console.error(`${tag} ${msg}`);
    process.exit(2);
  };
}

export function args(argv = process.argv.slice(2)) {
  return {
    flag: (f: string) => argv.includes(f),
    opt: (name: string): string | undefined => {
      const i = argv.indexOf(name);
      if (i < 0) return undefined;
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
      return v;
    },
  };
}

/** A cardano-cli payment .skey (TextEnvelope, cborHex 5820…) → bech32 ed25519_sk. */
export function skeyFileToBech32(path: string): string {
  const j = JSON.parse(readFileSync(path, "utf8")) as { cborHex?: string };
  if (!j.cborHex?.startsWith("5820")) throw new Error(`${path} is not a cardano-cli payment .skey`);
  return CML.PrivateKey.from_normal_bytes(Buffer.from(j.cborHex.slice(4), "hex")).to_bech32();
}

/** Payment key hash of a bech32 private key. */
export function keyHashOf(bech32: string): string {
  return CML.PrivateKey.from_bech32(bech32).to_public().hash().to_hex();
}

/** Select the operator wallet from STELLARIS_OPERATOR_* env (never logged). */
export function selectOperator(lucid: LucidEvolution, die: (m: string) => never): void {
  const skeyFile = process.env.STELLARIS_OPERATOR_SKEY_FILE;
  const skey = process.env.STELLARIS_OPERATOR_SKEY;
  const mnemonic = process.env.STELLARIS_OPERATOR_MNEMONIC;
  if (skeyFile) lucid.selectWallet.fromPrivateKey(skeyFileToBech32(skeyFile));
  else if (skey) lucid.selectWallet.fromPrivateKey(skey.trim());
  else if (mnemonic) lucid.selectWallet.fromSeed(mnemonic.trim());
  else
    die(
      "No operator key. Set STELLARIS_OPERATOR_SKEY_FILE (or STELLARIS_OPERATOR_SKEY / _MNEMONIC).",
    );
}

export function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function preprodKey(die: (m: string) => never): string {
  const key = process.env.BLOCKFROST_PREPROD_PROJECT_ID ?? "";
  if (!key) die("BLOCKFROST_PREPROD_PROJECT_ID is not set in this shell.");
  if (!key.startsWith("preprod"))
    die("BLOCKFROST_PREPROD_PROJECT_ID is not a Preprod key — refusing.");
  return key;
}

export const ada = (l: bigint) => `${(Number(l) / 1e6).toFixed(6)} tADA`;
