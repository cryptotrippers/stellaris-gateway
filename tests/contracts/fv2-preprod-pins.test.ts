// The pinned Preprod v2 test offering re-derives to exactly the scripts the
// bootstrap opened on chain (30 Oct 2026). A wrong seed digit, a changed
// blueprint or a changed parameter order would fail here, not in the app.
import test from "node:test";
import assert from "node:assert/strict";
import * as L from "@lucid-evolution/lucid";
import { deriveV2 } from "../../src/lib/fraction-vault-v2";
import { OFFERING_V2_SEEDS } from "../../src/lib/vault-instances";

const TSRA = {
  policyId: "938b32e0f660dc06d3b58a20103cbe5ae1cc00531b53c7ba191d7400",
  assetNameHex: "54535241",
};

test("fv2 Preprod pin: fv2-test-01 re-derives to the offering opened on chain", () => {
  const key = `fv2-test-01:${TSRA.policyId}${TSRA.assetNameHex}`;
  const seed = OFFERING_V2_SEEDS[key];
  assert.ok(seed, "the test offering is pinned");
  const s = deriveV2(L as never, "fv2-test-01", TSRA, seed, "Preprod");
  assert.equal(s.offering.hash, "3b1ef5a251336cb8d3943c1e6778f6d676186223fed6fe9145ca02c9");
  assert.equal(
    s.offering.address,
    "addr_test1wqa3aadz2yekewxnjs7puemc7mt8vxrzy0lddl53gh9q9jgyyqrkl",
  );
  assert.equal(s.pledge.hash, "01b22716f4236c9fafd9bd070a0a130fcc98b0717c7a75ae7086ba5c");
  assert.equal(s.fraction.policyId, "4eed54e1a71fc1ad143b95b85228a51f76d5c0d0b19bc3e7ce00bc6c");
});
