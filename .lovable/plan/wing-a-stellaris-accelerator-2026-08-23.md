# Wing A — Stellaris Accelerator

Turn the app from a working demo into the tool that gets real projects onto Preprod (and later mainnet): a structured issuer onboarding toolkit, a public pipeline dashboard, and simulated allocation + education for Cardano wallet holders.

Today the app has funding requests (`/funding`), governance, marketplace, and an operators console for vault bootstrap. What's missing is the verification layer between "someone submitted a claim" and "governance can responsibly vote": there is no issuer verification record, no impact attestation, no readiness checklist, and no public view of where each project sits in the pipeline.

## 1. Issuer onboarding toolkit

Extend the existing funding-request flow rather than replacing it.

- **Issuer profile**: legal entity name, jurisdiction, registration number, contact, wrapper type (SPV, co-op, trust, none). One issuer can own several projects.
- **Verification checklist** per funding request, with fixed items: legal wrapper evidence, asset title/lease, operating licence, insurance, offtake/revenue agreement, technical audit, impact methodology. Each item has status (missing / submitted / verified / rejected), an https evidence link, a note, and who verified it.
- **Impact attestation template**: structured per-project metrics (metric name, unit, baseline, target, measurement method, reporting cadence, attester). Rendered as a fill-in form, exportable as a public JSON/markdown attestation.
- **Readiness score**: derived, not stored — percentage of required checklist items verified. Governance proposals show it; promoting a request to a vote below a threshold shows a prominent warning (not a hard block — governance stays sovereign).
- **Deployment runbook**: the existing operator bootstrap steps rendered as a per-project checklist (derive address, bootstrap state UTxO, publish reference scripts, verify hashes), each step reflecting live on-chain state where we can read it.

## 2. Public Project Pipeline Dashboard (`/pipeline`)

One public page, no login, built for sharing:

- Kanban-style stages: **Submitted → Verifying → Proposed → Approved → Vault live → Reporting**.
- Each card: project, issuer + verification badge, jurisdiction/wrapper, readiness score, target raise, proposed fee, current stage, and where the money actually is (nothing / vault live with on-chain TVL).
- Filters by stage, category, jurisdiction. Per-project detail links into the existing funding and marketplace pages.
- Top-line honest counters: verified operators, projects with a live vault, total on-chain TVL, total impact metrics attested. Zeros are shown as zeros — no fabricated numbers, per existing project rules.
- Full SEO head metadata + shareable OG copy so the pipeline is the public proof point.

## 3. Simulated allocation + education

- **Allocation simulator** on the pipeline and project pages: enter an amount, pick a project, see projected share issuance, management-fee drag using the real on-chain fee formula, and value at maturity across conservative/base/optimistic yield inputs. Clearly labelled illustrative, no fabricated APY — it reuses `vault-fees` and the accrual math already in the codebase.
- **Learn section** (`/learn`, a few short routes): what a tokenised RWA vault is, how deposits and shares work, what governance actually controls, what Preprod means and why nothing here has real value, how to connect a Cardano wallet. Each route gets its own metadata for search traffic.

## 4. Revenue surface (scaffolded, off by default)

Stripe is already wired. Add an issuer-facing **listing/verification service fee** at the point of submitting a request, and a **premium analytics** tier gate on export/API access. Both behind a config flag so nothing charges until you switch it on. No governance token work in this pass.

## Technical notes

- New tables (all with GRANTs + RLS): `issuers`, `issuer_verifications`, `funding_request_checklist`, `impact_attestations`, `impact_metrics`. Public read on verification status and attestations; writes restricted to the submitting user or an admin via the existing `has_role` function.
- Verification status changes are admin-only and append to `security_audit_log` so the record is tamper-evident.
- Pipeline data read through a public server function using the publishable client (no auth), so the page prerenders and shares cleanly.
- On-chain TVL and vault-live status come from existing hooks (`useVaultHoldings`, `asset-vaults.shared`), not from database mirrors.
- New routes: `/pipeline`, `/pipeline/$slug`, `/issuers/$id`, `/learn/*`; onboarding steps extend `funding.new.tsx` and `funding.$id.tsx`.
- Readiness score is computed in a shared module used by both UI and MCP tools; add a `list_pipeline` MCP tool so agents can read the pipeline too.

## Suggested order

1. Schema + issuer profile & checklist UI on existing funding pages.
2. Impact attestation template and public attestation view.
3. `/pipeline` dashboard with live on-chain status and SEO.
4. Allocation simulator + `/learn` content.
5. Revenue flags (off by default).
