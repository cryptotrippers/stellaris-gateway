# Receipt token — Stage 6

Status: **Step 1 complete (policy compiled + tested, not yet required by the vault).**

## What it is

`validators/receipt.ak` is a minting policy that issues a fungible token
mirroring a depositor's claim on a `yield_vault`.

- 1 receipt unit = 1 **depositor** share (`total_shares - treasury_shares`).
- Token name = the vault's `asset_id` (e.g. `sfm-01`).
- Policy parameters: `receipt(vault_hash: ByteArray, asset_id: ByteArray)`,
  where `vault_hash` is the **applied** `yield_vault` script hash for that
  asset. A receipt for asset A therefore cannot exist against asset B's vault.

Unapplied blueprint hash (from `plutus.json`):
`ca06d650b0ff77c959b3776771c3438bb61fe99a072eeb59d8cedb18`

## Rules enforced

The policy never decides supply — it reads the vault's own state transition
and forces the mint to match it:

1. exactly one `State` UTxO at `vault_hash` is spent **and** one recreated;
2. exactly one token name moves under this policy, and it equals `asset_id`;
3. `minted_quantity == depositor_shares_after - depositor_shares_before`;
4. a zero delta is rejected, so the policy cannot be attached as a no-op.

Consequences per vault action:

| Vault action | Depositor-share delta | Receipts |
| --- | --- | --- |
| `Deposit` | `+minted` | mint exactly that many |
| `Withdraw { shares }` | `-shares` | burn exactly that many |
| `Accrue` | 0 (treasury shares only) | none — policy refuses |
| `SetFee` | 0 | none — policy refuses |
| `ClaimFee` | 0 (total and treasury fall together) | none — policy refuses |
| `SetPaused`, `RotateCommittee` | 0 | none — policy refuses |

Treasury fee shares deliberately have **no** circulating token: they are an
internal claim until the treasury converts them out through `ClaimFee`.

## Deliberate limitation of Step 1

`yield_vault` does **not** yet require this policy to run. The binding is
one-way today:

- a receipt can never exist without a matching vault transition;
- a vault transition can still happen without receipts.

That keeps `YIELD_BLUEPRINT_HASH` (`623678fe…`) and the deployed Preprod
addresses untouched. Making the vault *require* the mint is Step 2 and is a
breaking change — the vault hash moves, every applied address changes, and
every live position must be withdrawn from the old address first.

## Remaining steps

1. ~~Policy + unit tests~~ (done, 12 tests).
2. Vault-side requirement: `Deposit`/`Withdraw` assert
   `quantity_of(tx.mint, receipt_policy, asset_id) == shares_delta`. Requires
   parameterizing the vault by the receipt policy id (or a two-step deploy
   with a hash-cycle break, since the policy is parameterized by the vault
   hash — resolve by naming the policy from a one-shot NFT ref instead).
3. Transferability: decide whether a receipt holder or the `Position` owner
   authorizes redemption. Today the `Position` owner does; a transferable
   receipt only becomes meaningful once redemption is receipt-authorized.
4. TS wiring: derive the applied policy id in `src/lib/yield-vault.ts`, attach
   mint/burn to the deposit and withdraw builders, pin the blueprint hash the
   same way `YIELD_BLUEPRINT_HASH` is pinned.

## Build

```bash
cd contracts/vault
aiken check    # 89 tests
aiken build    # regenerates plutus.json (now 3 validators)
cd ../..
node scripts/verify-vault-hash.mjs --strict
```

`verify-vault-hash.mjs` still pins only `vault` and `yield_vault`; the receipt
hash is pinned here in this document until Step 4 wires it into the app.
