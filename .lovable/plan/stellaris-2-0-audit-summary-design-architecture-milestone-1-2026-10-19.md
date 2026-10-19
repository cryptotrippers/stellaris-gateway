# Stellaris 2.0 — audit summary, design architecture, Milestone 1–2

Nothing is published. Work stays in preview until you approve a release.

## Where things stand (audit)

The full audit already exists (`docs/platform-audit.md`). It will be refreshed to use the brief's five labels:

| Area | Status |
| --- | --- |
| Wallet connect + wrong-network block, Preprod-only lock | WORKING |
| Chain health, project registry, sign-in and roles, offering-listing retry | WORKING |
| Yield vault deposit/withdraw/accrue | WORKING on Preprod; older-vault withdrawals BROKEN (open finding) |
| Fraction offerings, governance execution, issuer funding requests, operator console, payments (test mode), developer API/MCP, invite system | UNVERIFIED end to end |
| Tessera/sTSRA staking, reserve and transparency figures, 3 marketplace projects | DEMO (illustrative) |
| Property AU/SEA, independent audit, early-access list, blog, issuer lead pipeline, Trust Centre, Clarity Standard, investor app sections | PLANNED / not built |
| Tests | Contract tests (Aiken) + one app test file; no wider app tests |

Already done from your earlier briefs: new colour palette and fonts, rebuilt home page, rebuilt marketplace and project pages.

## Design architecture

Three visual modes from one shared set of colours:

```text
Clear Standard  -> light, editorial: home, About, Trust Centre, Learn
Tangible Future -> warm photography: marketplace, project pages, For Issuers
The Protocol    -> dark navy/teal: Tessera, staking, transparency, governance, app
```

- Colours: the nine exact brand values added as named tokens (deep becomes #081A2A, aqua #39CBBB added); every page reads from them.
- Shared building blocks: status badge (Published / Pending / Not applicable / Illustrative and Verified / Pending / Demo / Unknown), data-source stamp (source + timestamp), disclosure banner, section header, product card, step diagram, dark "protocol panel".
- Navigation: Logo | Explore | Tessera | Transparency | Learn | For Issuers | About | Open Demo. Admin/protocol links move into the app's own menu. Mobile: collapsible menu + small sticky "Open Demo" button.
- Existing addresses stay working (e.g. /stake, /yield, /offerings); new pages are added rather than renamed.

## Milestones (one at a time, each paused for your review)

1. Audit refresh with the five labels + QA/release checklist (docs only).
2. Design tokens, logo refinement, shared building blocks, new site-wide navigation and footer.
3. Home page aligned to the 12 sections (hero copy, product routing, Clarity Standard preview, reserve overview/methodology toggle, architecture diagram).
4. Graphics: hero (desktop + mobile crops), fractional building, Tessera token, icon family; reserve and loss diagrams built as live, accessible graphics (no numbers baked into images).
5. Clarity Standard page + matrix on every project page; marketplace empty state.
6. Separate Tessera, sTSRA/staking, transparency pages with persistent "Illustrative scenario" labels; no changes to staking or redemption rules.
7. Investor app sections with loading / empty / disconnected-wallet states.
8. For Issuers page, secure lead form (with document upload) and protected internal pipeline (Enquiry → Screening → Qualification → Legal/DD → Commercial Review → Approved/Declined).
9. Trust Centre, consent-aware analytics events, early-access signup with consent, blog structure and educational pages, sitemap/metadata.
10. QA pass (desktop/tablet/mobile, keyboard, contrast, page speed measured) and release review.

## What I need from you before certain milestones

- Milestone 9/10 "Meet the people": real team names, roles, company details, contact address. Without them the section stays out — nothing invented.
- Roadmap milestones you want shown publicly.
- Legal pages (privacy, risk disclosures) will be marked "for professional review"; I won't write them as final legal text.

## Protected throughout

No changes to contracts, wallet signing, Preprod lock, staking/redemption calculations, payment flows or access rules without separate approval. No fake figures, users, testimonials, audit seals or regulation claims.

## Technical details

- Tokens in `src/styles.css` (`--stellaris-*` mapped into existing semantic tokens; a `.protocol` scope for dark sections).
- Shared components under `src/components/brand/`; marketing nav/footer moved out of `index.tsx` into `src/components/layout/` and used by all public routes.
- New tables later (issuer leads, early-access signups) via migration with RLS: public insert only, admin read; uploads in a private storage bucket.
- A "safe branch": git state is managed by the platform, so work stays unpublished in preview; a draft copy can be used if you prefer full isolation.

Approving this plan starts Milestones 1 and 2 only.
