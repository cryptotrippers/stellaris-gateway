// Sprint 1 E03 — hash chain, tamper detection and Merkle roots for the
// Meridian ledger. The Merkle root is cross-checked against an independent
// implementation on node:crypto.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  EMPTY_HEAD,
  GENESIS,
  canonical,
  chainEntries,
  hashEntry,
  merkleRoot,
  periodRoot,
  verifyChain,
  type ChainedEntry,
} from "./ledger-hash.shared";
import { entryFromJson, entryToJson } from "./ledger-store.server";
import { AUD, P1, PROJECT, solarEntries } from "./__fixtures__/meridian";

const chain = () => chainEntries(PROJECT, AUD, EMPTY_HEAD, solarEntries());

test("canonical JSON is key-order independent and keeps bigints exact", () => {
  assert.equal(canonical({ b: 1n, a: [2, "x", null] }), canonical({ a: [2, "x", null], b: 1n }));
  assert.equal(
    canonical({ big: 123456789012345678901234567890n }),
    '{"big":"123456789012345678901234567890"}',
  );
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ x: Number.NaN }));
});

test("the solar fixture chains deterministically from genesis", () => {
  const a = chain();
  const b = chain();
  assert.equal(a.length, 9);
  assert.deepEqual(
    a.map((c) => c.entryHash),
    b.map((c) => c.entryHash),
  );
  assert.equal(a[0]!.prevHash, GENESIS);
  for (let i = 1; i < a.length; i++) assert.equal(a[i]!.prevHash, a[i - 1]!.entryHash);
  assert.deepEqual(
    a.map((c) => c.seq),
    [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n],
  );
  const v = verifyChain(PROJECT, AUD, a);
  assert.ok(v.ok);
  assert.equal(v.head.seq, 9n);
});

test("the hash binds project, currency and position", () => {
  const e = solarEntries()[0]!;
  const h = hashEntry(GENESIS, PROJECT, AUD, 1n, e);
  assert.notEqual(hashEntry(GENESIS, "other-project", AUD, 1n, e), h);
  assert.notEqual(hashEntry(GENESIS, PROJECT, "PHP", 1n, e), h);
  assert.notEqual(hashEntry(GENESIS, PROJECT, AUD, 2n, e), h);
});

const tampered = (c: ChainedEntry[], i: number, patch: (x: ChainedEntry) => ChainedEntry) =>
  c.map((x, j) => (j === i ? patch(x) : x));

test("tamper: changing one cent anywhere breaks the chain at that entry", () => {
  const c = chain();
  const t = tampered(c, 4, (x) => ({ ...x, entry: { ...x.entry, amount: x.entry.amount + 1n } }));
  const v = verifyChain(PROJECT, AUD, t);
  assert.ok(!v.ok);
  assert.equal(v.seq, 5n);
});

test("tamper: rewriting a row and its own hash is still caught by the next row", () => {
  const c = chain();
  const forged = { ...c[2]!.entry, amount: 1n };
  const t = tampered(c, 2, (x) => ({
    ...x,
    entry: forged,
    entryHash: hashEntry(x.prevHash, PROJECT, AUD, x.seq, forged),
  }));
  const v = verifyChain(PROJECT, AUD, t);
  assert.ok(!v.ok);
  assert.equal(v.seq, 4n);
});

test("tamper: deleting, reordering or duplicating rows is caught", () => {
  const c = chain();
  assert.ok(
    !verifyChain(
      PROJECT,
      AUD,
      c.filter((_, i) => i !== 3),
    ).ok,
  );
  const swapped = c.map((x, i) =>
    i === 3 ? { ...c[4]!, seq: 4n } : i === 4 ? { ...c[3]!, seq: 5n } : x,
  );
  assert.ok(!verifyChain(PROJECT, AUD, swapped).ok);
  assert.ok(!verifyChain(PROJECT, AUD, [...c, c[8]!]).ok);
});

test("stored JSON round-trips an entry exactly, to the cent", () => {
  for (const c of chain()) {
    const back = entryFromJson(JSON.parse(JSON.stringify(entryToJson(c.entry))));
    assert.deepEqual(back, c.entry);
    assert.equal(hashEntry(c.prevHash, PROJECT, AUD, c.seq, back), c.entryHash);
  }
  assert.throws(() => entryFromJson({ amount: "12.50" }), /integer amount/);
  assert.throws(() => entryFromJson({ amount: 1250 }), /integer amount/);
});

// Independent Merkle implementation on node:crypto for cross-checking.
function refRoot(leaves: string[]): string {
  const h = (b: Buffer) => createHash("sha256").update(b).digest();
  if (leaves.length === 0) return h(Buffer.alloc(0)).toString("hex");
  let level: Buffer[] = leaves.map((x) =>
    h(Buffer.concat([Buffer.from([0]), Buffer.from(x, "hex")])),
  );
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length
          ? h(Buffer.concat([Buffer.from([1]), level[i]!, level[i + 1]!]))
          : level[i]!,
      );
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

test("Merkle root matches an independent implementation for 0..17 leaves", () => {
  const leaves = Array.from({ length: 17 }, (_, i) =>
    createHash("sha256").update(`leaf-${i}`).digest("hex"),
  );
  for (let n = 0; n <= 17; n++)
    assert.equal(merkleRoot(leaves.slice(0, n)), refRoot(leaves.slice(0, n)), `n=${n}`);
});

test("period root changes if any entry in the period changes, and only then", () => {
  const c = chain();
  const root = periodRoot(c, P1);
  assert.equal(root, refRoot(c.map((x) => x.entryHash)));
  const other = chainEntries(
    PROJECT,
    AUD,
    EMPTY_HEAD,
    solarEntries().map((e, i) => (i === 0 ? { ...e, amount: e.amount - 1n } : e)),
  );
  assert.notEqual(periodRoot(other, P1), root);
  assert.equal(periodRoot(c, "FY2028"), merkleRoot([]));
  assert.throws(() => merkleRoot(["XYZ"]));
});

test("money hygiene: no floating point in the hash or store modules", () => {
  for (const f of [
    "./ledger-hash.shared.ts",
    "./ledger-store.server.ts",
    "./ledger-read.shared.ts",
    "./ledger-service.server.ts",
  ]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const banned of [/\bNumber\(/, /parseFloat/, /toFixed/, /\bMath\./, /\bparseInt\b/]) {
      assert.doesNotMatch(src, banned, `${f} uses ${banned}`);
    }
  }
});
