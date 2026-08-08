# Stellaris Yield Engine — On-Chain Specification (Stage 4, Step 1)

Status: draft specification. No validator code changes until this document is
approved. This is the accounting contract that the current UI "yield engine"
(`src/lib/yield-engine.ts`, today a simulation) must be replaced by.

## 1. Model choice

Two candidate models were considered:

| Model | How yield reaches a holder | Contract complexity | Failure mode |
| --- | --- | --- | --- |
| **A. Push distribution** | Issuer sends a payout tx that pays each holder directly | Off-chain heavy, on-chain trivial | Issuer must enumerate every holder; fails/censors at scale |
| **B. Share accrual (recommended)** | Issuer deposits yield into the vault; every position's redeemable value rises pro rata | Moderate | Requires exact share math and rounding rules |

**Recommendation: Model B (share accrual, pull-based redemption).** It keeps
payouts O(1) for the issuer, removes holder enumeration, and never pushes ADA
to an address the holder did not sign for.

## 2. State

Each depositor position is a UTxO at the applied `(version, asset_id)` address:

```text
VaultDatum {
  owner:   ByteArray,   -- payment key hash (unchanged from Stage 3)
  shares:  Int,         -- position's share count, > 0
  epoch:   Int,         -- accrual epoch the position was last settled at
}
```

A single **vault state UTxO** at the same address holds the aggregate:

```text
VaultState {
  total_shares:  Int,   -- sum of all outstanding position shares
  total_assets:  Int,   -- lovelace accounted as backing (excludes min-ADA)
  epoch:         Int,   -- monotonic; increments on each yield settlement
  operator:      ByteArray, -- key allowed to submit Accrue, nothing else
  paused:        Bool,
}
```

State and positions are distinguished by datum constructor tag, not by address.

## 3. Formulas

Let `S = total_shares`, `A = total_assets`, deposit `d`, redeem `s` shares.

```text
mint_shares(d)   = if S == 0 then d else floor(d * S / A)
redeem_value(s)  = floor(s * A / S)
share_price      = A / S            (reported, never stored)
apy_window(t0,t1)= (price(t1)/price(t0))^(31_536_000/(t1-t0)) - 1
```

Rounding is always **floor in the protocol's favour**: minted shares round
down, redeemed lovelace rounds down. The residual dust stays in `total_assets`
and accrues to remaining holders. Maximum loss per action is 1 lovelace.

Guards:
- `mint_shares(d) > 0` — deposits too small to mint a share are rejected.
- `redeem_value(s) >= min_ada` or the position must be closed entirely.
- A partial redeem must leave `shares_remaining > 0` and `redeem_value >= min_ada`.

## 4. Redeemers

```text
VaultRedeemer =
  | Deposit                 -- create/extend a position, mint shares
  | Withdraw { shares: Int }-- burn shares, take redeem_value(shares)
  | Accrue   { amount: Int }-- operator adds yield: total_assets += amount, epoch += 1
  | Pause | Unpause         -- operator only
```

`Accrue` never changes `total_shares`; it is the only path that raises share
price. A negative `amount` (loss reporting) is out of scope for Stage 4 and
must be specified before mainnet.

## 5. Invariants (must hold for every valid tx)

1. `total_shares == Σ position.shares` across all vault UTxOs.
2. `total_assets <= lovelace actually held at the script address` (minus min-ADA).
3. `Accrue` requires the operator signature **and** an on-chain value increase
   at the script address of exactly `amount`.
4. `Withdraw` requires the owner signature, an owner-paid output, and
   owner-preserving datum continuity (Stage 3 rule, retained).
5. `epoch` is strictly monotonic. No transition may decrease it.
6. Exactly one `VaultState` output is returned per tx; it cannot be duplicated,
   destroyed, or re-datumed to a different operator.
7. While `paused`, only `Withdraw` at the last settled share price is allowed;
   `Deposit` and `Accrue` fail.
8. The operator can never direct value to an address it controls.

## 6. Attack surface to test

| Case | Expected |
| --- | --- |
| Deposit inflating shares by pre-donating ADA to the address | Reject (donation raises `A` only via `Accrue`) |
| First depositor share-price manipulation (`S == 0` grief) | Reject via minimum initial deposit |
| Two withdrawals satisfied by one state output | Reject (double satisfaction) |
| `Accrue` without matching value increase | Reject |
| State UTxO spent without being recreated | Reject |
| Withdraw with `shares > position.shares` | Reject |
| Rounding drain loop (many 1-share redeems) | Bounded: each loses dust to the vault, never gains |

## 7. Build order

1. **This spec** — approve model, formulas, rounding, operator role.
2. Aiken types + pure share-math functions with property tests (no validator wiring).
3. `Deposit` / `Withdraw` with the state UTxO, unit + negative tests.
4. `Accrue`, pause/unpause, operator tests.
5. Rebuild blueprint → `VAULT_VERSION = 3`, derive per-asset addresses.
6. Preprod proof matrix: deposit, accrue, partial redeem, full redeem, second wallet rejection.
7. Replace `src/lib/yield-engine.ts` simulation with reads of real share price and epoch.
