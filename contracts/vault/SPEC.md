# Stellaris Vault Contract Specification

Status: Preprod Stage 3 specification gate

This document is the source of truth for the validator behavior, safety invariants,
and evidence required before the receipt-token/shared-vault rewrite. It describes
the currently deployed-compatible Stage 3 position model first, then the required
behavior for the next contract family.

## 1. Scope and network boundary

- Current network: Cardano Preprod only.
- Current active validator: `vault(_version: Int, _asset_id: ByteArray)`.
- Current active app version: `VAULT_VERSION = 2`.
- Each asset id derives a distinct applied script and address.
- Version 1 remains a legacy address and must not receive new deposits.
- No mainnet funds may be accepted until the gates in `NETWORK.md` pass.

## 2. Current Stage 3 datum and redeemer

### Datum

```text
VaultDatum {
  owner: payment key hash
}
```

The datum owner is the payment key hash authorized to spend that position. The
current datum does not represent shares, asset metadata, yield, fees, epochs, or
a timelock.

### Redeemer

```text
VaultRedeemer = Withdraw
```

`Withdraw` is the only supported action in the current validator.

## 3. Current Stage 3 state transitions

### Deposit

A user creates an output at the applied asset vault address with:

- an inline `VaultDatum` containing the user's payment key hash;
- the deposited ADA value;
- no requirement for a script redeemer, because the validator is not spent.

The deposit transaction must not be treated as confirmed until the output is
visible on-chain with the expected inline datum.

### Full withdrawal

A spend of one or more positions is valid only when all of the following hold:

1. Each input has a valid `VaultDatum`.
2. The datum owner appears in `tx.extra_signatories`.
3. At least one transaction output pays to an address whose payment credential is
   that same owner key hash.
4. Every output returned to the spent script hash contains an inline datum whose
   owner is unchanged.
5. Value and fee conservation are enforced by the Cardano ledger.

### Partial withdrawal

A position may be spent while returning a remainder to the same script address.
The returned output must contain an inline datum with the original owner hash.
A missing datum or a datum naming another owner must fail validation.

### Invalid transitions

The validator must reject:

- a missing or malformed datum;
- an unknown redeemer;
- a transaction signed only by a different wallet;
- a transaction with no output paying the datum owner;
- a same-script continuation with no inline datum;
- a same-script continuation assigned to another owner.

## 4. Current isolation and migration rules

- `(version, asset_id)` is compile-time parameterization, not runtime datum data.
- A UTxO at one applied script hash cannot be spent through another asset's
  applied script.
- Changing either parameter creates a distinct script instance and address.
- The app must show the active version/address before allowing a new deposit.
- Existing version-1 UTxOs require a dedicated version-1 unlock path; they must
  never be silently interpreted as version-2 positions.
- A version bump requires draining the old active address, rebuilding, pinning the
  new blueprint hash/CBOR, and repeating the full Preprod test matrix.

## 5. Required evidence for the current Stage 3 gate

The following evidence is required before the receipt-token rewrite:

- reproducible Aiken build and pinned blueprint verification;
- version-2 applied address recorded per supported asset;
- fresh version-2 full deposit and withdrawal transaction hashes;
- fresh version-2 partial withdrawal transaction hash;
- on-chain proof that the partial-withdrawal remainder preserves the owner datum;
- second-wallet negative test showing a foreign position cannot be spent;
- test evidence that version-1 legacy positions remain discoverable and recoverable.

## 6. Next contract family: shared accounting requirements

The next validator must not be implemented until these accounting decisions are
written and reviewed:

- asset unit and decimal policy;
- receipt token policy id, asset name, and transferability;
- conversion formula between deposited value and receipt shares;
- treatment of fees, yield, losses, dust, and rounding;
- partial redemption formula and minimum remaining value;
- epoch/valuation source and stale-price behavior;
- emergency pause and recovery behavior;
- upgrade/version policy and migration of existing positions;
- whether a receipt holder or a separate owner credential authorizes redemption.

## 7. Invariants for the shared-vault rewrite

These must hold for every valid transaction:

1. **Supply accounting:** receipt supply equals the sum of all outstanding holder
   positions, subject only to a documented and bounded rounding rule.
2. **Asset backing:** redeemable claims cannot exceed the vault's accounted assets
   after documented fees and losses.
3. **No double satisfaction:** one input or receipt balance cannot satisfy two
   independent redemption claims in the same transaction.
4. **Asset binding:** a receipt for asset A cannot redeem asset B.
5. **Authorization:** only the position owner or approved transferable receipt
   holder can redeem.
6. **Continuity:** any state returned to the validator carries the expected
   datum/version and preserves all required accounting fields.
7. **Monotonic state:** nonce/epoch/version fields cannot move backward.
8. **Emergency limits:** pause and recovery paths cannot redirect user funds to
   an arbitrary signer or treasury address.
9. **Value conservation:** all minted/burned receipt quantities are matched by
   the corresponding vault accounting transition.

## 8. Test vector matrix

| Case | Expected result |
| --- | --- |
| Owner signs and receives full withdrawal | Accept |
| Wrong signer only | Reject |
| No signer | Reject |
| Owner signs but receives no output | Reject |
| Owner receives one of multiple outputs | Accept |
| Partial withdrawal with same-owner inline datum | Accept |
| Partial withdrawal with another owner's datum | Reject |
| Partial withdrawal with no datum | Reject |
| Full withdrawal with no continuation output | Accept |
| Foreign wallet attempts to spend another owner's position | Reject |
| Asset A position spent through asset B script | Reject |
| Duplicate input reference in one spend | Reject |
| Receipt burn without corresponding redemption | Reject |
| Redemption without sufficient receipt balance | Reject |
| Stale oracle/epoch claim outside policy | Reject |
| Paused vault accepts ordinary withdrawal | Reject or allow only the explicitly documented emergency path |

The first nine cases are covered by the current Stage 3 validator tests. The
remaining cases are requirements for the live adversarial suite and the next
contract family.
