import { test } from "node:test";
import assert from "node:assert/strict";
import { createTxConfirmQueue } from "./tx-confirm-queue";

test("the guard's request stays open until the person answers", async () => {
  const queue = createTxConfirmQueue();
  const promise = queue.handle("deposit", [
    "Sends 10.000000 ADA to vault:test",
    "Network fee 0.167810 ADA",
  ]);
  assert.deepEqual(queue.snapshot(), {
    action: "deposit",
    lines: ["Sends 10.000000 ADA to vault:test", "Network fee 0.167810 ADA"],
  });
  queue.settle(true);
  assert.equal(await promise, true);
  assert.equal(queue.snapshot(), null);
});

test("closing the dialog without answering is a cancel", async () => {
  const queue = createTxConfirmQueue();
  const promise = queue.handle("withdraw", ["Sends 5.000000 ADA to addr_test1qz..."]);
  // Escape, or any other close, only ever reports that the dialog went away.
  queue.settle(false);
  assert.equal(await promise, false);
  assert.equal(queue.snapshot(), null);
});

test("a second request cancels the first", async () => {
  const queue = createTxConfirmQueue();
  const first = queue.handle("deposit", ["Sends 1.000000 ADA to vault:test"]);
  const second = queue.handle("deposit", ["Sends 2.000000 ADA to vault:test"]);
  assert.equal(await first, false);
  assert.deepEqual(queue.snapshot()?.lines, ["Sends 2.000000 ADA to vault:test"]);
  queue.settle(true);
  assert.equal(await second, true);
});

test("an answer only counts once", async () => {
  const queue = createTxConfirmQueue();
  const promise = queue.handle("vote", ["Cast a vote"]);
  queue.settle(true);
  // The close that follows the button click must not undo the answer.
  queue.settle(false);
  assert.equal(await promise, true);
});

test("listeners are told when a request opens and closes", async () => {
  const queue = createTxConfirmQueue();
  const seen: Array<string | null> = [];
  const unsubscribe = queue.subscribe(() => seen.push(queue.snapshot()?.action ?? null));

  const open = queue.handle("deposit", ["Sends 1.000000 ADA to vault:test"]);
  assert.deepEqual(seen, ["deposit"]);
  queue.settle(true);
  assert.deepEqual(seen, ["deposit", null]);
  await open;

  unsubscribe();
  const after = queue.handle("withdraw", ["Sends 1.000000 ADA to addr_test1qz..."]);
  assert.deepEqual(seen, ["deposit", null]);
  queue.settle(false);
  await after;
  assert.deepEqual(seen, ["deposit", null]);
});
