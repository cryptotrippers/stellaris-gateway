/**
 * Security Suite S3 — input schemas, Blockfrost path guard, rate limiting and
 * the domain-bound wallet sign-in message.
 * Run: npx tsx --test src/lib/login-api-hardening.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  assetIdSchema,
  fundingRequestInputSchema,
  isSafeBlockfrostPath,
  parseInput,
  preprodAddressSchema,
  tokenUnitSchema,
  txHashSchema,
  valueUnitSchema,
  vaultTxInputSchema,
} from "./input-guards.shared";
import {
  RATE_RULES,
  RateLimited,
  enforceRateLimit,
  subjectHash,
  type HitFn,
} from "./rate-limit.server";
import { buildWalletLinkMessage, WALLET_LINK_TTL_MS } from "./wallet-link.shared";

const ok = <T>(s: Parameters<typeof parseInput<T>>[0], v: unknown) =>
  assert.doesNotThrow(() => parseInput(s, v));
const bad = <T>(s: Parameters<typeof parseInput<T>>[0], v: unknown) =>
  assert.throws(() => parseInput(s, v));

const ADDR = "addr_test1wz6j5zhmexlrl5h9s7a70yju424whtyc95ujazamukz9ftqwujfnm";
const UNIT = "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d740054535241";

describe("input schemas (S3.3)", () => {
  test("asset ids", () => {
    ok(assetIdSchema, "sfm-01");
    ok(assetIdSchema, "PH-Solar-01");
    for (const v of ["", "a", "-x", "a/b", "a b", "x".repeat(65), "sfm-01?x=1", 42])
      bad(assetIdSchema, v);
  });

  test("transaction hashes", () => {
    ok(txHashSchema, "d5fa7f511a10fa5429d9d6f381b81178f0b44c6ca0d79eb127c527476d96bd91");
    for (const v of ["", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33), "../txs"])
      bad(txHashSchema, v);
  });

  test("Preprod addresses only", () => {
    ok(preprodAddressSchema, ADDR);
    for (const v of [
      "addr1qmainnetaddressmainnetaddressmainnetaddressmainnetaddress",
      "addr_test1short",
      `${ADDR}/../../metrics`,
      `${ADDR}?count=1000`,
      "stake_test17qewx2tnz2qfeqkvum04a2l9tf8faf95ux09f80scw3fwtcelz6s9",
    ]) {
      bad(preprodAddressSchema, v);
    }
  });

  test("token units and lovelace", () => {
    ok(tokenUnitSchema, UNIT);
    ok(tokenUnitSchema, UNIT.slice(0, 56));
    ok(valueUnitSchema, "lovelace");
    for (const v of ["", UNIT.slice(0, 55), `${UNIT}0`, `${UNIT}/addresses`, "lovelace2"])
      bad(valueUnitSchema, v);
  });

  test("vault transaction record", () => {
    const good = { vaultId: "sfm-01", type: "deposit", amountAda: 10, txHash: "ab".repeat(32) };
    ok(vaultTxInputSchema, good);
    bad(vaultTxInputSchema, { ...good, type: "steal" });
    bad(vaultTxInputSchema, { ...good, amountAda: -1 });
    bad(vaultTxInputSchema, { ...good, amountAda: Number.NaN });
    bad(vaultTxInputSchema, { ...good, vaultId: "x".repeat(200) });
  });

  test("funding request: shape and size limits", () => {
    const good = {
      assetSlug: "nordic-wind-03",
      name: "Nordic Wind",
      category: "Energy",
      issuer: "Nordic Wind Pty Ltd",
      description: "x".repeat(100),
      targetAda: 100_000,
      minDepositAda: 10,
      evidenceUrls: ["https://example.com/title.pdf"],
      proposedFeeBps: 100,
      termsAccepted: true,
    };
    ok(fundingRequestInputSchema, good);
    bad(fundingRequestInputSchema, { ...good, description: "x".repeat(8_001) });
    bad(fundingRequestInputSchema, { ...good, evidenceUrls: Array(21).fill("https://a.b") });
    bad(fundingRequestInputSchema, { ...good, targetAda: "100000" });
    bad(fundingRequestInputSchema, { ...good, termsAccepted: "yes" });
  });
});

describe("Blockfrost path guard (S3.3)", () => {
  test("the app's real paths pass", () => {
    for (const p of [
      `/addresses/${ADDR}/utxos?count=100&page=2`,
      `/addresses/${ADDR}/transactions?order=asc&count=50`,
      `/assets/${UNIT}/addresses?count=100`,
      `/txs/${"ab".repeat(32)}/utxos`,
      "/blocks/latest",
      `/scripts/${"cd".repeat(28)}/cbor`,
    ]) {
      assert.equal(isSafeBlockfrostPath(p), true, p);
    }
  });

  test("traversal, scheme, fragments and odd characters are refused", () => {
    for (const p of [
      "/assets/../../metrics",
      "/assets/x/..%2f..%2fmetrics",
      "//evil.example/x",
      "https://evil.example/x",
      "/txs/ab#frag",
      "/txs/ab cd",
      "/txs/ab?x=<script>",
      "assets/x",
    ]) {
      assert.equal(isSafeBlockfrostPath(p), false, p);
    }
  });

  test("bfGet refuses an unsafe path before any request is made", async () => {
    const prevKey = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
    const prevFetch = globalThis.fetch;
    let called = false;
    process.env.BLOCKFROST_PREPROD_PROJECT_ID = "preprodTEST";
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const { bfGet } = await import("./blockfrost-fetch.server");
      await assert.rejects(bfGet("/assets/../../metrics"), /unsafe Blockfrost path/);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevKey === undefined) delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
      else process.env.BLOCKFROST_PREPROD_PROJECT_ID = prevKey;
    }
  });
});

describe("rate limiting (S3.2)", () => {
  const counter = (): { hit: HitFn; keys: string[] } => {
    const counts = new Map<string, number>();
    const keys: string[] = [];
    return {
      keys,
      hit: async (key, _w, max) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= max;
      },
    };
  };

  test("allows up to the limit, then refuses with a wait time", async () => {
    const { hit } = counter();
    const rule = { bucket: "t", max: 3, windowSeconds: 600 };
    for (let i = 0; i < 3; i++) await enforceRateLimit(rule, "user-1", hit);
    await assert.rejects(enforceRateLimit(rule, "user-1", hit), (e: unknown) => {
      assert.ok(e instanceof RateLimited);
      assert.match((e as Error).message, /10 minutes/);
      return true;
    });
    await enforceRateLimit(rule, "user-2", hit); // other subjects are unaffected
  });

  test("the stored key never contains the raw subject", async () => {
    const { hit, keys } = counter();
    await enforceRateLimit(RATE_RULES.checkout, "203.0.113.7", hit);
    assert.ok(keys[0].startsWith("checkout:"));
    assert.ok(!keys[0].includes("203.0.113.7"));
    assert.equal(keys[0], `checkout:${await subjectHash("203.0.113.7")}`);
    assert.ok(keys[0].length <= 96);
  });

  test("a database outage fails open by default and closed when asked", async () => {
    const down: HitFn = async () => {
      throw new Error("db down");
    };
    await enforceRateLimit({ bucket: "t", max: 1, windowSeconds: 60 }, "u", down);
    await assert.rejects(
      enforceRateLimit({ bucket: "t", max: 1, windowSeconds: 60, failClosed: true }, "u", down),
      RateLimited,
    );
  });

  test("every rule is sane", () => {
    for (const r of Object.values(RATE_RULES)) {
      assert.ok(r.max >= 1 && r.windowSeconds >= 60 && /^[a-z-]+$/.test(r.bucket), r.bucket);
    }
  });
});

describe("wallet sign-in message (S3.1)", () => {
  test("names the site's domain and expires within 5 minutes", () => {
    const msg = buildWalletLinkMessage({
      userId: "acc-1",
      address: "addr_test1xyz",
      nonce: "n",
      expiresAt: "T",
      domain: "stellarischain.com",
    });
    assert.match(
      msg,
      /^Stellaris Gateway — link this wallet to my account\nDomain: stellarischain\.com\n/,
    );
    assert.equal(WALLET_LINK_TTL_MS, 300_000);
  });

  test("a different domain gives a different message, so a look-alike site's signature fails", () => {
    const base = { userId: "a", address: "addr_test1xyz", nonce: "n", expiresAt: "T" };
    assert.notEqual(
      buildWalletLinkMessage({ ...base, domain: "stellarischain.com" }),
      buildWalletLinkMessage({ ...base, domain: "stellarischain.co" }),
    );
  });
});
