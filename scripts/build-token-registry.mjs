#!/usr/bin/env node
/**
 * Builds the CIP-26 token registry entry BODIES for the Tessera units from
 * `src/config/brand.ts` (the single source of truth for names, tickers,
 * descriptions, decimals, url and logo) and `contracts/tessera/registry/units.json`.
 *
 * Bodies are unsigned: the signature is made offline with the dedicated metadata
 * key and submitted by pull request (SPEC.md §7.5/§7.6). No `policy` field: the
 * policies are Plutus scripts.
 *
 *   node scripts/build-token-registry.mjs          # write the bodies
 *   node scripts/build-token-registry.mjs --check # print them, write nothing
 *
 * `scripts/verify-token-registry.mjs` (run by verify-vault-hash and the PS1) fails
 * when a committed body differs from what this builds.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BRAND_PATH = resolve("src/config/brand.ts");
export const REGISTRY_DIR = resolve("contracts/tessera/registry");

/** Evaluates the BRAND object literal of brand.ts (plain JS once `as const` is gone). */
export function readBrand(path = BRAND_PATH) {
  const src = readFileSync(path, "utf8");
  const m = src.match(/export const BRAND = (\{[\s\S]*\}) as const;/);
  if (!m) throw new Error(`BRAND literal not found in ${path}`);
  return new Function(`"use strict"; return (${m[1]});`)();
}

export function readUnits() {
  return JSON.parse(readFileSync(resolve(REGISTRY_DIR, "units.json"), "utf8")).units;
}

/** The unsigned registry body of one unit. */
export function bodyOf(brand, unit) {
  const tok = brand[unit.brand];
  if (!tok) throw new Error(`unit ${unit.label}: BRAND has no '${unit.brand}'`);
  const preprod = unit.network === "preprod";
  const body = {
    subject: unit.policyId + unit.assetNameHex,
    name: tok.name + (preprod ? brand.preprod.nameSuffix : ""),
    ticker: tok.ticker,
    description: preprod && unit.brand === "base" ? brand.preprod.baseDescription : tok.description,
    decimals: brand.decimals,
    url: brand.url,
  };
  // The logo is only published when the artwork exists (placeholder path until then).
  const logoPath = resolve(brand.logo);
  if (existsSync(logoPath)) body.logo = readFileSync(logoPath).toString("base64");
  return body;
}

export function buildAll() {
  const brand = readBrand();
  return readUnits().map((u) => ({ unit: u, body: bodyOf(brand, u) }));
}

export const fileOf = (body) => resolve(REGISTRY_DIR, `${body.subject}.json`);
export const render = (body) => JSON.stringify(body, null, 2) + "\n";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkOnly = process.argv.includes("--check");
  for (const { body } of buildAll()) {
    if (checkOnly) {
      console.log(render(body));
    } else {
      writeFileSync(fileOf(body), render(body));
      console.log(`[build-token-registry] wrote ${fileOf(body)}`);
    }
  }
}
