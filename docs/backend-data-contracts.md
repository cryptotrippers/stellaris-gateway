# Backend data contracts needed by the Marketplace 2.0 front end

The redesigned pages show every one of the fields below as "Not published",
"Waiting for backend" or "Waiting for legal/compliance approval" until a
server-authorised source exists. Nothing here is stored today. This file lists
what the front end expects, so the backend can be built to match — it is a
proposal, not a schema change.

All amounts are integers in the smallest unit of their currency, with an
explicit `currency` code. Every record carries `source` (who or what produced
it) and `recorded_at` (ISO timestamp). Status changes are made only by
server-side functions that check the caller's role; the browser never decides
a gate.

## 1. Asset passport (per asset, public)

| Field | Type | Used in |
| --- | --- | --- |
| legal_wrapper | text (SPV, trust, company, co-operative) | Passport A/B, Clarity "Legal rights" |
| issuing_vehicle_name, issuing_vehicle_registration | text | Passport A |
| unit_type, total_units, unit_price | text, integer, integer | Passport B, cards |
| investor_rights_summary, transfer_restrictions | text (from approved legal docs) | Passport B |
| soft_cap, hard_cap, funding_deadline | integer, integer, timestamp | Passport C |
| risk_class | enum | Marketplace filter, card |
| income_source | text | Card, Passport E |
| distribution_frequency | enum (monthly, quarterly, annual) | Marketplace filter |
| project_maturity | enum (concept, construction, operating) | Marketplace filter |
| last_report_at | timestamp | Card |

## 2. Clarity Standard (per asset, public)

Seven items (`legal_rights`, `issuer_identity`, `asset_verification`,
`financial_disclosures`, `fees_expenses`, `liquidity_exit`, `risks`), each with
`status` ∈ published | verified | pending | not_applicable | illustrative,
`evidence_document_id`, and — for `verified` only — `reviewer`, `reviewed_at`
and a link to the review record. A document link alone must never produce
`verified`.

## 3. Documents (public metadata; files in a private data room)

`id, asset_id, category` (Legal, Ownership, Financial, Insurance, Technical,
Valuation, Operating Agreements, Impact Reports)`, title, version, issued_at,
visibility` (public | private)`, sha256, verification_status, verified_by,
verified_at`. Public passports list only `visibility = public`.

## 4. Issuer data room (private) — built

Implemented without schema changes: files live in the private
`project-documents` bucket (no storage policies), each with a sidecar
`meta.json` holding category, version, SHA-256, status (pending, released,
rejected, withdrawn, superseded), reviewer note and history. Server functions
in `src/components/documents` enforce access. A future database table could
replace the sidecar files for reporting and cross-project queries;
request-for-information notices are still to come.

## 5. Issuer journey gates

Server-recorded decisions for Gate A (issuer verified — exists today via
`issuers.verification_status`), Gate B (listing approval — today derived from
governance execution), Gate C (funding conditions met) and Gate D (milestone
release approved). Each decision: `gate, decided_by, decided_at, evidence_ids,
note`.

## 6. Escrow and milestone releases

Escrow state per offering using the twelve proposed states (Subscriptions Open
… Completed), each transition backed by a confirmed transaction hash. Milestone
records: `name, required_amount, evidence_status, approval_status,
released_amount, release_tx_hash, released_at`. A release counts only when its
transaction is confirmed on chain.

## 7. Asset-to-Yield Engine output

Per asset and period: waterfall steps (`label, amount, running_total_before,
running_total_after, kind`), allocation shares, per-unit summary
(`units, unit_price, distributable_cash, distribution_per_unit,
cash_yield_pct`), scenarios and sensitivity rows. The front-end types live in
`src/components/finance/types.ts`; components render whatever the engine
returns and perform no financial calculations.

## 8. Distributions and investor entitlements

`asset_id, period, per_unit, total, status` (forecast | approved | funded |
paid)`, payment_date, tx_hash` (required for `paid`). Per investor:
`units_held, purchase_cost, reported_valuation, valuation_date,
distributions_received, pending_entitlements`.

## 9. Public pipeline read model

A server function that returns only publicly approved fields and excludes
withdrawn, rejected and draft applications. Today `listPipeline` reads public
rows and the page hides rejected ones client-side; the server should filter
instead.

## 10. Notifications and reporting

Issuer notifications (review requests, RFIs, decisions) and periodic operating
report submissions with `period, revenue, operating_costs, material_events,
submitted_at, reviewed_at`.
