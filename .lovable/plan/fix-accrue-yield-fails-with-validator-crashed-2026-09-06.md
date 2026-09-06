# Fix: "Accrue yield" fails with "validator crashed"

## Root cause (confirmed)

The yield vault contract (Stage 4/5, `contracts/vault/validators/yield_vault.ak`) requires every `Accrue` transaction to carry a **finite validity window on both ends**:

```text
Accrue { amount } -> {
  expect Some(now) = lower_bound_time(tx)   -- builder sets this (validFrom)
  expect Some(hi)  = upper_bound_time(tx)   -- builder NEVER sets this -> CRASH
  ... fee_anchor_ok(now, hi, last_fee_time) ...
}
```

The builder in `src/lib/vault-accrual.ts` only calls `.validFrom(settledAt)` (line 197). With no upper bound, `expect Some(hi)` fails and the script exits — exactly the on-chain error shown in the console: *"failed script execution Spend[0] the validator crashed / exited prematurely"*.

This is a code bug, not a wallet or state problem. Nothing the user clicks can fix it — no amount of re-bootstrapping will help, which is why Step 1 appeared stuck.

## Fix

In `src/lib/vault-accrual.ts` (`buildAccrual`):

1. Add `.validTo(...)` alongside `.validFrom(...)`, giving a short forward window (~15 minutes) so the transaction stays valid long enough to be signed and submitted, while keeping the fee anchor honest.
2. Keep `settledAt` as the lower bound (the validator pins the fee clock to it); the upper bound just needs to be finite and `>= now`.

## Also verified while diagnosing

- `Re-bootstrap` card reporting "nothing to re-bootstrap" is correct — registry addresses match the v3 script; no action needed there.
- `Deposit` / `Withdraw` (in `src/lib/yield-position.ts`) do not use the fee window, so they are unaffected.
- `SetFee` / `ClaimFee` have no transaction builder yet; when one is added it must set both bounds too (noted as a comment in the fix).

## How the user will verify

1. Go to /operators, connect the master wallet (Preprod).
2. Accrue yield card → select `ph-solar-01`, enter an amount, click **Build accrual**.
3. Sign in the wallet, click **Submit accrual** — the transaction should be accepted instead of crashing, and a "View transaction" link appears.
