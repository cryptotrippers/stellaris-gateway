#!/usr/bin/env node
// E11 — run every TypeScript unit test in the repo with node:test via tsx.
// Usage: npm test            (all *.test.ts under src/ and tests/)
//        npm test -- <files> (just those files)
// Exits non-zero if any test fails or if no test files are found.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src", "tests"];
const SKIP = new Set(["node_modules", "dist", ".output", ".vinxi"]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".test.ts")) out.push(relative(process.cwd(), p));
  }
  return out;
}

const args = process.argv.slice(2);
const files = args.length
  ? args
  : ROOTS.filter((r) => existsSync(r))
      .flatMap((r) => walk(r, []))
      .sort();

if (files.length === 0) {
  console.error("No *.test.ts files found.");
  process.exit(1);
}

console.log(`Running ${files.length} test file(s).`);
const res = spawnSync(
  "npx",
  ["tsx", "--import", "./scripts/test/register-asset-stub.mjs", "--test", ...files],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(res.status ?? 1);
