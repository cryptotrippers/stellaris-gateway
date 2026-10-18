# Restore legacy yield-vault balances and withdrawals

## Confirmed issue
The current app only recognises the newest yield-vault contract. Older v3 deposits are missing from portfolio balances and cannot be withdrawn through the app. A frozen-blueprint owner-authorised recovery script exists, but it is not a wallet-connected withdrawal screen.

The finding's v3-to-v4 evidence predates the current v5 build; the underlying UI compatibility gap remains. Recovery must not weaken the current vault's state-token or position-marker checks.

## Implementation
1. Verify the remaining v3 positions and registry addresses with read-only Preprod checks. Do not assume historical balances still exist.
2. Add a separate legacy-v3 reader using the frozen, hash-verified blueprint and the original 11-field State shape. Refuse ambiguous or malformed State; do not feed old data into current vault builders.
3. Include verified legacy positions in the connected wallet's portfolio, clearly marked as closing vaults. Show withdrawal only, never new deposits.
4. Adapt the existing owner-authorised exit logic into a browser wallet flow. Verify the owner, receipts, original address and policy; burn the correct receipts, preserve the old State shape, and display the amount before signing.
5. Confirm withdrawal on Preprod and refresh the portfolio from chain data. Never move funds automatically or request a wallet seed phrase/private key.
6. Add regression tests for 11-field decoding, exact script/policy verification, ambiguous State refusal, receipt coverage and withdrawal accounting.

## Technical boundaries
- Keep frozen-v3 compatibility in dedicated modules and a dedicated legacy-yield withdrawal panel; the existing single-owner LegacyVaultCard is a different contract.
- Do not modify contracts, Aiken sources, scripts, migrations or environment files.
- Preserve the Preprod-only guard and all v5 state-thread/position-marker protections.
- Record a finding as fixed only after a real owner-connected withdrawal is confirmed. Signing requires the user's wallet approval; without it, report the end-to-end check as blocked.

## Already addressed separately
Offering registration now retains the original opening transaction and seed, supports listing-only retries across reloads, rejects imprecise registry amounts before signing, and reconciles identical committed listings without overwriting another offering.

## Review
No publication. Review the preview before approving any owner-signed withdrawal.