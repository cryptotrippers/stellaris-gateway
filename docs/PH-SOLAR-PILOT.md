# Batangas Rooftop Solar Pilot — Preprod Demonstration

> **This is a Preprod demonstration, not a real investment.** Nothing on this
> page describes a real solar project, a real legal entity, or real cash
> flows. It exists to prove the mechanics of a fractionalized, share-accrual
> yield vault on Cardano Preprod end to end — deposit, accrual, redemption,
> receipt accounting, and governance — using test-ADA (tADA) that has no
> monetary value. See `NETWORK.md` for what would actually be required before
> anything like this could touch mainnet or real funds.

## What this is

`ph-solar-01` is a demo asset carried through the protocol's real pipeline —
a funding request, a `fund_asset` governance proposal, a passed vote, and an
executed proposal that creates the `assets` row — exactly the path a genuine
funding request would take. The only thing "demo" about it is the scenario
behind the numbers: there is no rooftop, no panels, no revenue. Everything
after asset creation (vault bootstrap, deposits, an accrual, a withdrawal) is
a real Preprod transaction against the real Aiken validators in this repo.

## Modeled scenario (illustrative — not a real site)

To give the demo a concrete shape, the deposit target and the single accrual
run in Phase 3 are modeled against a hypothetical rooftop installation:

| Assumption | Illustrative value | Basis |
| --- | --- | --- |
| Array size | 500 kWp rooftop commercial array | Typical scale for a mid-size Philippine commercial rooftop installation — chosen for narrative plausibility, not measured |
| Capacity factor | ~15% (Batangas irradiance is decent but not exceptional; rooftop tilt/orientation is rarely optimal) | Illustrative planning assumption |
| Modeled monthly generation | ~54,750 kWh (500 kWp × 15% × 730 h) | Arithmetic on the assumptions above, not a metered reading |
| Modeled monthly revenue (avoided-cost basis) | Mapped to **3 tADA** for the single `Accrue` in this demo | Chosen to be a clean, legible on-chain number — see below |

**The mapping from "modeled kWh" to "3 tADA" is a narrative convenience, not
a pricing model.** This pilot does not implement a revenue oracle, a
PHP/ADA exchange rate, or a metering feed. The vault's on-chain accounting
does not know or care what backs an `Accrue` — it only enforces that the
committee threshold signs it and that the value increase matches the
redeemer, exactly as `YIELD.md` specifies. Whoever runs `Accrue` in this demo
is asserting "3 tADA of modeled revenue landed," and the chain enforces the
bookkeeping of that assertion, nothing more.

## What's real vs. simulated

| | Real | Simulated |
| --- | --- | --- |
| Vault mechanics — share minting, `Accrue` accounting, fee dilution, receipt mint/burn, withdrawal | ✅ Real Preprod transactions against the real validators | |
| Governance — the funding request, the `fund_asset` proposal, the vote, execution | ✅ Real rows, real vote tallies, real quorum/threshold math | |
| The solar project itself, its revenue, its operator | | ⚠️ Entirely fictional — a narrative device for the demo |
| The "3 tADA" accrual amount | | ⚠️ A round number chosen for legibility, not derived from a live feed |

## Legal and operational status

Issuer of record: **"Stellaris Demo Pilot — no legal entity; Preprod
demonstration only."** There is no company, cooperative, or SPV behind this
asset. No KYC/AML is performed. No real ADA is ever at risk — Preprod's
tADA has no exchange value.

## Path to anything real

This pilot demonstrates on-chain mechanics only. Turning a scenario like this
into a real, fundable asset would require, at minimum, everything `NETWORK.md`
already lists as a mainnet gate:

1. Contract rewrite completion and full test/property coverage (see
   `contracts/vault/AUDIT.md`).
2. Reference-script deployment strategy proven on Preprod (`REFSCRIPTS.md`).
3. An independent external audit, published with a commit hash.
4. A real legal wrapper for the asset (SPV, trust, or equivalent) and a real
   issuer of record.
5. A real revenue attestation path — metered generation data or an oracle
   feed, not an operator's typed-in `Accrue` amount.
6. KYC/AML enforcement wired to a real verifier.
7. A published, governance-approved multisig treasury.

Until all of those exist, every number on this page and every UI surface for
`ph-solar-01` stays labeled as a Preprod demonstration.
