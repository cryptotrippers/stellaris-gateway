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
  operators:     List<ByteArray>, -- authorized signer key hashes
  threshold:     Int,             -- M of N required for Accrue / Pause / Unpause
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
  | Pause | Unpause         -- M-of-N operators only
```

`Accrue` never changes `total_shares`; it is the only path that raises share
price. A negative `amount` (loss reporting) is out of scope for Stage 4 and
must be specified before mainnet.

## 5. Invariants (must hold for every valid tx)

1. `total_shares == Σ position.shares` across all vault UTxOs.
2. `total_assets <= lovelace actually held at the script address` (minus min-ADA).
3. `Accrue` requires at least `threshold` distinct signatures from `operators`
   **and** an on-chain value increase at the script address of exactly `amount`.
4. `Withdraw` requires the owner signature, an owner-paid output, and
   owner-preserving datum continuity (Stage 3 rule, retained).
5. `epoch` is strictly monotonic. No transition may decrease it.
6. Exactly one `VaultState` output is returned per tx; it cannot be duplicated,
   destroyed, or re-datumed to a different operator set or a lower threshold.
7. While `paused`, only `Withdraw` at the last settled share price is allowed;
   `Deposit` and `Accrue` fail.
8. Operators can never direct value to an address they control.
9. `threshold >= 1`, `threshold <= length(operators)`, and `operators` contains
   no duplicates — enforced on every returned state output.

## 6. Attack surface to test

| Case | Expected |
| --- | --- |
| Deposit inflating shares by pre-donating ADA to the address | Reject (donation raises `A` only via `Accrue`) |
| First depositor share-price manipulation (`S == 0` grief) | Reject via minimum initial deposit |
| Two withdrawals satisfied by one state output | Reject (double satisfaction) |
| `Accrue` without matching value increase | Reject |
| `Accrue` signed by fewer than `threshold` operators | Reject |
| Duplicate operator key counted twice toward threshold | Reject |
| State re-datumed to `threshold = 1` or an attacker operator set | Reject |
| State UTxO spent without being recreated | Reject |
| Withdraw with `shares > position.shares` | Reject |
| Rounding drain loop (many 1-share redeems) | Bounded: each loses dust to the vault, never gains |

## 7. Build order

1. **This spec** — approved: share accrual, M-of-N operator authority.
2. Aiken types + pure share-math functions with property tests (no validator wiring).
3. `Deposit` / `Withdraw` with the state UTxO, unit + negative tests.
4. `Accrue`, pause/unpause, M-of-N threshold tests.
5. Rebuild blueprint → `VAULT_VERSION = 3`, derive per-asset addresses.
6. Preprod proof matrix: deposit, accrue, partial redeem, full redeem, second wallet rejection.
7. Replace `src/lib/yield-engine.ts` simulation with reads of real share price and epoch.

## 8. Stage 5 — committee rotation and value purity

Two validator changes, both breaking (the blueprint hash moves, so the vault
address changes and must be re-derived).

### 8.1 `RotateCommittee { operators, threshold }`

Previously the operator set was immutable for the life of a vault: a lost or
compromised operator key permanently disabled `Accrue` and `SetPaused`, and the
only remaining exit was for every depositor to withdraw. Rotation closes that.

Rules:

* authorized by **M-of-N of the OUTGOING committee** (the incoming one has no
  say — it does not exist yet on-chain);
* the incoming committee must satisfy `operators_valid` (no duplicates,
  `1 <= threshold <= N`), so an unsatisfiable committee can never be installed;
* the redeemer's `(operators, threshold)` must equal what is actually written
  into the returned `State`, so the witness set proves intent over the exact
  new committee;
* the rotation must be a **no-op for money**: `value_delta == 0`,
  `shares_delta == 0`, epoch, assets, shares and the pause flag all unchanged.
  A rotation can therefore never be bundled with an accrual or a withdrawal;
* rotating to the same committee is rejected.

Every other action still asserts `committee_unchanged`, so rotation is the only
path by which the committee can move.

### 8.2 Lovelace-only outputs

Every output returned to the vault address must now be pure lovelace
(`values_pure`). Without this, anyone could attach arbitrary native tokens — or
a large batch of them — to a Position or to the State UTxO. That raises the
min-ADA requirement of that UTxO above its accounted lovelace, at which point
the funds it holds can no longer be paid out: a permanent lock on real money
placed by a third party at negligible cost.
