# Threat model — Stellaris Shield Phase 0 (31 Oct 2026)

Scope: Tessera (Rail A), fraction_vault v2 (Rail B), the app's signing path, and operations. Preprod only today. Build guide 13.1 asks for the full `THREAT-MODEL.md` before the audit freeze; this is the Shield baseline it grows from.

## Actors and what they could do

| Actor | Capability | Worst case today | Control |
|---|---|---|---|
| One committee key holder (compromised) | Signs any committee action | Nothing alone: every action needs M-of-N | INV-002 on chain |
| M committee keys (collusion or one machine) | Mint up to the attested ceiling; Attest any figure; ReportLoss; Draw first-loss (C-2 widens it); Defund after 7-day notice; Release fv2 net proceeds to the SPV; Rotate | Mint against a false attestation; write sTSRA value down; release raised funds early | Attestation is trust in the committee (BLOCKED on custodian); no proposal delay on Mint/Release/Rotate (MISSING); keys on one PC on Preprod |
| Keeper key | Settle pledges in any order | Delay or reorder settlement; cannot take funds | Owners refund after the window |
| Any user / attacker | Build any transaction | Planted States, forged pledges, token floods, double satisfaction, stale builds | Thread tokens, markers, clean-value rule, payout tags, exact datums — all with tests |
| Treasury key (single) | Spend protocol fees and SPV/treasury payouts on Preprod | Everything that has already left the scripts | MISSING: treasury contract or native multisig |
| Compromised app / backend | Build a malicious transaction for a user | Ask the wallet to sign something else | S1 intent guard + confirm dialog decode the actual tx before signing; Blockfrost key server-only; CSP report-only |
| Blockfrost (indexer) | Serve stale or false chain data | Wrong figures; stale builds | Builds re-read; scripts reject wrong state; index-lag waits; trust is in data freshness only |
| Supply chain (npm, Aiken stdlib) | Malicious dependency | Altered builders | bun 24 h release-age guard, dependency audit in CI, drift guard on blueprints |
| Operator PC | Holds every Preprod key | Full control of Preprod deployments | Acceptable for test only; mainnet key ceremony with hardware wallets (14.5) |

## Assets

On-chain: vault TSRA (stakes, Tickets), first-loss TSRA, queue Buffer (tUSD), fv2 escrow (TSRA). Off-chain: the attested reserve (does not exist yet as real assets), operator and committee keys, the Blockfrost key, Supabase service role.

## Out of scope for contracts (stated so nobody assumes otherwise)

- That the attested reserve exists (needs a custodian and an attestation process — counsel).
- Legal rights of fraction holders (SPV structure — counsel).
- Midnight proofs constraining Cardano UTxOs: they can't today; a committee-run adapter would be trusted (Meridian §6–8).
