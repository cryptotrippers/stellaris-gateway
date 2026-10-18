import { describe, expect, test } from "bun:test";
import {
  offeringRegistrationSchema,
  pendingOfferingSchema,
  priceInBaseUnits,
  registryInteger,
  registerOpeningOnce,
  retryOfferingRegistration,
  type PendingOffering,
} from "./offering-registration.shared";

const payload = {
  assetId: "ph-solar-01",
  network: "preprod",
  vaultVersion: 2,
  scriptHash: "a".repeat(56),
  scriptAddress: "test-address",
  fractionPolicyId: "b".repeat(56),
  fractionAssetNameHex: "00",
  depositAssetId: null,
  totalFractions: 1000,
  pricePerFraction: 1000000,
  mintFeeBps: 0,
  redeemFeeBps: 0,
  issuerName: "Test issuer",
  treasuryAddress: null,
  operatorKeyHashes: ["c".repeat(56)],
  signatureThreshold: 1,
  bootstrapTxHash: "d".repeat(64),
};
const pending: PendingOffering = { payload, seed: { txHash: "e".repeat(64), outputIndex: 0 } };
const row = {
  asset_id: payload.assetId,
  network: payload.network,
  vault_version: payload.vaultVersion,
  script_address: payload.scriptAddress,
  script_hash: payload.scriptHash,
  fraction_policy_id: payload.fractionPolicyId,
  bootstrap_tx_hash: payload.bootstrapTxHash,
};

describe("offering listing recovery", () => {
  test("a network failure preserves original transaction and seed across reload", async () => {
    const saved = JSON.stringify(pending);
    await expect(
      retryOfferingRegistration(
        pending,
        async () => {
          throw new Error("Blockfrost 503");
        },
        async () => {},
      ),
    ).rejects.toThrow("503");
    const restored = pendingOfferingSchema.parse(JSON.parse(saved));
    const attempts: string[] = [];
    await retryOfferingRegistration(
      restored,
      async (data) => {
        attempts.push(data.bootstrapTxHash);
      },
      async () => {},
    );
    expect(attempts).toEqual([payload.bootstrapTxHash]);
    expect(restored.seed).toEqual(pending.seed);
  });

  test("confirmation timeout can be retried with the same paid transaction", async () => {
    let attempts = 0;
    await expect(
      retryOfferingRegistration(
        pending,
        async () => {
          attempts++;
          throw new Error("NOT_CONFIRMED");
        },
        async () => {},
      ),
    ).rejects.toThrow("NOT_CONFIRMED");
    expect(attempts).toBe(31);
    let recoveredHash = "";
    await retryOfferingRegistration(
      pending,
      async (data) => {
        recoveredHash = data.bootstrapTxHash;
      },
      async () => {},
    );
    expect(recoveredHash).toBe(payload.bootstrapTxHash);
  });

  test("lost success response returns matching committed row without another insert", async () => {
    let inserts = 0;
    const result = await registerOpeningOnce(
      payload,
      async () => row,
      async () => {
        inserts++;
        return row;
      },
    );
    expect(result).toEqual(row);
    expect(inserts).toBe(0);
  });

  test("concurrent registration reconciles a committed identical opening", async () => {
    let reads = 0;
    const result = await registerOpeningOnce(
      payload,
      async () => (++reads === 1 ? null : row),
      async () => {
        throw new Error("duplicate key");
      },
    );
    expect(result).toEqual(row);
    expect(reads).toBe(2);
  });

  test("a conflicting on-chain opening is never overwritten", async () => {
    let inserts = 0;
    await expect(
      registerOpeningOnce(
        payload,
        async () => ({ ...row, bootstrap_tx_hash: "f".repeat(64) }),
        async () => {
          inserts++;
          return row;
        },
      ),
    ).rejects.toThrow("different opening");
    expect(inserts).toBe(0);
  });

  test("unsafe registry integers are rejected before signing", () => {
    expect(registryInteger(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => registryInteger(9007199254740992n)).toThrow();
    expect(
      offeringRegistrationSchema.safeParse({ ...payload, totalFractions: 9007199254740992 })
        .success,
    ).toBe(false);
  });

  test("decimal prices retain exact base units rather than rounding", () => {
    expect(priceInBaseUnits("1.000001", 6)).toBe(1000001n);
    expect(priceInBaseUnits("0.0000001", 6)).toBe(0n);
    expect(priceInBaseUnits("1.2.3", 6)).toBe(0n);
  });
});
