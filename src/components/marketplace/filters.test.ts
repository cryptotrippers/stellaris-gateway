import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityOf,
  countryOf,
  filterAssets,
  parseMarketSearch,
  sortAssets,
  type FilterableAsset,
} from "./filters";

const base: FilterableAsset = {
  id: "x",
  name: "X",
  category: "Clean Energy",
  issuer: "Issuer A",
  location: "Davao City, Philippines",
  target_lovelace: 150_000_000_000,
  raised_lovelace: 42_000_000_000,
  min_deposit_lovelace: 10_000_000,
  maturity_months: 120,
  funding_status: "demo",
  created_at: "2026-10-01",
};
const pilot: FilterableAsset = {
  ...base,
  id: "p",
  name: "Pilot",
  category: "pilot",
  issuer: "Stellaris",
  location: "Cardano Preprod",
  target_lovelace: 0,
  raised_lovelace: 0,
  min_deposit_lovelace: 2_000_000,
  maturity_months: null,
  funding_status: "pilot",
  created_at: "2026-09-01",
};
const housing: FilterableAsset = {
  ...base,
  id: "h",
  name: "Housing",
  category: "Real Estate",
  location: "Penrith, NSW, Australia",
  maturity_months: 36,
  created_at: "2026-10-05",
};

test("country is the last part of the stored location", () => {
  assert.equal(countryOf("Penrith, NSW, Australia"), "Australia");
  assert.equal(countryOf("Cardano Preprod"), "Cardano Preprod");
  assert.equal(countryOf(null), null);
});

test("demo listings are view only; open and pilot vaults accept test deposits", () => {
  assert.equal(availabilityOf({ funding_status: "demo" }), "view");
  assert.equal(availabilityOf({ funding_status: "pilot" }), "testnet");
  assert.equal(availabilityOf({ funding_status: "open" }), "testnet");
});

test("category group filter maps free-text categories", () => {
  const out = filterAssets([base, pilot, housing], { group: "residential" });
  assert.deepEqual(out.map((a) => a.id), ["h"]);
});

test("minimum participation filter keeps rows at or under the bucket", () => {
  const out = filterAssets([base, pilot, housing], { min: "5" });
  assert.deepEqual(out.map((a) => a.id), ["p"]);
});

test("term filter separates no-term, up to 3 years and over 3 years", () => {
  assert.deepEqual(filterAssets([base, pilot, housing], { term: "none" }).map((a) => a.id), ["p"]);
  assert.deepEqual(filterAssets([base, pilot, housing], { term: "short" }).map((a) => a.id), ["h"]);
  assert.deepEqual(filterAssets([base, pilot, housing], { term: "long" }).map((a) => a.id), ["x"]);
});

test("newest sort is the default and lowest-minimum sort is ascending", () => {
  assert.deepEqual(sortAssets([base, pilot, housing]).map((a) => a.id), ["h", "x", "p"]);
  assert.equal(sortAssets([base, pilot, housing], "min")[0]!.id, "p");
});

test("unknown search values are dropped", () => {
  const s = parseMarketSearch({ group: "crypto", min: "9999", sort: "hack", view: "list", q: "solar" });
  assert.equal(s.group, undefined);
  assert.equal(s.min, undefined);
  assert.equal(s.sort, undefined);
  assert.equal(s.view, "list");
  assert.equal(s.q, "solar");
});
