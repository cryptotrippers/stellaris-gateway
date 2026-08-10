# Receipt token — Stage 6

Status: **Step 2 complete — the vault now REQUIRES the receipt mint.**

Breaking: `yield_vault` moved to `e34414de8570158a207577dee9d1e77f6788154bff5057168f73e696`
(was `ff755a8e…`, and `623678fe…` before Stage 6), every applied address changed, and the State datum gained an
11th field. Any position at an old address must be withdrawn using the previous
build before the registry is re-bootstrapped.

## What it is

`validators/receipt.ak` is a minting policy that issues a fungible token
mirroring a depositor's claim on a `yield_vault`.

- 1 receipt unit = 1 **depositor** share (`total_shares - treasury_shares`).
- Token name = the vault's `asset_id` (e.g. `sfm-01`).
- Policy parameters: `receipt(vault_hash: ByteArray, asset_id: ByteArray)`,
  where `vault_hash` is the **applied** `yield_vault` script hash for that
  asset. A receipt for asset A therefore cannot exist against asset B's vault.

Unapplied blueprint hash (from `plutus.json`):
`ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d`
(pinned as `RECEIPT_BLUEPRINT_HASH` in `src/lib/yield-vault.ts`).

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

## Step 2 — the vault requires the mint

The binding is now two-way. The State datum carries an 11th field,
`receipt_policy: ByteArray`, written once at bootstrap and immutable across
every transition (`n_receipt_policy == receipt_policy`, and the value must be
exactly 28 bytes so an empty policy id can never alias the ada "policy").

`yield_vault` reads `receipt_delta = quantity_of(tx.mint, receipt_policy, asset_id)`
and enforces:

| Action | Rule |
| --- | --- |
| `Deposit` | `receipt_delta == minted` |
| `Withdraw { shares }` | `receipt_delta == -shares` |
| `Accrue`, `SetPaused`, `RotateCommittee`, `SetFee`, `ClaimFee` | `receipt_delta == 0` |

### No hash cycle

The vault hash depends only on `(version, asset_id)`; the policy is
parameterized by the *applied* vault hash. Deployment order is therefore
linear: derive the vault → derive the policy → bootstrap with the policy id in
the datum. `assertReceiptPolicy()` refuses to build a transaction whenever the
derived policy id differs from the one recorded in the vault's datum, which
also rejects pre-Stage-6 vaults outright.

## App wiring (done in this step)

- `src/lib/yield-vault.ts` — `RECEIPT_BLUEPRINT_HASH`/`_CBOR` pins,
  `getReceiptPolicy()` (re-hashes the unapplied blueprint before applying
  params), `assertReceiptPolicy()`.
- `src/lib/vault-bootstrap.ts` — writes the policy id into the state datum.
- `src/lib/yield-position.ts` — deposit mints, withdraw burns, both attach the
  policy and re-encode the 11-field datum.
- `src/lib/vault-accrual.ts` — carries the policy id through unchanged.
- `src/lib/yield-chain-decode.ts` — decodes 11 fields and exposes
  `receiptPolicy`. A 10-field (pre-Stage-6) datum no longer decodes, so old
  vaults read as "not bootstrapped" — intentional, they are unsupported here.

## Transferability status

**Receipts are proof of claim. They are not transferable value.** (AUDIT.md
V-04, decision (a).)

One receipt is minted per share and burned on redemption, so supply always
equals outstanding depositor shares. But redemption is authorized by the
`Position` datum's owner signature, not by holding the token. Therefore:

* transferring a receipt conveys **no** redemption right to the transferee —
  a secondary-market buyer acquires nothing enforceable;
* the receipt evidences that a deposit was made and how large the claim is,
  and nothing more.

Bearer-style, receipt-authorized redemption is a designed future stage. It is a
substantial contract change (owner authorization removed from `Withdraw`, payout
keyed to whoever burns N receipts, with its own double-satisfaction analysis)
and requires its own spec section before any code is written.

**No UI may present receipts as tradeable, transferable value, or a bearer
instrument until that stage ships.** Wherever a receipt balance is displayed it
must be labelled "proof of claim — not transferable value", and no transfer or
trade affordance may be offered. The yield vault card carries this label today.

## Remaining steps

3. Transferability: deferred by decision — see "Transferability status" above.
   Redemption stays owner-authorized until a bearer-redemption spec is written.
4. UI surfacing: show the receipt unit and wallet balance on the vault card.

## Build

```bash
cd contracts/vault
aiken check    # 101 tests
aiken build    # regenerates plutus.json (3 validators)
cd ../..
node scripts/verify-vault-hash.mjs --strict
```
