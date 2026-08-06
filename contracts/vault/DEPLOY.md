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

---

# Stage 2 — Per-asset shared vaults

`validators/vault.ak` is now parameterized by `(version: Int, asset_id: ByteArray)`.
Each marketplace asset id compiles to its own applied script hash and address,
so one asset's deposits are physically unreachable from another asset's vault.
Spending rules inside a vault are unchanged and remain owner-scoped.

Because the parameter list changed, the **unapplied blueprint hash and CBOR
change**. The old single-parameter deployment
(`addr_test1wp2s0…qsshx`) is retired only after every UTxO there is withdrawn.

## Stage 2 — Step 1: rebuild and re-pin

```bash
cd contracts/vault
aiken check      # 6 unit tests should pass
aiken build      # regenerates plutus.json (unapplied blueprint, 2 params)
```

Report back:
- the `hash` field from `plutus.json`
- the `compiledCode` field from `plutus.json`

Pass condition: `aiken check` is 0 errors, 0 warnings, and the new unapplied
hash differs from `ae8cfbb91361…` (proof the parameter change took effect).

## Stage 2 — Step 2: pin and derive per-asset addresses

Once the new blueprint is pinned, the app derives `getVaultScript(assetId)`
per asset via `applyParamsToScript(cbor, [VAULT_VERSION, fromText(assetId)])`
and logs each derived address at first use.

## Stage 2 — Step 3: migrate liquidity

Before any deposit against the new addresses, withdraw all UTxOs from the
Stage 1 address. Deposits at the retired address remain spendable by their
owners but are no longer surfaced in the UI.

## Stage 2 — Step 4: per-asset live test

Deposit 2 tADA against `sfm-01`, confirm it lands at the `sfm-01` address only,
then withdraw. Repeat the deferred second-wallet negative test from Stage 1
Step 6 against the per-asset address.
