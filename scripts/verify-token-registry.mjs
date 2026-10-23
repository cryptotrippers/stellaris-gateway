#!/usr/bin/env node
/**
 * Fails when a committed Tessera registry body differs from what
 * `scripts/build-token-registry.mjs` builds from `src/config/brand.ts`, when a
 * body is missing or stray, or when a unit that was submitted to the registry no
 * longer matches the values that were submitted (SPEC.md §7.6, D-42).
 *
 * Run manually: `node scripts/verify-token-registry.mjs`. Also called from
 * `scripts/verify-vault-hash.mjs`, so the PS1 and CI run it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAll, fileOf, REGISTRY_DIR, render } from "./build-token-registry.mjs";

/** Returns a list of problems (empty = OK). */
export function verifyTokenRegistry() {
  const problems = [];
  const built = buildAll();
  const expectedFiles = new Set();

  for (const { unit, body } of built) {
    const file = fileOf(body);
    expectedFiles.add(basename(file));
    if (!/^[0-9a-f]{56}$/.test(unit.policyId) || !/^([0-9a-f]{2})*$/.test(unit.assetNameHex)) {
      problems.push(`${unit.label}: policyId/assetNameHex are not hex of the right length`);
    }
    if (!existsSync(file)) {
      problems.push(
        `${unit.label}: ${basename(file)} is missing (run node scripts/build-token-registry.mjs)`,
      );
      continue;
    }
    // git may check files out with CRLF on Windows; the content is what matters
    const committed = readFileSync(file, "utf8").split("\r\n").join("\n");
    if (committed !== render(body)) {
      problems.push(
        `${unit.label}: ${basename(file)} differs from BRAND.\n  committed: ${committed.trim().replace(/\s+/g, " ")}\n  expected:  ${render(body).trim().replace(/\s+/g, " ")}`,
      );
    }
    const sv = unit.submission?.submittedValues;
    if (sv) {
      for (const [k, v] of Object.entries(sv)) {
        if (JSON.stringify(body[k]) !== JSON.stringify(v)) {
          problems.push(
            `${unit.label}: '${k}' no longer matches what was submitted (PR #${unit.submission.pr}): submitted ${JSON.stringify(v)}, BRAND gives ${JSON.stringify(body[k])}. Change BRAND back, or re-sign and re-submit and update units.json.`,
          );
        }
      }
      if (body.logo !== undefined && sv.logo === undefined) {
        problems.push(
          `${unit.label}: a logo now exists but the submitted entry has none; re-sign and re-submit, then update submittedValues.`,
        );
      }
    }
  }

  for (const f of readdirSync(REGISTRY_DIR)) {
    if (f !== "units.json" && f.endsWith(".json") && !expectedFiles.has(f)) {
      problems.push(`${f}: a registry body with no unit in units.json`);
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyTokenRegistry();
  if (problems.length) {
    for (const p of problems) console.error(`[verify-token-registry] ${p}`);
    process.exit(1);
  }
  console.log("[verify-token-registry] OK — registry bodies match BRAND and the submitted values.");
}
