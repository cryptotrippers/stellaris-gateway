# Stellaris revenue contract — v4 yield vault

Turn the vault into a real revenue-earning contract: keep the existing annual management fee, add entry and exit fees taken on-chain, and charge an ADA listing fee for new projects and new proposals. All revenue lands with the treasury and can only be released by the operator committee (M-of-N signatures).

## What changes for people using it

- **Depositing**: a small percentage of each deposit goes to the treasury; the depositor sees the exact split before signing.
- **Withdrawing**: a small percentage of the payout goes to the treasury, shown in the confirm dialog.
- **Annual fee**: unchanged — already live, capped at 5%/yr, settled by issuing treasury shares.
- **Listing a project / opening a proposal**: the submitter pays a fixed ADA fee to the treasury; the submission only moves forward once that payment is confirmed on Preprod.
- **Collecting revenue**: on the operator console, the committee builds and co-signs a single "claim treasury revenue" transaction. No single person can move the money.

## Contract work (v4)

Extend `contracts/vault/validators/yield_vault.ak` in place (new version, new address — v3 vaults keep working):

1. State datum gains `entry_fee_bps` and `exit_fee_bps`, both immutable except through `SetFee`.
2. `SetFee` redeemer extends to `SetFee { fee_bps, entry_fee_bps, exit_fee_bps }`; all three validated against caps.
3. `Deposit`: of the incoming lovelace, `entry_fee` is computed in `shares.ak`, minted as treasury shares (same dilution-free pattern as the management fee) and the depositor mints shares only on the net amount. Receipt-mint delta tracks the depositor's shares only.
4. `Withdraw`: payout is reduced by `exit_fee`; the retained lovelace stays in the vault and is credited to the treasury as shares so accounting stays balanced.
5. `ClaimFee` stays committee-gated (already M-of-N) and is the only exit path for treasury value.
6. New caps in `contracts/vault/lib/stellaris/shares.ak`: `max_entry_fee_bps = 200`, `max_exit_fee_bps = 200`, with pure helpers `entry_fee_for`, `exit_fee_for` plus unit tests for rounding, zero-fee, and cap boundaries.
7. `aiken check` and `aiken build`; commit the regenerated `plutus.json`; re-pin the blueprint hash/CBOR in `src/lib/yield-vault.ts` and bump `YIELD_VERSION` to 4. `scripts/verify-vault-hash.mjs` must pass.

## App wiring

- `src/lib/vault.ts` / deposit and withdraw builders: compute and display the fee split, write the new datum fields.
- `src/lib/vault-set-fee.ts` + `SetFeeExecuteCard`: carry the two new rates through build, sign, submit and verification.
- `src/lib/yield-chain-decode.ts`: decode/encode the two new datum fields.
- New `src/lib/treasury-claim.ts` + an operator-console card: build, co-sign and submit `ClaimFee`, with both validity bounds set (V-05 rule).
- `src/components/vault/AllocationFlow.tsx`, `WithdrawVaultCard.tsx`, `AssetVaultPanel.tsx`: show fee lines and net amounts from real on-chain figures.

## Listing and proposal fees

- Migration: `listing_fees` table (kind, subject id, payer, amount_lovelace, tx_hash, network, verified_at) with RLS — owner reads own rows, admins read all, inserts server-side only.
- Server function verifies the payment tx through Blockfrost (correct treasury address, correct amount, confirmed) before marking a funding request or proposal as paid.
- `funding.new.tsx` and `governance.new.tsx` gain a pay-and-confirm step; fee amounts live in one config module so they can be changed without a contract change.

## Preprod deploy

1. Build and pin v4; run the blueprint drift guard.
2. Bootstrap a v4 vault for `ph-solar-01` from `/operators`, with treasury key and committee.
3. Run one real cycle: deposit (entry fee visible on chain), accrue, partial withdraw (exit fee), `SetFee` through a passed proposal, then a committee `ClaimFee`.
4. Publish reference scripts for the v4 validator and record the tx hashes.

## Notes

- v3 vaults are not migrated automatically; existing depositors withdraw from v3 and re-enter v4. The operator console will show both.
- Entry/exit fees start at 0 bps at bootstrap, so nothing is charged until governance sets them.
