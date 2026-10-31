# Home page refresh

# Account and wallet experience

- [x] Rebuild the existing account flow with safe return destinations, verification and authorized password recovery.
- [x] Consolidate wallet controls and bounded connection/reconnect handling without changing signing or ownership verification.
- [x] Verify public route wiring, mocked session transitions/recovery, failed links and 360px account/wallet layouts.
- [ ] Verify real email confirmation/recovery, Google completion and real extension/mobile wallet reconnect — requires an account session and user-operated email/provider/wallet checks; no private credentials or signatures requested.

# Tessera live Preprod dashboard

- [x] Add the read-only live snapshot, countdowns, contracts and clear test-data disclosures.
- [x] Label illustrative explainer figures separately.
- [x] Test amount/time calculations and verify live data, retry and mobile layout.

# For Issuers

- [x] Create dedicated B2B page and eligibility process; update issuer navigation.
- [x] Store issuer enquiries privately and add admin lead status/notes management.
- [x] Verify public enquiry submission, database delivery, anonymous access restrictions and mobile layout; remove the test enquiry.
- [ ] Verify administrator status/notes changes end to end — requires the owner to sign in with an administrator account.
- [ ] Enable owner email notifications — requires a paid plan, a verified sending domain and the owner's notification address.

- [x] Update the home page to reflect fractional assets, the reserve-backed token model, staking previews and planned property.
- [x] Improve the home page layout, navigation, imagery and demo visibility without publishing or changing financial logic.
- [x] Check the home page and navigation in the preview at desktop and mobile sizes.

# Vault setup confirmation

- [x] Confirm the registration timing failure across all three setup screens.
- [x] Retry pending registration without another wallet transaction, and retain seed details.
- [x] Run regression checks and resolve the monitoring finding.
- [ ] Verify a fresh signed Preprod bootstrap end to end — requires the operator's connected signing wallet.

# Marketplace 2.0 and Asset Passport

- [x] Phase 1: audit and phased plan (approved).
- [x] Phase 2: shared status/metric/demo/evidence/timeline pieces, new nav, How It Works page.
- [x] Signed-in, issuer and admin menus in the public navigation (role-aware, server-checked).
- [x] Phase 3: marketplace hero, category showcase, filters backed by stored data, richer cards, empty state.
- [x] Phase 4: Asset Passport sections A–G with Clarity Standard checklist.
- [x] Phase 5: issuer dashboard, nine-stage journey with gates, regrouped funding form, public pipeline restyle, data contract doc.
- [x] Fix pages stuck on loading for first-time visitors (cache guard cancelled in-flight requests).
- [x] Phase 6: asset-to-yield waterfall and escrow components with the illustrative Solar Farm Alpha demo.
- [x] Phase 8: Trust Centre page.
- [x] How It Works rebuild: three deep-linkable journeys, four gates, Tessera mechanism, conceptual cash waterfall (frontend only).
- [ ] Phase 7: investor dashboard sections with Forecast/Approved/Funded/Paid labels and a dark mode.
- [ ] Match the owner's reference image: dark navy/teal investor dashboard (side menu, KPI cards, area/bar charts from real data only) and a light, photo-led marketplace with overlay cards.
- [ ] Phase 9: tests, responsive/accessibility/regression checks, final delivery report.

# Project document room

- [x] Private document storage with server-checked access (issuer owner, administrators, signed-in investors for released files only).
- [x] Project-type document sections (renewables, real estate, private credit, infrastructure, other).
- [x] Issuer upload, new versions and removal on the funding request page; administrator release, reject (with reason), withdraw and return to review.
- [x] Released documents on the Asset Passport and funding page; sign-in to open via five-minute links; administrator review queue page.
- [x] Tests for section mapping, access rules and file checks; storage round-trip; signed-in owner, administrator and investor browser checks with a temporary account (removed).
- [ ] Email issuers when a document is rejected or released — requires email sending to be set up.
- [ ] Investor dashboard "Documents" tab listing released files for projects the investor holds — needs holdings linked to accounts.

# Security fixes (23 Oct review)

- [x] Migration: vault_positions read-only for users, draft funding requests hidden, issuer private columns hidden, admin-only attestation publishing, server-only audit/transaction writes, one record per transaction.
- [x] Wallet linking by signed message (account, wallet, nonce, preprod, expiry), Preprod key addresses only.
- [x] Voting weight live from unspent on-chain positions; finalisation recomputes every vote.
- [ ] Live test with a real Preprod wallet and vault position — needs the owner's wallet.
