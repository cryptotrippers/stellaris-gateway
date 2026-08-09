# Stellaris Reference Scripts — Deployment and Safety

Status: Preprod deployment specification — address pending Step 0 confirmation

This document defines how Stellaris publishes and consumes Cardano reference
scripts for the `vault`, `yield_vault`, and receipt-token validators. Read this
before funding or spending any reference-script UTxO.

## 1. What reference scripts change

A reference script lets a spending transaction point to a previously published
validator instead of embedding that validator's CBOR in every transaction.

This reduces transaction size and therefore cuts transaction-size fees. It does
**not** reduce execution-unit fees: the validator still runs with the same
execution cost whether its CBOR is embedded in the transaction or supplied by a
reference script.

Reference scripts do not change validator behavior, datum rules, redeemer rules,
asset binding, authorization, or the required contract hash. They only change
how the validator bytes are supplied to the ledger.

## 2. Dedicated reference-script address

All reference-script UTxOs live at one dedicated Preprod address generated once
specifically for this purpose:

```text
<PASTE THE ADDRESS FROM STEP 0 HERE>
```

This placeholder must be replaced with the exact address recorded by the Step 0
procedure before any reference-script UTxO is funded or used. The address must
be independently checked on-chain and recorded with the deployment evidence.

The dedicated address must never be used for anything else:

- not for signing regular administrator transactions;
- not as the `vault` or `yield_vault` script address;
- not for user deposits, withdrawals, accruals, or governance actions;
- not as a general-purpose wallet address;
- not for unrelated ADA or native-asset storage.

The address is a reference-script publication location only.

## 3. Why the separation is mandatory

A reference-only UTxO has script bytes but no application datum. Placing that UTxO
at the vault's own script address creates a shape the validator does not expect:
a UTxO at the vault address with no `Position` or `State` datum. The vault must
only contain the datum-bearing outputs described in `SPEC.md` and `YIELD.md`.

The reference-script address must also be kept separate from everyday admin
signing. A wallet's automatic coin selection can otherwise select and spend a
reference UTxO to cover an unrelated transaction fee. That silently destroys
the published reference script for whichever validator and asset it belongs to,
breaking future transactions for that asset. Once spent, the reference UTxO
cannot be recovered or restored by the application.

## 4. Publication model

Each active validator version must have a distinct reference-script UTxO whose
script bytes match the verified build artifacts:

| Validator | Artifact source | Required identity |
| --- | --- | --- |
| `vault` | `contracts/vault/plutus.json` | Applied `vault` script hash and CBOR |
| `yield_vault` | `contracts/vault/plutus.json` | Applied `yield_vault` script hash and CBOR |
| `receipt` | `contracts/vault/plutus.json` | Applied `receipt` policy hash and CBOR |

The reference UTxO's script must be the exact script used by the transaction.
An unapplied blueprint, an old validator version, or a script for another asset
must not be used as a substitute.

When a validator changes, its hash, CBOR, and derived addresses must be treated
as changed until the new reference script is published and verified. Existing
reference UTxOs are never silently reinterpreted as a newer version.

## 5. Safety requirements

1. Build the contracts with the pinned toolchain and verify the generated
   `plutus.json` before publication.
2. Record the reference-script transaction hash, output index, script hash,
   validator title, network, and publishing address.
3. Fund the reference output with enough ADA to satisfy minimum-ADA requirements
   and leave it untouched thereafter.
4. Use a wallet or coin-selection policy that excludes the dedicated address's
   UTxOs from ordinary transactions.
5. Before every spend, verify that the selected reference UTxO is unspent and
   that its script hash matches the expected active validator identity.
6. Reject an unknown, missing, spent, or hash-mismatched reference UTxO.
7. Keep reference-script UTxOs separate per validator/version when their script
   identities differ; never use a reference UTxO for a different script.
8. Do not consider a transaction confirmed until the reference input and the
   resulting state transition are visible on Preprod.

## 6. Client and transaction rules

A client may use a reference script only after it has verified all of the
following:

- the network is Cardano Preprod;
- the validator identity is known and matches the pinned artifact;
- the reference UTxO is at the dedicated address above;
- the reference UTxO contains the expected validator script;
- the reference UTxO has not already been spent;
- the transaction's datum, redeemer, inputs, outputs, and signatories satisfy
  the validator specification.

The client must fail closed when any of these checks fails. It must not fall
back silently to an unknown or stale script. Embedding verified CBOR may be used
as an explicit compatibility path where reference-script publication is not yet
available, but that path must not weaken any contract or network guard.

## 7. Evidence gate

Reference-script deployment is complete only when the following evidence is
recorded:

- exact dedicated address from Step 0;
- publication transaction hash and reference output index for every active
  validator;
- verified on-chain script CBOR and computed hash for every reference output;
- a successful Preprod transaction that consumes the reference script;
- confirmation that transaction-size bytes and fees changed as expected while
  execution-unit fees remained governed by the same validator execution;
- a negative test showing an unknown or hash-mismatched reference script is
  rejected before submission;
- confirmation that ordinary admin coin selection cannot spend any reference
  UTxO.

Until this evidence exists, reference-script support remains a deployment
requirement, not a production-ready capability.

## 8. Mainnet boundary

This project is Preprod-only. Reference-script publication on Preprod does not
authorize mainnet use. Mainnet deployment remains blocked by the gates in
`NETWORK.md`, including contract rewrite completion, full testing, independent
audit, legal wrappers, KYC/AML enforcement, and approved treasury controls.
