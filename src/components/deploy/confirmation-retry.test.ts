import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { retryPendingConfirmation } from "./confirmation-retry";

describe("bootstrap registration confirmation", () => {
  test("waits for indexing and then allows fee recording with the same submitted transaction", async () => {
    let registrations = 0;
    let feesRecorded = 0;
    const waits: number[] = [];
    const submitted = { txHash: "submitted-once", seed: "retained-seed" };
    const registered = await retryPendingConfirmation(
      async () => {
        registrations++;
        if (registrations < 3) throw new Error("NOT_CONFIRMED: not on chain yet");
        return submitted;
      },
      () => {},
      async (ms) => {
        waits.push(ms);
      },
    );
    if (registered === submitted) feesRecorded++;
    assert.equal(registered, submitted);
    assert.equal(registrations, 3);
    assert.deepEqual(waits, [10_000, 10_000]);
    assert.equal(feesRecorded, 1);
  });

  test("does not retry authorization or invalid state errors", async () => {
    for (const message of ["Unauthorized", "No genuine State at address"]) {
      let calls = 0;
      let waits = 0;
      await assert.rejects(
        retryPendingConfirmation(
          async () => {
            calls++;
            throw new Error(message);
          },
          () => {},
          async () => {
            waits++;
          },
        ),
        { message },
      );
      assert.equal(calls, 1);
      assert.equal(waits, 0);
    }
  });

  test("stops after thirty waits and permits a later registration-only retry", async () => {
    let calls = 0;
    let waits = 0;
    await assert.rejects(
      retryPendingConfirmation(
        async () => {
          calls++;
          throw new Error("NOT_CONFIRMED");
        },
        () => {},
        async () => {
          waits++;
        },
      ),
      /do not bootstrap again/,
    );
    assert.equal(calls, 31);
    assert.equal(waits, 30);
    assert.equal(
      await retryPendingConfirmation(
        async () => "same-tx",
        () => {},
      ),
      "same-tx",
    );
  });
});
