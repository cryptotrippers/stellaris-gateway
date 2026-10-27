/**
 * Meridian M1 — seeded adversarial/property tests, money hygiene and the
 * Rail A / Rail B import boundary.
 *
 * The generator is a deterministic xorshift32 so a failure is reproducible
 * from its printed seed: MERIDIAN_SEED=<n> MERIDIAN_RUNS=1 npx tsx --test …
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  approvePeriod,
  closePeriod,
  invoiceOutstanding,
  post,
  reserveBalance,
  type EntryInput,
  type ProjectLedger,
} from "./financial-ledger.shared";
import { computeWaterfall } from "./asset-cashflow.shared";
import {
  approveDistribution,
  confirmFunding,
  createSnapshot,
  entitlementTotal,
  fundedTotal,
  paidTotal,
  payEntitlement,
  type Distribution,
} from "./distribution-entitlement.shared";
import {
  P1,
  PROJECT,
  fresh,
  invoice,
  must,
  obligation,
  opex,
  opexPaid,
  prov,
  receipt,
  reserveIn,
  reserveOut,
  valuation,
} from "./__fixtures__/meridian";

const RUNS = Number.parseInt(process.env.MERIDIAN_RUNS ?? "10000", 10);
const SEED0 = Number.parseInt(process.env.MERIDIAN_SEED ?? "20261025", 10);

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    int: (n: number) => next() % n,
    big: (max: bigint) => BigInt(next()) % max,
    pick: <T>(xs: readonly T[]) => xs[next() % xs.length],
    chance: (pct: number) => next() % 100 < pct,
  };
}

type R = ReturnType<typeof rng>;

/** One random, frequently hostile, entry. */
function randomEntry(r: R, l: ProjectLedger, n: number): EntryInput {
  const used = l.entries.map((e) => e.ref);
  const ref = r.chance(8) && used.length ? r.pick(used) : r.chance(3) ? `tessera:${n}` : `R${n}`;
  let amount = r.big(5_000_000n) + 1n;
  if (r.chance(4)) amount = -amount;
  if (r.chance(2)) amount = 0n;
  const refsOf = (k: string) => l.entries.filter((e) => e.kind === k).map((e) => e.ref);
  switch (r.int(10)) {
    case 0:
      return invoice(ref, amount);
    case 1:
    case 2: {
      const invs = refsOf("invoice_issued");
      return receipt(ref, amount, invs.length && r.chance(60) ? r.pick(invs) : null);
    }
    case 3:
      return opex(ref, amount);
    case 4: {
      const acc = refsOf("expense_accrued");
      return opexPaid(ref, amount, acc.length && r.chance(70) ? r.pick(acc) : null);
    }
    case 5:
      return obligation(ref, amount, 1 + r.int(3));
    case 6:
      return reserveIn(ref, amount);
    case 7:
      return reserveOut(ref, amount, r.chance(10) ? "" : "trustee");
    case 8:
      return valuation(ref, amount);
    default: {
      const invs = refsOf("invoice_issued");
      return invs.length
        ? { ...receipt(ref, amount), kind: "invoice_written_off", invoiceRef: r.pick(invs) }
        : receipt(ref, amount);
    }
  }
}

function checkLedger(l: ProjectLedger) {
  const refs = l.entries.map((e) => e.ref);
  assert.equal(new Set(refs).size, refs.length, "refs unique (I-B4/I-B8)");
  assert.ok(
    l.entries.every((e) => e.amount > 0n),
    "positive amounts",
  );
  assert.ok(
    l.entries.every((e) => !/^tessera/i.test(e.ref)),
    "no Rail A refs (I-B9)",
  );
  assert.ok(reserveBalance(l) >= 0n, "reserve never negative");
  for (const e of l.entries)
    if (e.kind === "invoice_issued") assert.ok(invoiceOutstanding(l, e.ref) >= 0n);

  const w = must(computeWaterfall(l, P1));
  const fromReceipts = w.tiers.reduce((s, t) => s + t.fundedFromReceipts, 0n);
  const fromReserve = w.tiers.reduce((s, t) => s + t.fundedFromReserve, 0n);
  assert.equal(fromReceipts + w.distributable, w.settledReceipts, "receipts fully accounted");
  assert.equal(
    fromReserve + w.reserveReleaseUnapplied,
    w.reserveReleased,
    "release fully accounted",
  );
  assert.ok(w.distributable >= 0n && w.shortfall >= 0n);
  if (w.shortfall > 0n)
    assert.equal(w.distributable, 0n, "no distribution while a tier is unfunded");
  assert.equal(w.tiers.at(-1)!.fundedFromReserve, 0n, "reserve cannot fund its own tier");

  // I-B7 / I-B10: removing invoices, valuations and releases never changes distributable.
  const stripped: ProjectLedger = {
    ...l,
    entries: l.entries.filter(
      (e) =>
        ![
          "invoice_issued",
          "invoice_written_off",
          "valuation_recorded",
          "reserve_release",
        ].includes(e.kind),
    ),
  };
  assert.equal(must(computeWaterfall(stripped, P1)).distributable, w.distributable);
  return w.distributable;
}

function checkDistribution(d: Distribution) {
  assert.ok(entitlementTotal(d) <= d.approvedAmount, "I-B2");
  assert.equal(entitlementTotal(d) + d.remainder, d.approvedAmount);
  assert.ok(fundedTotal(d) <= d.approvedAmount);
  assert.ok(paidTotal(d) <= fundedTotal(d), "I-B3");
  const payees = d.payments.map((p) => p.holderId);
  assert.equal(new Set(payees).size, payees.length, "I-B6");
  for (const p of d.payments)
    assert.equal(p.amount, d.entitlements.get(p.holderId), "paid exactly the entitlement");
}

test(`random histories hold every invariant (${RUNS} runs from seed ${SEED0})`, () => {
  let distributions = 0;
  let payments = 0;
  for (let run = 0; run < RUNS; run++) {
    const seed = SEED0 + run;
    const r = rng(seed);
    try {
      let l = fresh();
      const ops = 5 + r.int(30);
      for (let i = 0; i < ops; i++) {
        const res = post(l, randomEntry(r, l, i));
        if (res.ok) l = res.value;
      }
      const distributable = checkLedger(l);

      l = must(approvePeriod(must(closePeriod(l, P1)), P1, "board"));
      assert.equal(post(l, receipt("LATE", 1n)).ok, false, "I-B11");

      const holders = 1 + r.int(12);
      const snap = must(
        createSnapshot({
          projectId: PROJECT,
          periodId: P1,
          recordDate: "2027-06-30",
          holdings: Array.from({ length: holders }, (_, i) => ({
            holderId: `h${i}`,
            units: r.big(1_000n) + 1n,
          })),
          provenance: prov("register"),
        }),
      );
      const ask = r.chance(25)
        ? distributable + 1n + r.big(1_000n)
        : distributable > 0n
          ? r.big(distributable) + 1n
          : 1n;
      const ap = approveDistribution(l, [], {
        periodId: P1,
        amount: ask,
        approvedBy: "board",
        approval: prov(),
        snapshot: snap,
      });
      if (ask > distributable) {
        assert.equal(ap.ok, false, "I-B1");
        continue;
      }
      let d = must(ap);
      distributions++;
      const fundings = 1 + r.int(3);
      for (let i = 0; i < fundings; i++) {
        const res = confirmFunding(d, {
          fundingRef: `F${i}`,
          amount: r.big(d.approvedAmount) + 1n,
          provenance: prov(),
        });
        if (res.ok) d = res.value;
      }
      checkDistribution(d);
      const eligible = new Set(snap.holdings.filter(() => r.chance(85)).map((h) => h.holderId));
      const attempts = holders * 2 + 2;
      for (let i = 0; i < attempts; i++) {
        const who = r.chance(5) ? "intruder" : `h${r.int(holders)}`;
        const res = payEntitlement(d, who, `S${i}`, prov(), (h) => eligible.has(h));
        if (res.ok) {
          d = res.value;
          payments++;
          assert.ok(eligible.has(who) && who !== "intruder");
        }
        checkDistribution(d);
      }
    } catch (e) {
      throw new Error(`seed ${seed} failed: ${(e as Error).message}`);
    }
  }
  assert.ok(distributions > RUNS / 10, `exercised distributions (${distributions})`);
  assert.ok(payments > 0);
});

const here = dirname(fileURLToPath(import.meta.url));
const MODULES = [
  "provenance.shared.ts",
  "financial-ledger.shared.ts",
  "asset-cashflow.shared.ts",
  "distribution-entitlement.shared.ts",
];
const source = (f: string) =>
  readFileSync(join(here, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

test("money hygiene: no floating-point money in the ledger modules", () => {
  for (const f of MODULES) {
    const src = source(f);
    for (const banned of [/\bNumber\(/, /parseFloat/, /toFixed/, /\bMath\./, /\bparseInt\b/]) {
      assert.doesNotMatch(src, banned, `${f} uses ${banned}`);
    }
    assert.doesNotMatch(src, /amount\??:\s*number/, `${f} types an amount as number`);
  }
});

test("rail boundary: Rail B modules import nothing from Tessera, server code or the UI", () => {
  for (const f of MODULES) {
    const imports = [...source(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const i of imports) {
      assert.match(
        i,
        /^\.\/(provenance|financial-ledger|asset-cashflow|distribution-entitlement)\.shared$/,
        `${f} imports ${i}`,
      );
    }
  }
});
