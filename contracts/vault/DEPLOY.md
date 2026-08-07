# Contract deployment checklist — Cardano Preprod

The sections below preserve the historical Stage 1 and Stage 2 evidence, followed
by the active Stage 3 checklist. The current validator is parameterized by
`(version: Int, asset_id: ByteArray)` with `VAULT_VERSION = 2`.

The contract specification and test-vector matrix are recorded in `SPEC.md`.
There is no on-chain "deploy" transaction for a spending validator: the script
becomes live the moment the first UTxO is locked at its applied address. Every
stage therefore requires a reproducible build, address verification, live
transaction evidence, and a recorded pass condition before the next stage.

## Step 1 — Reproducible build (local, needs Aiken v1.1.23)

```bash
cd contracts/vault
aiken check      # expect: 5 checks, 0 errors, 0 warnings
aiken build      # regenerates plutus.json (UNAPPLIED blueprint)
cd ../..
node scripts/verify-vault-hash.mjs
```

Pass condition: `[verify-vault-hash] OK — blueprint matches (hash=ae8cfbb91361…)`.

If it reports drift, STOP. Either the Aiken source or the toolchain version
changed; do not deploy a validator whose hash you have not pinned.

## Step 2 — Derive and record the applied address

The app derives the applied script at boot. Open the preview, go to
`/marketplace/sfm-01`, open devtools console and record:

```
[vault] applied version=1 → hash=… address=addr_test1…
```

Pass condition: the address is stable across reloads and starts `addr_test1w`.
Record hash + address in `CHANGELOG.md` under the Stage 1 entry.

## Step 3 — Fund the deployer wallet

Preprod faucet: <https://docs.cardano.org/cardano-testnets/tools/faucet>.
Need ≥ 25 tADA so there is a clean pure-ADA UTxO available for Plutus
collateral (~5 tADA) on top of deposit + fees.

Pass condition: wallet connected, `NetworkBadge` reads Preprod, no
network-mismatch banner.

## Step 4 — Live lock (deposit)

On `/marketplace/sfm-01` → Deposit card → 2 ADA → sign.
Record the tx hash. Wait for the Tx History card to show **Confirmed**.

Pass condition: the UTxO appears at the applied address on
[Preprod CardanoScan](https://preprod.cardanoscan.io/) with an **inline datum**
whose single field equals your payment key hash.

## Step 5 — Live unlock (withdraw)

Withdraw card → **Unlock my vault UTxOs** → sign → **Confirm all**.

Pass condition: tx confirms, holdings return to zero, ADA lands back in the
wallet minus fees.

## Step 6 — Negative test (the security assertion) — deferred

This test is required before mainnet, but is deferred because a second wallet
is not currently available. Do not mark this security assertion as passed yet.

When a second Preprod wallet is available:

1. From the second wallet, deposit 2 ADA.
2. From the first wallet, verify the foreign UTxO is filtered out and the UI
   reports that none are owned by this wallet.
3. If the spend is forced for testing, the validator must reject it with a
   script execution error.

Pass condition: no wallet can spend another wallet's vault UTxO. Record the
second-wallet deposit hash and the rejected-spend result here before mainnet.

## Step 7 — Freeze

- `VAULT_VERSION` stays `1` — bumping it mints a new address and orphans
  liquidity at the old one.
- `VAULT_BLUEPRINT_HASH` / `VAULT_BLUEPRINT_CBOR` stay pinned.
- Any change to `validators/vault.ak` requires: withdraw all live UTxOs →
  rebuild → re-pin → bump `VAULT_VERSION` → redo Steps 1–6, including the
  deferred negative ownership test.

## Not in Stage 1

Mainnet, per-asset shared vaults, CIP-68 receipt tokens, governance/timelock
validator, and external audit. Those are Stages 2+ and must not be started
until every pass condition above is recorded.

---

# Stage 2 — Per-asset shared vaults

`validators/vault.ak` is parameterized by `(version: Int, asset_id: ByteArray)`.
Each marketplace asset id compiles to its own applied script hash and address,
so one asset's deposits are physically unreachable from another asset's vault.

The Stage 2 blueprint was applied with version `1` and is now retired for new
deposits. Existing version-1 UTxOs remain at their original addresses and must
be recovered with a version-1 legacy-unlock path.

## Stage 2 — completed verification

- Per-asset blueprint hash: `f49b09a840b0e4421a0abe6b58c3b2f0731b6510c25156e2542bfb3a`
- `(1, "sfm-01")` deposit and withdrawal were verified on Preprod.
- Per-asset isolation was verified with a separate asset vault.

---

# Stage 3 — Partial-withdrawal continuity

The validator now requires every output returned to the same script address to
carry an inline `VaultDatum` with the same owner. This makes partial withdrawal
safe in a shared vault: remainder cannot be re-datumed to another depositor or
left with a missing datum.

## Stage 3 — Step 0: specification gate

Read `SPEC.md` before changing the validator. The current Stage 3 behavior,
required evidence, migration rules, shared-accounting invariants, and test-vector
matrix must remain aligned with the implementation and app integration.

Pass condition: the contract scope and current test vectors are reviewed and no
receipt-token/shared-vault rewrite begins before the legacy and adversarial gates
are completed.

## Stage 3 — Step 1: reproducible build

```bash
cd contracts/vault
aiken check      # expect 10 checks, 0 errors, 0 warnings
aiken build      # regenerates plutus.json (unapplied blueprint, 2 params)
cd ../..
node scripts/verify-vault-hash.mjs
```

Pinned Stage 3 blueprint:

- Hash: `b582793a5e9bb3993ed68876ee017165808efb672e0d333e83975194`
- Applied version: `2`

## Stage 3 — Step 2: derive the new address

Regenerate the address registry from the pinned blueprint (no wallet needed):

```bash
node scripts/derive-vault-addresses.mjs sfm-01 sfm-02
```

Version-2 address registry (Preprod, `VAULT_VERSION = 2`):

| Asset | Applied script hash | Preprod address |
| --- | --- | --- |
| `sfm-01` | `f2bdf2698e28980b6b49d302a78ab469db5e3b27a02af6d41300e8cf` | `addr_test1wretmunf3c5fszmtf8fs9fu2k35akh3my7sz4ak5zvqw3nczk6cc5` |
| `sfm-02` | `0c55e92436ec3724e773706e74c6a2d2d7c73814f24dcfea072d3634` | `addr_test1wqx9t6fyxmkrwf88wdcxuaxx5tfd03eczneymnl2quknvdqtjfeda` |

When the app is refreshed, the browser console line
`[vault] applied version=2 asset=<id> → hash=… address=…` must match this table
exactly. If it does not, the deployed bundle is stale — do not fund the address.

Version-1 addresses are retired. No new deposit may target them; recovery of any
remaining version-1 UTxO is handled separately in Step 2 of the readiness plan.


## Stage 3 — Step 3: live Preprod test

1. Deposit at least 2 tADA into the version-2 `sfm-01` vault.
2. Confirm the transaction and inline owner datum on Preprod.
3. Withdraw and confirm the returned funds.
4. Later, test a partial withdrawal and verify the remainder retains the same
   owner datum.

Do not mark the deferred second-wallet negative test complete without a second
wallet. Do not bump `VAULT_VERSION` again without withdrawing every live UTxO
at the current applied address.
