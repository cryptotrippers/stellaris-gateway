import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkWalletNetworkAtConnect } from "./wallet-network-gate";

test("E21: a Preprod (testnet) wallet connects on a Preprod app", () => {
  assert.equal(checkWalletNetworkAtConnect(0, 0), null);
});

test("E21: a mainnet wallet is refused at connect with a clear message", () => {
  const r = checkWalletNetworkAtConnect(1, 0);
  assert.ok(r);
  assert.equal(r.kind, "wrong_network");
  assert.match(r.message, /mainnet/i);
  assert.match(r.message, /Preprod/);
});

test("E21: an unreadable network id is refused, never assumed safe", () => {
  for (const bad of [null, undefined, 2, -1, "0", NaN, {}]) {
    const r = checkWalletNetworkAtConnect(bad, 0);
    assert.ok(r, `expected refusal for ${String(bad)}`);
    assert.equal(r.kind, "wrong_network");
  }
});

test("E21: every connect path in wallet-store runs the gate before promoting state", () => {
  const src = readFileSync(new URL("./wallet-store.ts", import.meta.url), "utf8");
  // Browser connect, silent restore and WalletConnect approval.
  const calls = src.match(/checkWalletNetworkAtConnect\(/g) ?? [];
  assert.ok(calls.length >= 3, `expected 3 gate calls, found ${calls.length}`);
  for (const fn of ["connectWallet", "restoreOnce", "connectWithWalletConnect"]) {
    const start = src.indexOf(`async function ${fn}`);
    assert.ok(start >= 0, `${fn} not found`);
    const body = src.slice(start, src.indexOf("\nexport ", start + 10));
    const gate = body.indexOf("checkWalletNetworkAtConnect(");
    const promote = body.indexOf("connected: true");
    assert.ok(gate >= 0 && promote > gate, `${fn} must check the network before connecting`);
  }
});

test("E21: the mainnet guard in network.ts is still in force", () => {
  const src = readFileSync(new URL("./network.ts", import.meta.url), "utf8");
  assert.match(src, /export const MAINNET_NOT_ALLOWED = true;/);
});
