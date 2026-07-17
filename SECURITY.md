# Security Policy

Stellaris Finance is a real-funds Cardano dApp. We take responsible disclosure seriously.

## Reporting a vulnerability

Please email **security@stellaris.finance** with details.
For sensitive reports, encrypt with our PGP key (fingerprint TBD — see `/.well-known/security.txt`).

Include:
- A clear description of the issue
- Steps to reproduce (proof-of-concept is welcome)
- The affected commit or deployment (preprod / mainnet)
- Your contact information for follow-up

Please **do not** open a public GitHub issue for security reports. Do not disclose the issue publicly until we have coordinated a fix.

## Scope

In scope:
- The Aiken vault validator under `contracts/vault/`
- The TanStack Start application (this repository)
- The Supabase-backed backend (server functions, edge routes, RLS policies)
- Any deployed contract on Cardano preprod or mainnet whose address is published in this repository

Out of scope:
- Third-party dependencies unless the vulnerability is uniquely exploitable via our integration
- Social engineering of team members
- Denial of service via traffic volume
- Reports produced only by automated scanners without a working proof-of-concept

## Response commitment

- **Acknowledgement:** within 3 business days of receipt.
- **Initial assessment:** within 10 business days.
- **Fix timeline:** severity-dependent; critical issues on mainnet are treated as pager-level incidents.

## Safe harbor

We will not pursue legal action against researchers acting in good faith who:
- Make a genuine effort to avoid privacy violations, data loss, and service disruption.
- Only interact with accounts they own or have explicit permission to access.
- Report the issue to us before public disclosure and give us reasonable time to remediate.

## Bounty

A formal bug bounty program will launch alongside the first external contract audit. Until then, reporters of confirmed vulnerabilities receive public acknowledgement in the repository release notes if they wish.

## Network status

The current deployment targets **Cardano Preprod**. Mainnet deployment is gated on a completed external audit (see `contracts/README.md` when published).
