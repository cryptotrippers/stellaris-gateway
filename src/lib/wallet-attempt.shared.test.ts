import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalletAttemptGate } from "./wallet-attempt.shared";

test("cancelled approval cannot connect a wallet", () => {
  const gate = createWalletAttemptGate();
  const request = gate.begin();
  gate.cancel();
  assert.equal(gate.current(request), false);
  assert.equal(gate.pending, false);
});
test("reconnect supersedes an old result and old finally cannot end the new attempt", () => {
  const gate = createWalletAttemptGate();
  const old = gate.begin();
  gate.cancel();
  const next = gate.begin();
  gate.finish(old);
  assert.equal(gate.current(old), false);
  assert.equal(gate.current(next), true);
  gate.finish(next);
  assert.equal(gate.pending, false);
});
test("a failed attempt can finish then retry without stale pending state", () => {
  const gate = createWalletAttemptGate();
  const first = gate.begin();
  gate.finish(first);
  const retry = gate.begin();
  assert.equal(gate.current(retry), true);
  assert.notEqual(first, retry);
});
