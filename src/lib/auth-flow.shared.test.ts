import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeAuthReturn,
  hasAuthReturn,
  isRecoveryReturn,
  isCurrentAuthRead,
  withTimeout,
} from "./auth-flow.shared";

test("internal destinations retain path, query and hash", () => {
  assert.equal(safeAuthReturn("/issuer?project=abc#journey"), "/issuer?project=abc#journey");
  assert.equal(safeAuthReturn("/funding/abc"), "/funding/abc");
});
test("absolute, protocol-relative and encoded external destinations are refused", () => {
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "%2f%2fevil.example",
    "/%2f%2fevil.example",
    "/\\evil.example",
    "%252f%252fevil.example",
    "javascript:alert(1)",
    "/%255cevil.example",
    "/\n/evil.example",
    null,
  ])
    assert.equal(safeAuthReturn(value), "/app");
});
test("auth, callback and recovery destinations cannot form login loops", () => {
  for (const value of [
    "/auth",
    "/auth/callback?redirect=/auth",
    "/forgot-password",
    "/reset-password",
    "/~oauth/callback",
    "/issuer/../auth/callback",
    "/%61uth/callback",
  ])
    assert.equal(safeAuthReturn(value), "/app");
});
test("expired/error returns and recovery fragments are recognised without treating type alone as auth", () => {
  assert.equal(hasAuthReturn("?error_code=otp_expired", ""), true);
  assert.equal(hasAuthReturn("?code=test", ""), true);
  assert.equal(hasAuthReturn("", "#access_token=test&type=recovery"), true);
  assert.equal(isRecoveryReturn("", "#type=recovery"), true);
  assert.equal(hasAuthReturn("?type=recovery", ""), false);
});
test("a late hydration read cannot replace a newer sign-out or sign-in", () => {
  assert.equal(isCurrentAuthRead(0, 1), false);
  assert.equal(isCurrentAuthRead(1, 1), true);
});
test("unresponsive actions settle with a bounded timeout", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), /timeout/);
  assert.equal(await withTimeout(Promise.resolve(true), 100), true);
});
