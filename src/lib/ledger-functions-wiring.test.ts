// Sprint 2 E04 — every ledger server function authenticates, looks roles up
// server-side, rate-limits, and keeps server-only code out of the client file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./ledger.functions.ts", import.meta.url), "utf8");

test("E04: each ledger function uses auth middleware and ledgerCall", () => {
  const fns = src.split("export const ").slice(1);
  assert.equal(fns.length, 7);
  for (const f of fns) {
    const name = f.slice(0, f.indexOf(" "));
    assert.match(f, /\.middleware\(\[requireSupabaseAuth\]\)/, name);
    assert.match(f, /parseInput\(/, `${name} validates input`);
    assert.match(f, /ledgerCall\(context as unknown as Ctx, "ledger(Read|Write)"\)/, name);
  }
});

test("E04: no server-only module is imported at the top of the functions file", () => {
  const top = src.split("\n").filter((l) => l.startsWith("import "));
  for (const l of top) assert.doesNotMatch(l, /\.server|client\.server/, l);
});
