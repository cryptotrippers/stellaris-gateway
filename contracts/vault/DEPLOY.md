# Stage 1 deployment checklist — Preprod vault v1

Stage 1 deploys the **parameterized vault** (`validator vault(_version: Int)`)
with `VAULT_VERSION = 1` to **Cardano Preprod**. There is no on-chain "deploy"
transaction for a spending validator: the script becomes live the moment the
first UTxO is locked at its applied address. Stage 1 is therefore: verify the
build is reproducible, verify the derived address, lock funds, unlock funds,
and record the result.

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
