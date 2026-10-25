/**
 * Security Suite S2.1 — CSP report parsing, sanitising and handling.
 * Run: npx tsx --test src/lib/csp-report.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CSP_REPORT_PATH,
  MAX_BODY_BYTES,
  MAX_RECORDS,
  blockedLabel,
  parseCspReports,
  pathOf,
  type CspRecord,
} from "./csp-report.shared";
import { allowReport, handleCspReport } from "./csp-report.server";

const legacy = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    "csp-report": {
      "document-uri": "https://stellarischain.com/marketplace?email=a@b.com#x",
      "violated-directive": "script-src-elem",
      "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/steal.js?token=secret",
      "script-sample": "alert(document.cookie)",
      "line-number": 12,
      disposition: "report",
      ...over,
    },
  });

describe("parsing and sanitising", () => {
  test("legacy report-uri format keeps only directive, origin, path, disposition", () => {
    const [r] = parseCspReports(legacy());
    assert.deepEqual(r, {
      directive: "script-src-elem",
      blocked: "https://evil.example",
      documentPath: "/marketplace",
      disposition: "report",
    });
    const stored = JSON.stringify(r);
    for (const leak of ["token", "secret", "email", "cookie", "steal.js", "#x"]) {
      assert.ok(!stored.includes(leak), `leaked ${leak}`);
    }
  });

  test("Reporting API format, several reports in one body", () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://stellarischain.com/tessera",
          effectiveDirective: "connect-src",
          blockedURL: "wss://relay.example.org/socket?key=1",
          disposition: "enforce",
        },
      },
      { type: "deprecation", body: { message: "ignored" } },
      {
        type: "csp-violation",
        body: {
          documentURL: "https://stellarischain.com/",
          effectiveDirective: "style-src-attr",
          blockedURL: "inline",
        },
      },
    ]);
    const rs = parseCspReports(body);
    assert.equal(rs.length, 2);
    assert.deepEqual(rs[0], {
      directive: "connect-src",
      blocked: "wss://relay.example.org",
      documentPath: "/tessera",
      disposition: "enforce",
    });
    assert.equal(rs[1].blocked, "inline");
  });

  test("special sources map to fixed labels", () => {
    assert.equal(blockedLabel(""), "inline");
    assert.equal(blockedLabel("eval"), "eval");
    assert.equal(blockedLabel("data:image/png;base64,AAAA"), "data");
    assert.equal(blockedLabel("blob:https://x/123"), "blob");
    assert.equal(blockedLabel("chrome-extension://abc/x.js"), "chrome-extension:");
    assert.equal(blockedLabel("not a url"), "other");
  });

  test("long ids, hashes and addresses in paths are collapsed", () => {
    assert.equal(
      pathOf("https://s.com/assets/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90/docs"),
      "/assets/:id/docs",
    );
    assert.equal(
      pathOf("https://s.com/wallet/addr_test1qpxq7xv58pq9qz29w79ln0py57a6gct97kxq"),
      "/wallet/:id",
    );
    assert.equal(pathOf("garbage"), "/");
  });

  test("an odd directive becomes 'unknown'", () => {
    const [r] = parseCspReports(
      legacy({ "effective-directive": "<script>", "violated-directive": "" }),
    );
    assert.equal(r.directive, "unknown");
  });

  test("garbage, wrong shapes and oversized bodies give nothing", () => {
    assert.deepEqual(parseCspReports("not json"), []);
    assert.deepEqual(parseCspReports("{}"), []);
    assert.deepEqual(parseCspReports("[1,2,3]"), []);
    assert.deepEqual(parseCspReports("x".repeat(MAX_BODY_BYTES + 1)), []);
  });

  test("no more than MAX_RECORDS per body", () => {
    const one = {
      type: "csp-violation",
      body: {
        documentURL: "https://s.com/",
        effectiveDirective: "img-src",
        blockedURL: "https://i.com/a",
      },
    };
    assert.equal(
      parseCspReports(JSON.stringify(Array(MAX_RECORDS + 10).fill(one))).length,
      MAX_RECORDS,
    );
  });
});

describe("the report endpoint", () => {
  const post = (body: string, ip = "203.0.113.7") =>
    new Request(`https://stellarischain.com${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/csp-report", "cf-connecting-ip": ip },
      body,
    });

  test("records sanitised reports and answers 204", async () => {
    const got: CspRecord[] = [];
    const res = await handleCspReport(
      post(legacy(), "198.51.100.1"),
      async (r) => void got.push(r),
    );
    assert.equal(res.status, 204);
    assert.equal(got.length, 1);
    assert.equal(got[0].blocked, "https://evil.example");
  });

  test("a storage failure is swallowed: still 204", async () => {
    const res = await handleCspReport(post(legacy(), "198.51.100.2"), async () => {
      throw new Error("db down");
    });
    assert.equal(res.status, 204);
  });

  test("a client sending too many reports is ignored after the limit", async () => {
    let n = 0;
    for (let i = 0; i < 40; i++)
      await handleCspReport(post(legacy(), "198.51.100.3"), async () => void n++);
    assert.equal(n, 30);
    assert.equal(allowReport("fresh-client"), true);
  });

  test("a declared oversized body is not read", async () => {
    let called = false;
    const req = new Request(`https://s.com${CSP_REPORT_PATH}`, {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1), "cf-connecting-ip": "198.51.100.4" },
      body: legacy(),
    });
    const res = await handleCspReport(req, async () => void (called = true));
    assert.equal(res.status, 204);
    assert.equal(called, false);
  });
});

describe("server wiring", () => {
  test("every response carries the report endpoints; the report path answers 204", async () => {
    const server = (await import("../server")).default;
    const res = await server.fetch(
      new Request(`https://stellarischain.com${CSP_REPORT_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/csp-report", "cf-connecting-ip": "198.51.100.9" },
        body: "{}",
      }),
      {},
      {},
    );
    assert.equal(res.status, 204);
    const csp = res.headers.get("content-security-policy-report-only") ?? "";
    assert.match(csp, /report-uri \/api\/public\/csp-report/);
    assert.match(csp, /report-to csp-endpoint/);
    assert.equal(res.headers.get("reporting-endpoints"), `csp-endpoint="${CSP_REPORT_PATH}"`);
    assert.equal(res.headers.get("content-security-policy"), null, "still report-only");
  });
});
