#!/usr/bin/env node
// Sprint 1 E16 — script-size gate.
//
// Every validator in a compiled blueprint (plutus.json) must stay at or below
// SIZE_LIMIT bytes of compiled code. Cardano caps a transaction at 16,384
// bytes, and a validator close to that leaves no room for the fixes that the
// February 2027 audit and counsel may require. The gate fails CI the moment a
// change pushes any validator over the line, so headroom is never lost
// silently.
//
// Sizes are of the UNAPPLIED compiled code in the blueprint; applying
// parameters adds a few dozen bytes per parameter.
//
// Usage:
//   node scripts/contracts/check-script-sizes.mjs                 # every contracts/*/plutus.json
//   node scripts/contracts/check-script-sizes.mjs contracts/tessera
//   node scripts/contracts/check-script-sizes.mjs --limit 12000 contracts/tessera
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SIZE_LIMIT = 13_000;

/**
 * One entry per distinct validator (a multi-purpose validator appears in the
 * blueprint once per purpose with the same code).
 * @param {{ validators: Array<{ title: string, compiledCode?: string }> }} blueprint
 */
export function validatorSizes(blueprint) {
  const seen = new Map();
  for (const v of blueprint.validators ?? []) {
    if (typeof v.compiledCode !== "string") continue;
    const name = v.title.split(".").slice(0, 2).join(".");
    const bytes = v.compiledCode.length / 2;
    const prev = seen.get(name);
    if (prev === undefined || bytes > prev) seen.set(name, bytes);
  }
  return [...seen.entries()].map(([name, bytes]) => ({ name, bytes }));
}

/**
 * @param {Array<{ project: string, blueprint: any }>} projects
 * @param {number} limit
 */
export function checkSizes(projects, limit = SIZE_LIMIT) {
  const rows = [];
  for (const { project, blueprint } of projects) {
    for (const { name, bytes } of validatorSizes(blueprint)) {
      rows.push({ project, name, bytes, headroom: limit - bytes, ok: bytes <= limit });
    }
  }
  return { ok: rows.every((r) => r.ok), rows, limit };
}

function loadProjects(dirs) {
  const roots = dirs.length
    ? dirs
    : readdirSync("contracts")
        .map((d) => join("contracts", d))
        .filter((d) => statSync(d).isDirectory());
  return roots
    .filter((d) => existsSync(join(d, "plutus.json")))
    .map((d) => ({
      project: d,
      blueprint: JSON.parse(readFileSync(join(d, "plutus.json"), "utf8")),
    }));
}

function main(argv) {
  let limit = SIZE_LIMIT;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = Number(argv[++i]);
    else dirs.push(argv[i]);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error("--limit must be a positive whole number of bytes");
    return 2;
  }
  const projects = loadProjects(dirs);
  if (projects.length === 0) {
    console.error("No plutus.json found — run 'aiken build' first.");
    return 2;
  }
  const res = checkSizes(projects, limit);
  for (const r of res.rows.sort((a, b) => b.bytes - a.bytes)) {
    const line = `${r.ok ? "ok  " : "FAIL"} ${String(r.bytes).padStart(6)} B  headroom ${String(r.headroom).padStart(6)} B  ${r.project} ${r.name}`;
    if (r.ok) console.log(line);
    else console.log(`::error::${line} — over the ${limit}-byte limit`);
  }
  console.log(
    res.ok
      ? `All validators within ${limit} bytes.`
      : `Script-size gate FAILED (limit ${limit} bytes).`,
  );
  return res.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
