# Changelog

All notable changes to this project are recorded in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project is currently pre-1.0. The public API, on-chain contract addresses, and database schema may change without notice until v1.0.

## [Unreleased]

### Added
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

[Unreleased]: about:blank
