import { describe, expect, test } from "bun:test";
import { retryPendingConfirmation } from "./confirmation-retry";

describe("bootstrap registration confirmation", () => {
  test("waits for indexing and then allows fee recording with the same submitted transaction", async () => {
    let registrations = 0;
    let feesRecorded = 0;
    const waits: number[] = [];
    const submitted = { txHash: "submitted-once", seed: "retained-seed" };
    const registered = await retryPendingConfirmation(async () => {
      registrations++;
      if (registrations < 3) throw new Error("NOT_CONFIRMED: not on chain yet");
      return submitted;
    }, () => {}, async (ms) => { waits.push(ms); });
    feesRecorded++;
    expect(registered).toBe(submitted);
    expect(registrations).toBe(3);
    expect(waits).toEqual([10_000, 10_000]);
    expect(feesRecorded).toBe(1);
  });

  test("does not retry authorization or invalid state errors", async () => {
    for (const message of ["Unauthorized", "No genuine State at address"]) {
      let calls = 0;
      let waits = 0;
      await expect(retryPendingConfirmation(async () => {
        calls++;
        throw new Error(message);
      }, () => {}, async () => { waits++; })).rejects.toThrow(message);
      expect(calls).toBe(1);
      expect(waits).toBe(0);
    }
  });

  test("stops after thirty waits and permits a later registration-only retry", async () => {
    let calls = 0;
    let waits = 0;
    await expect(retryPendingConfirmation(async () => {
      calls++;
      throw new Error("NOT_CONFIRMED");
    }, () => {}, async () => { waits++; })).rejects.toThrow("do not bootstrap again");
    expect(calls).toBe(31);
    expect(waits).toBe(30);
    expect(await retryPendingConfirmation(async () => "same-tx", () => {})).toBe("same-tx");
  });
});