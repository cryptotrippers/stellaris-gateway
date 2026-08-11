# Changelog

All notable changes to this project are recorded in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is currently pre-1.0. The public API, on-chain contract addresses, and database schema may change without notice until v1.0.

## [Unreleased]

### Added
- `src/lib/yield-chain-decode.ts` now exports `encodeStateDatum`, the single writer for the yield vault's State datum, replacing three independent hand-rolled encoders (`vault-bootstrap.ts`, `vault-accrual.ts`, `yield-position.ts`) — closes `AUDIT.md` O-02, with `scripts/verify-state-datum-roundtrip.ts` added as a CI regression.
- `assertYieldVaultAddress` is now called by every builder that spends an existing yield-vault UTxO (`loadMyVaultView`, `depositToYieldVault`, `withdrawFromYieldVault`, `buildAccrual`) and by `useDerivedVaultAddress`'s staleness check — closes `AUDIT.md` O-01.
- `contracts/vault/SPEC.md` defining the current Stage 3 state transitions, migration rules, shared-accounting invariants, and ordered contract test vectors.
- `scripts/derive-vault-addresses.mjs`, which derives the applied version-2 script hash and Preprod address per asset directly from the pinned blueprint.
- A version-2 address registry and a live Preprod proof table in `contracts/vault/DEPLOY.md`.

### Changed
- Contract work now follows explicit evidence gates before any receipt-token or shared-vault rewrite.

### Added (existing)
- Public `SECURITY.md` with responsible-disclosure policy and safe-harbor language.
- `NETWORK.md` documenting current testnet/mainnet status.
- `/.well-known/security.txt` route (RFC 9116).
- Real-data foundations: `assets`, `contract_audits`, `oracle_feeds`, `treasury_config`, `treasury_events`, and `kyc_attestations` tables. All start empty; the app renders honest empty states instead of hardcoded numbers.
- Persistent testnet/mainnet network badge in the top navigation.
- Network-switch help modal with wallet-specific instructions.

### Changed
- Portfolio dashboard, governance console, and marketplace are queried live from Supabase / on-chain state instead of mock arrays.
- "Audited" and "ZK-Verified" badges no longer render statically; they appear only when a corresponding row exists in `contract_audits` or `kyc_attestations`.

### Removed
- `src/lib/mock-data.ts` and every route import that pulled fabricated numbers from it.

## [0.0.0] — Preprod preview
- Initial preprod deployment. Single per-user Aiken vault. Preview-only.
- Stage 1 Step 2 verified: `VAULT_VERSION = 1` applied Preprod vault address is `addr_test1wp2s0pzntrc2g5vumu690f5ljjr6n9tk0ps8hdgs4kf2v3sqqsshx` (script hash `5507845358f0a4519cdf3457a69f9487a9957678607bb510ad92a646`).
- Stage 1 Step 5 verified: withdrawal transaction `8b5aa72d08cd518e257d4d1a7fa7553686ff6b0cfe216bb181399ba03fa22947` confirmed on Preprod at block `5,025,492`; two vault UTxOs were spent successfully.
- Stage 1 Step 6 deferred: second-wallet negative ownership test remains required before mainnet.

## [Stage 2] — Per-asset shared vaults (Preprod)
- Validator parameterized by `(version: Int, asset_id: ByteArray)`; unapplied blueprint hash `f49b09a840b0e4421a0abe6b58c3b2f0731b6510c25156e2542bfb3a`.
- Applied `(1, "sfm-01")` → script hash `cfc0779a34d4687415b16df0228d39c3f95a3c1bb2c8ba1383342bab`, Preprod address `addr_test1wr8uqau6xn2xsaq4k9klqg5d88pljk3urwev3wsnsv6zh2ctm7djh`.
- Step 2 verified: deposit `061d809cbff5c7208098a430195cf1ffbd0bc6970178391d41a1f06d3e76c64e` (block 5,025,584) locked 5 tADA at the per-asset address.
- Step 3 verified: withdrawal `9543b7e95b40a6140aa7217d104587e6c6e2704444497cb314abecaf1e630978` (block 5,025,589) spent the script UTxO with a redeemer, `valid_contract: true`.
- Retired: Stage 1 address `addr_test1wp2s0pz…qsshx` still holds 7 tADA from txs `8d867bfd…` and `e76a7066…`; a legacy-unlock path is required to recover it.

## [Stage 3] — Partial-withdrawal continuity (Preprod)
- Added owner-preserving datum continuity for partial withdrawals in the shared vault validator.
- Local Aiken validation completed: 10 checks, 0 errors, 0 warnings.
- Stage 3 unapplied blueprint pinned in the app: `b582793a5e9bb3993ed68876ee017165808efb672e0d333e83975194`.
- Active app derivation is now `VAULT_VERSION = 2`; version-1 and version-2 addresses are intentionally distinct.
- Before any version-2 deposit, verify the derived per-asset address and complete a new deposit/withdrawal test. Existing version-1 UTxOs require a separate legacy-unlock path.

[Unreleased]: about:blank
