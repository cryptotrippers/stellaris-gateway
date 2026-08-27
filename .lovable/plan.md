# Full-dApp readiness test for Stellaris on Cardano

Goal: run a real, repeatable test that tells us exactly how far the app is from being a
complete on-chain dApp — then close the gaps the test finds, in order.

## Part 1 — The readiness test (evidence, not opinion)

A single command, `bun run test:dapp`, backed by a new
`scripts/dapp-readiness.mjs`, produces a pass/fail table across five layers and writes
`docs/dapp-readiness.md` with the raw evidence (hashes, addresses, tx hashes, timestamps).

Checks:

1. **Contracts compile and match the pins** — `aiken check` + `aiken build` in all three
   contract packages, then `verify-vault-hash.mjs --strict`. Fails on any drift.
2. **Scripts are live on Preprod** — for each pinned validator (`vault`, `yield_vault`,
   `receipt`, `susdr_vault`, `usdr`, `multi_asset_vault`), derive the applied hash and
   address, then ask Blockfrost whether the script is on chain, whether the live CBOR is an
   exact match, and how many UTxOs sit at the address.
3. **Reference scripts** — every published `ref_script_utxos` row is still unspent
   (`verify-ref-scripts.mjs`), and each active vault has one.
4. **State integrity** — each registered vault in `asset_vaults` has exactly one canonical
   state UTxO, a bound receipt policy, and datum fields that round-trip through the decoder.
5. **End-to-end flow coverage** — for each user-facing action (bootstrap, deposit, partial
   withdraw, accrue, fee settle, receipt mint, governance execute), report whether a real
   Preprod tx hash exists in the app's history tables. No tx, no pass.

The report grades each item **live / wired-but-unproven / not implemented**, so "complete
dApp" becomes a measurable number instead of a claim.

## Part 2 — Gaps already visible, to close after the test confirms them

- **Multi-asset vault is derivation-only.** `src/lib/multi-asset-vault.ts` derives addresses
  and a developer card displays them, but nothing imports it for transactions: there are no
  bootstrap/deposit/withdraw/accrue builders, and the allocation flow still routes every
  denomination through the ADA yield adapter. Needs a `multi-asset-vault-tx.ts` builder set
  plus a `MultiAssetAdapter` implementing the existing `RwaVaultAdapter` interface, so a
  USDr deposit actually locks USDr at the multi-asset script.
- **No Preprod deployment for the multi-asset validator** — bootstrap one vault per
  supported live denomination, publish reference scripts, register the `asset_vaults` rows.
- **Governance is off-chain.** Votes are Supabase rows scoped by RLS; execution records a
  DB result. Bringing the vault-parameter proposals (`set_fee`, `pause`, `fund_asset`)
  on-chain means signing the corresponding vault redeemer and storing the tx hash as the
  proof of execution.
- **Share tokens are receipts, not transferable CIP-113 shares** — the receipt policy is
  bound 1:1 to a vault; a transferable share token is what makes the aggregator composable.

## Suggested order

1. Readiness script + report (no behaviour change, gives the baseline).
2. Multi-asset transaction builders + adapter wiring into the allocation flow.
3. Preprod bootstrap + reference scripts for the multi-asset vault.
4. On-chain execution proof for governance.
5. Transferable share tokens.

## Technical notes

- The readiness script is plain Node under `scripts/`, reusing `@lucid-evolution/lucid`
  `applyParamsToScript` for derivation and Blockfrost via `BLOCKFROST_PREPROD_PROJECT_ID`,
  exactly like `verify-live-scripts.mjs`; it runs read-only and signs nothing.
- New builders follow the existing convention: Lucid dynamically imported, browser-only,
  `getRefUtxoIfPublished` used when a reference script exists.
- Aiken source changes require `aiken build`, re-pinning the blueprint hash, and the CI
  drift job already covers all three packages.
- Preprod-only posture and the mainnet guard in `src/lib/network.ts` stay untouched.
