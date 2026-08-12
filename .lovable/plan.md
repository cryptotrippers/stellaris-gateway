# Simplify the app for non-crypto users

A UI-only pass across the build: fewer top-level destinations, plainer language, and a single obvious next step on every screen. No contract, database, or transaction-logic changes.

## What's making it hard today

- The top bar exposes 8 destinations (Portfolio, Marketplace, Yield Engine, Governance, Stewardship, Security, Developers, Invite) plus Network badge, Upgrade, Notifications, Account and Wallet. A first-time visitor has 13 competing choices before understanding what the product is.
- Mobile bottom nav shows 5 abbreviated labels ("Govern", "Market") that don't map to the desktop labels.
- Crypto vocabulary appears in user-facing copy where a plain word works: "tADA" on the deposit amount field, "vault", "Preprod", "UTxO"/datum-flavoured status text, "Yield Engine", "Stewardship", "SIP".
- The landing page leans on all-caps micro-labels and dense stat grids rather than one clear "what is this / what do I do" path.
- Portfolio shows four simultaneous cards (chain status, on-chain positions, compliance checklist, quick actions) before showing any investments, so an empty account looks broken rather than new.

## Changes

### 1. Navigation: 4 primary items, the rest grouped
- Primary (desktop + mobile, matching labels): **Home / Invest / My Portfolio / Vote**.
- Move Yield, Stewardship, Security, Developers, Operators, Invite into a "More" menu on desktop and a "More" tab on mobile.
- Rename in the UI only: "Yield Engine" → "Earnings", "Stewardship" → "Impact", "Governance" → "Vote", "Marketplace" → "Invest". Routes and file names stay as they are.

### 2. Plain-language pass on user-facing copy
- Deposit/withdraw: "Amount (tADA)" → "Amount to invest" with a small "test ADA — no real money" helper line; primary button reads "Invest" / "Withdraw".
- "Vault" → "Project" in marketplace, portfolio and landing copy (keep "vault" in operator/developer screens where it's accurate).
- "SIP" → "Proposal" in Vote screens.
- Replace on-chain status strings surfaced to consumers ("no state UTxO", datum/script wording) with human states: Not open yet / Open / Confirming / Complete, with technical detail behind a "Details" disclosure.

### 3. One clear action per screen
- Landing: single hero headline + one primary CTA ("Browse projects"), one secondary ("How it works"). Collapse the stat strip to three numbers, drop the all-caps micro-labels to sentence case.
- Portfolio: when empty, show one card — "You haven't invested yet" with a Browse projects button. Chain status, compliance checklist and on-chain positions move below the fold / into a collapsible "Account & network" section.
- Project detail: order as What it is → What you'd earn → Invest box, with risk and audit details in an accordion.

### 4. Testnet framing that doesn't scare people off
- Keep one calm, persistent line ("Demo network — funds aren't real") in the header instead of repeated red technical badges on every screen. The loud red state stays reserved for an actual network mismatch.

### 5. First-run guidance
- A three-step "How it works" strip (Pick a project → Connect wallet → Track earnings) on Home and on the empty Portfolio, replacing the FAQ-first layout.

## Technical notes

- Scope is `src/components/layout/*`, `src/routes/index.tsx`, `app.tsx`, `marketplace*.tsx`, `governance*`, and the vault card components' copy/labels only.
- No route files renamed or removed; the "More" menu links to existing paths so all URLs keep working.
- No changes to `src/lib/vault*.ts`, contracts, migrations, or server functions.
- Existing design tokens and shadcn variants used throughout; no new colors introduced.
