# Funding request onboarding + management fee accrual

Two linked pieces: a governance-only path for new funding requests, and an annualised management fee that the yield vault enforces on chain by minting fee shares to the treasury.

## 1. Funding request onboarding (governance-only)

Any signed-in user can submit a funding request; there is no admin review gate. The request becomes a governance proposal, and only a passed proposal unlocks vault bootstrap.

Flow:

```text
draft request -> submit -> proposal (kind: fund_asset) -> voting window
   -> passed  -> asset row activated + vault bootstrap unlocked
   -> rejected -> request archived, reason retained
```

Request captures: asset name, category, issuer, location, description, target raise (ADA), minimum deposit, maturity in months, evidence/attestation links, reporting cadence, and the proposed fee schedule (see part 2).

New page `/funding/new` — multi-step form with a live preview of the resulting proposal. New page `/funding/$id` — read-only request record with its linked proposal, current vote tally, and outcome. Marketplace shows approved-but-unbootstrapped assets in a "Funding approved, vault pending" state rather than as investable.

Rules:
- No fabricated data: a request shows only what the submitter provided plus real vote counts.
- Bootstrap in `/operators` is blocked unless the linked proposal is `passed`, and the bootstrap writes the approved fee schedule into the vault datum.
- Voting weight uses the existing vault-position weighting; quorum/threshold reuse the existing 20% participation / 60% approval rules.

## 2. Management fee (annualised, paid in shares)

Model: fee is expressed in basis points per year on accounted assets. It is charged at each `Accrue`, prorated by elapsed time, and settled by minting new shares to the treasury rather than paying ADA out. This keeps every lovelace of capital in the vault and dilutes holders by exactly the fee.

Math (floor rounding, always in the protocol's favour, same convention as `shares.ak`):

```text
elapsed_ms   = accrual_time - last_fee_time
fee_assets   = total_assets * fee_bps * elapsed_ms / (10_000 * MS_PER_YEAR)
fee_shares   = fee_assets * total_shares / (total_assets - fee_assets)
```

`fee_shares` is derived so that the treasury's post-mint redeemable value equals `fee_assets`; existing holders are diluted, `total_assets` is untouched by the fee itself. Fee is charged before the yield amount is added, so a fee is never taken on yield that has not landed yet. Fee bps is capped on chain (proposed cap: 500 bps/yr) and can only change through a governance-executed action.

Depositor-facing display everywhere the vault appears: gross share price, fee bps, accrued-fee-to-date, and net share price.

## 3. Contract changes (Aiken)

In `lib/stellaris/shares.ak`:
- `fee_shares_for(acc, fee_bps, elapsed_ms)` pure function with the formula above, plus zero/short-elapsed/cap edge cases.
- Property tests: fee never exceeds cap, treasury value after mint ≈ fee_assets (floor), no fee when elapsed is 0, total_assets unchanged by the fee mint.

In `validators/yield_vault.ak`:
- Extend the state datum with `fee_bps`, `treasury_pkh`, and `last_fee_time`.
- `Accrue` must: charge the prorated fee, mint fee shares to a treasury position output, advance `last_fee_time` to the tx validity lower bound, then apply the yield amount.
- New `SetFee` redeemer, committee-signed, that only accepts a value within the cap and requires a governance execution reference.
- Reject any `Accrue` whose validity interval is unbounded (fee proration needs a real timestamp).

Then: `aiken check`, `aiken build`, re-pin `YIELD_BLUEPRINT_HASH` in `src/lib/yield-vault.ts` and CI, and re-bootstrap the Preprod `sfm-01` vault with the new script (existing shared-vault funds must be drained via the existing re-bootstrap card first).

## 4. Database

New `funding_requests` table (asset fields above, `status`, `submitted_by`, `proposal_id`) — public read, insert by the authenticated submitter, updates only by the submitter while `status = 'draft'`.

New `vault_fee_schedules` table (`asset_id`, `vault_version`, `fee_bps`, `treasury_address`, `effective_from_slot`, `set_tx_hash`) — public read, writes restricted to operators/admins and always backed by an on-chain tx hash.

`proposal_kind` gains `fund_asset` and `set_fee`.

## 5. App wiring

- `src/lib/funding-requests.functions.ts` — submit/list/read, creating the linked proposal in the same call.
- `src/lib/vault-fees.ts` — shared fee math mirroring the Aiken function exactly, used for previews and for the accrual builder.
- `src/lib/vault-accrual.ts` — include fee output and `last_fee_time` in the built tx; the multi-sig share links carry the fee terms so co-signers see what they are approving.
- `AccrueYieldCard` gains a fee breakdown (gross yield, fee assets, fee shares, net to holders) before signing.
- `YieldVaultActionsCard` and the asset detail page show gross/net share price and current fee bps from chain.

## Order of work

1. Aiken fee math + tests.
2. Validator datum/redeemer changes + tests; rebuild and re-pin hash; CI green.
3. Migration for `funding_requests`, `vault_fee_schedules`, new proposal kinds.
4. Funding request submission + detail pages, proposal linkage, bootstrap gate.
5. Fee-aware accrual builder, operator UI, depositor-facing net share price.
6. Re-bootstrap Preprod `sfm-01` and verify one fee-charging accrual end to end.
