# Network Status

This project targets **Cardano Preprod** at this time. Nothing in this repository is deployed to mainnet.

## Current state

| Component | Network | Status |
| --- | --- | --- |
| Aiken vault validator (`contracts/vault`) | Preprod | Preview — per-user key-hash vault; not audited. Do not use with real funds. |
| App frontend | — | Preprod-configured (`VITE_BLOCKFROST_NETWORK=preprod`). |
| Oracle feeds | — | None wired. |
| Treasury / buyback | — | Not activated. `treasury_address` is unset. |
| KYC attestations (Midnight) | — | Not activated. Interface reserved, no verifier connected. |
| Governance | — | Off-chain signalling only. Not CIP-1694-binding. |

## Path to mainnet

Mainnet deployment is explicitly gated on all of the following, in order:

1. Contract rewrite to a per-asset shared vault with fractional receipt tokens and a pull-model yield/refund path.
2. Full unit and property test suite in `contracts/`, including a double-satisfaction guard.
3. Reference-script deployment strategy (embedded scripts are prohibitively expensive at the ₳10 minimum deposit).
4. External audit by an independent firm, report and commit hash published to `contract_audits`.
5. Legal wrappers per listed asset (SPV / trust / tokenised-bond structure).
6. KYC/AML enforcement wired to a real verifier (Midnight or equivalent), not a badge.
7. Multisig treasury address published on `treasury_config` and populated only after governance approval.

Until every row above is satisfied, this repository ships with an in-app red `TESTNET` badge, and mainnet-config values are refused by `src/lib/network.ts`.

## Reporting

- Security disclosures: see `SECURITY.md` and `/.well-known/security.txt`.
- Changes to this document are tracked in `CHANGELOG.md`.
