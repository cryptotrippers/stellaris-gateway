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

console.log(`Running ${files.length} test file(s) on Node ${process.version}.`);
const argv = ["tsx", "--import", "./scripts/test/register-asset-stub.mjs", "--test", ...files];

if (!process.env.GITHUB_ACTIONS) {
  const res = spawnSync("npx", argv, { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(res.status ?? 1);
}

// On GitHub Actions, also turn each failing test into an annotation, so a
// failure can be read from the check run without downloading the full log.
const res = spawnSync("npx", argv, {
  stdio: ["inherit", "pipe", "inherit"],
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const out = res.stdout ?? "";
process.stdout.write(out);
const lines = out.split("\n");
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
let shown = 0;
for (let i = 0; i < lines.length && shown < 10; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  const detail = lines
    .slice(i + 1, i + 40)
    .filter((l) => /error:|code:|ERR_|expected|actual|location:|at /.test(l))
    .slice(0, 8)
    .map((l) => l.trim())
    .join("\n");
  console.log(
    `::error title=${esc(m[1].slice(0, 200))}::${esc(detail.slice(0, 1500) || "(no detail)")}`,
  );
  shown++;
}
process.exit(res.status ?? 1);
