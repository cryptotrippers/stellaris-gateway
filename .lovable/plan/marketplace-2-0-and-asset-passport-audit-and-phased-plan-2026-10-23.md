# Marketplace 2.0 and Asset Passport: audit and phased plan

This is a design and presentation change only. Contracts, wallet code, transaction builders, Tessera/sTSRA logic, database tables, permissions and financial calculations stay as they are. Nothing gets published without your approval. Each phase ends with a desktop and mobile check, and I stop for your review before starting the next one.

## 1. What exists today (audit)

| Area | Page(s) | Status |
|---|---|---|
| Public nav and footer | Shared across home, marketplace, Tessera, transparency, property, governance | Working |
| Marketplace | /marketplace: search, category and status filters, grid/list view, demo badges | Working (real asset records plus 3 demo records) |
| Asset detail | /marketplace/$id: sections, deposit/withdraw panels hidden for demos | Working; on-chain parts unverified per asset |
| Fractional offerings | /offerings, /offerings/$id, buying fractions | Existing but unverified (needs a signing wallet) |
| Funding requests (issuer) | /funding, /funding/new (3 steps), /funding/$id with checklist | Working |
| Issuer profile | /issuers/$id with a verification badge | Working |
| Public pipeline | /pipeline with stage filters | Working; it reads data directly in the browser, which needs a review (see section 4) |
| Issuer enquiries | /for-issuers, /issuer-leads (admin only) | Working; the admin view still needs a signed-in test |
| Investor app | /app (holdings, vault positions) | Working; needs a connected wallet |
| Governance | /governance, proposals, fee execution | Working on Preprod |
| Tessera | /tessera live dashboard, /stake, /transparency | Live dashboard verified; staking uses illustrative data |
| Trust pages | /about, /security, /terms, /testnet | Partial: team and company details still pending |

**What an asset record holds today:** name, category, issuer, location, description, funding status, target, raised, minimum deposit, maturity, audit link, data source.
**Funding requests also hold:** evidence links, reporting cadence, proposed fee, treasury address, terms version.
**Not stored anywhere yet:** legal wrapper, unit count and price, soft and hard cap, deadline, escrow and release amounts, risk class, income source, distribution frequency, document versions, project timeline events, operating reports, distributions, KYB status per stage, data room.

## 2. Labels used throughout

Every financial feature gets one of five labels:
- Existing and verified
- Existing but unverified
- UI demonstration only
- Waiting for backend
- Waiting for legal/compliance approval

A page never shows an unfinished feature as live.

## 3. Phases

**Phase 2: Design system.** Extend the current navy, teal and gold colours with status colours for rejected, failed and reviewed. Add these shared pieces:
- a feature-status label for the five labels above
- an evidence row
- a metric card that says "Not published" when the value is empty
- a demo-mode frame
- a timeline
- a gate marker

Public nav becomes: Explore Assets, How It Works (new page), Transparency, For Issuers, Learn, About, plus an "Explore the Demo" button. Signed-in, issuer and admin menus only show links to pages that already exist; everything else is listed as pending. These menus are a convenience, not security: access stays enforced on the server.

**Phase 3: Marketplace.**
- New hero section with the brief's wording and the testnet notice.
- Five large photo cards for categories, labelled "Concept category". Commercial property and infrastructure need two new images.
- Live filters only for stored data: search, category, location, status, issuer, minimum entry, term. Risk, distribution frequency and maturity show as "coming soon" with no fake behaviour.
- Asset cards show stored fields only. Fields with no data show "Not published".
- When nothing is investable, an empty state links to the issuer enquiry form.

**Phase 4: Asset Passport** (/marketplace/$id, same address):
- Sections A–G as the brief describes.
- A seven-item Clarity Standard checklist. It is computed from real fields; for example, an audit link only counts as "Published", never "Verified".
- Financial tabs, a document list grouped by type, and a timeline of real on-chain transactions. Other events show as "Waiting for backend".
- Deposit and withdraw panels stay unchanged and stay hidden for demos.

**Phase 5: Issuer experience.**
- The 9-stage journey timeline with gates A–D, shown read-only.
- Stage status is only shown where the server already provides it (funding request status and checklist). Every other stage is marked "Waiting for backend".
- The funding form is regrouped into the brief's readable sections, using existing fields only.
- The data room is a static preview. There are no uploads until a secure backend service exists.
- A list of the data the backend would need to provide (the data contract).

**Phase 6: Financial visuals.**
- Reusable typed components: waterfall chart, cost breakdown, per-unit summary, actual vs forecast, distribution timeline, scenario cards and a sensitivity view.
- They display the Solar Farm Alpha example in a clearly framed "Illustrative Example" demo mode. The figures come from a fixed sample file and are not calculated in the page.
- Escrow capital-flow diagram and milestone release cards, all marked "Waiting for backend".

**Phase 7: Investor dashboard** (/app). Reorganise into Summary, My Assets, Transactions, Distributions, Documents, Updates and Risk notices:
- Holdings use the existing wallet and vault data.
- Distributions and documents show honest empty states.
- Forecast, Approved, Funded and Paid get distinct labels.
- Clear states for a disconnected wallet, an indexing failure and unavailable data.

**Phase 8: Trust Centre.**
- One hub page covering: company, regulatory status ("No licence held", as documented), issuer verification, approval method, audit status (internal review only), wallet safety, escrow explanation, reporting, and risks and complaints.
- Each item shows an evidence link and a date, or "Pending".

**Phase 9: Testing.**
- Responsive checks at 390, 891 and 1280px.
- Keyboard and screen-reader checks.
- A regression check of wallet, deposit, governance and Tessera pages.
- The final report covers the 16 items you asked for, including backend dependencies and launch blockers.

## 4. Flags for your backend team (not changed by me)

- The public pipeline page reads funding requests directly from the browser. Your brief asks for a server-approved public view instead. This needs backend work.
- Escrow states, distributions, documents, KYB stages and timeline events all need new backend data before they can go live.

## Technical details

- New components go in `src/components/marketplace/`, `src/components/passport/`, `src/components/finance/` (typed props only) and `src/components/issuers/journey/`.
- Illustrative data goes in `src/data/*.illustrative.ts`.
- Marketplace filters stay in the page address (zod `validateSearch`).
- Charts use the existing recharts-based `ui/chart`. There are no new packages.
- There are no edits to `src/lib`, `contracts/`, `supabase/` or generated files. Ticker names come from BRAND.
- New routes are `/how-it-works` and `/trust`, each with its own head() metadata.
