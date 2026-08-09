# Stellaris briefing pack for Claude AI

Produce a single self-contained markdown briefing document that another AI (Claude) can read cold and use to write up Stellaris yield finance: how the protocol makes money, the fee mechanics, what a real-world project must supply to be onboarded, and the gap between a real-world asset and what the chain can currently enforce.

The document is a deliverable, not an app feature. No routes, components, contracts or database changes.

## Where it goes

`/mnt/documents/stellaris-yield-finance-brief.md` — downloadable, paste-ready into Claude. Nothing in `src/` changes.

## What goes in it

**1. What Stellaris is (one page)**
Cardano protocol for tokenised real-world yield. Shared multi-depositor vaults, one per asset, parameterised by `(version, asset_id)`. Preprod today. Stage 3 per-owner vault, Stage 4 shared yield vault, Stage 6 transferable receipt tokens.

**2. The share engine — how value is measured**
Depositors mint shares against accounted assets; the issuer raises `total_assets` via `Accrue`, which lifts every holder's redeemable value pro rata without changing share counts. States the exact rules from the contract: 1:1 bootstrap share price, floor rounding always in the protocol's favour, 10 ADA minimum first deposit (inflation-grief defence), 2 ADA minimum surviving position.

**3. How Stellaris makes money — the fee model**
The only protocol revenue line that exists on chain today:
- Annual management fee in basis points on accounted assets, hard-capped at 500 bps (5.00%/yr) by the validator.
- Prorated by wall-clock time against a 365-day year, anchored to the transaction's validity lower bound so the operator cannot inflate elapsed time.
- Settled by **minting shares to the treasury**, not by moving lovelace: holders are diluted by exactly the fee and the treasury redeems later via `ClaimFee`.
- Worked numeric example (fee assets → fee shares → dilution → treasury claim) so Claude can reproduce the arithmetic.
- Explicit list of revenue lines that do **not** exist yet: performance/carry fee, entry or exit fee, spread on `Accrue`, secondary-market fee on receipt transfers.

**4. Who is allowed to touch the money**
M-of-N operator committee stored in the vault datum; `Accrue`, `SetFee`, `ClaimFee`, `SetPaused` and `RotateCommittee` all require threshold signatures, the committee cannot be weakened by ordinary spending, and every non-deposit action is forbidden from minting receipts.

**5. Onboarding — what a real-world project must supply**
Drawn from the live funding-request pipeline: asset slug, legal issuer, category, location, description of where the yield actually comes from, target raise, minimum deposit, maturity, reporting cadence, at least one https evidence link (title, licence, audit), proposed fee in bps, treasury address. Submitting is only a claim — it creates no asset, derives no vault and moves no money until governance votes.

**6. The Real-to-Stellaris gap (the core section)**
Honest two-column treatment: what the chain enforces versus what still depends on a human or an off-chain institution.

| Real-world need | On chain today | Gap |
| --- | --- | --- |
| Asset exists and is owned | nothing | legal title, SPV, custody |
| Revenue actually arrived | `Accrue` raises assets on committee signature | no oracle proof that cash landed |
| Investor is permitted | none | KYC/AML, accreditation, jurisdiction |
| Redemption is honoured | vault pays from its own lovelace | no bridge from bank cash to vault |
| Reporting | evidence URLs, cadence field | no attestation, no auditor signature |
| Default / impairment | pause only | no write-down path, no waterfall |

Each row gets the concrete mechanism that would close it (attested oracle feed, credential-gated deposits, off-chain settlement agent, signed auditor attestations, an impairment redeemer), and honest sequencing.

**7. Fee-to-yield relationship**
How management fee, accrual cadence and net investor yield interact, and why a fee charged on assets rather than on profit means the vault can dilute holders in a zero-accrual period — the thing an institutional reader will ask about first.

**8. Prompt block for Claude**
A short appendix telling Claude the audience, tone, and the hard rule: use only the numbers in this brief, invent no APYs, TVL or partner names.

## Ground rules

- Every number and rule cited comes from the actual code — the 500 bps cap, 365-day year, 10 ADA and 2 ADA floors, share formulas, committee rules, funding-request validation.
- Anything not built is labelled as not built. No fabricated metrics, yields, or counterparties.
- Written so it reads correctly whether Claude is asked for a whitepaper section, an investor memo, or a docs page.

## Technical notes

Sources: `contracts/vault/lib/stellaris/shares.ak`, `contracts/vault/validators/yield_vault.ak`, `src/lib/vault-fees.ts`, `src/lib/funding-requests.functions.ts`, plus the `funding_requests` and `vault_fee_schedules` tables. No build, migration or contract step is involved.
