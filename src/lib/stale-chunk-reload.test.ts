import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isStaleChunkError,
  recoverFromStaleChunk,
  shouldReloadForStaleChunk,
  type ReloadEnv,
} from "./stale-chunk-reload";

test("isStaleChunkError matches the browser chunk-load failure variants", () => {
  assert.ok(isStaleChunkError("Failed to fetch dynamically imported module: /assets/tessera-abc.js"));
  assert.ok(isStaleChunkError("error loading dynamically imported module: /assets/index.js"));
  assert.ok(isStaleChunkError("Importing a module script failed."));
  assert.ok(isStaleChunkError("Loading chunk 123 failed."));
  assert.ok(isStaleChunkError("Loading CSS chunk 456 failed"));
});

test("isStaleChunkError rejects unrelated errors", () => {
  assert.equal(isStaleChunkError("Network request failed"), false);
  assert.equal(isStaleChunkError("Cannot read properties of undefined"), false);
  assert.equal(isStaleChunkError(""), false);
});

test("shouldReloadForStaleChunk allows a first reload and rate-limits repeats", () => {
  assert.ok(shouldReloadForStaleChunk(100_000, null));
  assert.equal(shouldReloadForStaleChunk(100_000, 99_999), false);
  assert.equal(shouldReloadForStaleChunk(100_000, 40_000), false);
  assert.ok(shouldReloadForStaleChunk(100_000, 39_999));
});

function fakeEnv(start: number) {
  const state = { now: start, last: null as number | null, reloads: 0 };
  const env: ReloadEnv = {
    now: () => state.now,
    readLast: () => state.last,
    writeLast: (t) => {
      state.last = t;
    },
    reload: () => {
      state.reloads += 1;
    },
  };
  return { state, env };
}

test("recoverFromStaleChunk reloads once, then rate-limits", () => {
  const { state, env } = fakeEnv(1_000_000);
  const message = "Failed to fetch dynamically imported module: /assets/tessera-abc.js";

  assert.equal(recoverFromStaleChunk(message, env), true);
  assert.equal(state.reloads, 1);
  assert.equal(state.last, 1_000_000);

  assert.equal(recoverFromStaleChunk(message, env), false);
  assert.equal(state.reloads, 1);

  state.now += 61_000;
  assert.equal(recoverFromStaleChunk(message, env), true);
  assert.equal(state.reloads, 2);
});

test("recoverFromStaleChunk ignores non-chunk errors", () => {
  const { state, env } = fakeEnv(0);
  assert.equal(recoverFromStaleChunk("Some other failure", env), false);
  assert.equal(state.reloads, 0);
  assert.equal(state.last, null);
});
