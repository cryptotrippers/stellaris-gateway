# Second-line UI/product review — Stellaris Gateway (read-only)

This is a review, not a build. It lists proposed UX fixes in priority order. Nothing has been edited. Out of scope: contracts, permissions, financial logic, source data and security audits. Brand names come from `src/config/brand.ts`, the Preprod-only guard stays in place, and CLAUDE.md conventions apply.

## Files inspected
`src/components/layout/MarketingNav.tsx`, `BottomNavBar.tsx`, `MoreMenu.tsx`, `account-links.ts`; `src/routes/marketplace.tsx`, `marketplace.$id.tsx`, `offerings.index.tsx`, `offerings.$id.tsx`, `stake.tsx`, `tessera.tsx`; `src/components/marketplace/FilterBar.tsx`; `src/components/passport/PassportSections.tsx`; `src/components/brand/TesseraLiveDashboard.tsx`, `DataSourceStamp.tsx`, `DisclosureBanner.tsx`; `src/components/RedemptionQueueStatus.tsx`; `src/config/brand.ts`.

## Already done (no action needed)
- Shared public nav and footer, a Preprod disclosure that can't be dismissed, and an accessible mobile menu toggle (`aria-expanded`, `aria-controls`).
- Marketplace filters are stored in the page address. Search and sort have labels, and the result count is announced to screen readers (`aria-live`).
- Passport sections say "Not published" when information is missing (total units, unit price, transfer restrictions), and demo listings label their figures as illustrative.
- The Tessera live dashboard: bigint `units6`, 60-second polling, Preprod/tUSD labels.
- Redemption queue dates are shown in UTC (`RedemptionQueueStatus.tsx` formatter).

## Remaining, by priority

### P1 — /marketplace vs /offerings overlap
- The two pages can read as competing catalogues: `/offerings` (on-chain fraction listings) and `/marketplace` (projects). `/offerings` is reached from the footer, the operator menu ("Approved Offerings" in `account-links.ts`) and the home page.
- Fix: present `/offerings/$id` as the "Buy fractions" step of a marketplace asset. Add a link from the Passport "Take part" section when a matching offering exists, and add a breadcrumb back to `/marketplace/$id`. Rename the operator link to "On-chain offerings (operator view)". Give `/offerings` an intro line explaining how it relates to the marketplace.
- The public mobile bar uses "Explore the Demo", but the app bottom bar uses "Invest" (`BottomNavBar.tsx`). On Preprod, "Invest" overstates what's possible. Rename it to "Explore assets".

### P1 — Live vs illustrative provenance
- `stake.tsx` shows target rates from `STAKE_TIERS`, a fixed "12.5% / 20% cap" and a mock balance. Only the top pill says "illustrative", and the "target, variable" tags sit next to large accent-coloured figures. Fix: put a `DataSourceStamp illustrative` on the tier cards and the review panel. Rename "Preview balance" to "Example balance (not your wallet)".
- `tessera.tsx` line 87 shows an "as of" date using the reader's own locale. Fix: show it in UTC, keep the "Illustrative" label, and add a stamp to each illustrative chart.
- Use `DataSourceStamp` the same way on every financial widget: the passport finance grid (`PassportSections.tsx` ~139), the transparency page and the yield page. Each should show a live source with its read time, or "Illustrative".

### P1 — TSRA/sTSRA staking and redemption timing
- `stake.tsx` `addDays()` gives dates in the reader's local time only. The redemption queue gives UTC only. The live dashboard (`localDate`, `toLocaleTimeString`) gives local only. The three disagree.
- Fix: one shared date helper that shows "local time (UTC time)". For example: "Mon 3 Nov, 14:30 your time · 03:30 UTC". Use it for cooldown end, lock end, the queue cut-off, the queue ETA and the dashboard's "last updated".
- Explain the 7-day credit and the cooldown loss-sharing with a small timeline (request → cooldown → claim) instead of a paragraph.
- "I understand — confirm" ends in a success-coloured "Preview only" box. Fix: use a neutral info style, and label the button "Simulate (no transaction)".
- Stake tier cards are buttons with no `aria-pressed`. Fix: make them a radio group.

### P2 — Asset Passport disclosures
- Order the sections by risk first on mobile: status and testnet banner → risk factors → ownership/legal → fees → financials. Keep the contents list sticky on desktop only.
- Each "Not published" row should say who supplies the information and link to the issuer's documents (from the document room) once they are approved.
- Next to each Clarity item, show its status (Pending / Unverified / Verified) as a word as well as a colour.

### P2 — Issuer and operator navigation
- `MoreMenu.tsx` lists "Operators — Admin tools" and "Developers" to every user. Fix: hide those links unless the user has a matching role (the operator role check already used by `account-links.ts`). The pages stay protected as they are today.
- Admin links "Review Queue" points to `/governance` and "Due Diligence" points to `/funding`. Both labels are misleading. Fix: rename them to "Governance proposals" and "Funding requests (review)", or point them to the correct stage filter on `/pipeline`.
- Issuer links jump to sections of `/issuer` (`#data-room`, `#journey`). Fix: make sure each section has a matching id and a visible heading, and add a small sub-menu inside the issuer dashboard.

### P2 — Mobile 360px and WCAG 2.2 AA
- At 360px, the fixed mobile CTA bar (`MarketingNav.tsx`) covers page content. Fix: add bottom padding (about 72px) to the layout. Also check that the focused element isn't hidden behind it (WCAG 2.4.11 Focus Not Obscured).
- Nav text is 13px on desktop, and many labels use `text-[10px]`/`text-[11px]` (`offerings.$id.tsx`, `stake.tsx`). Fix: raise them to at least 12px and check `muted-foreground` contrast reaches 4.5:1 on the surface colour.
- Long addresses in `offerings.$id.tsx` `Row` use a fixed `w-32` label column. Fix: stack the label above the value below 400px.
- Target size (WCAG 2.5.8): the view-toggle group in FilterBar and the "Max" button in stake are under 24px high. Fix: make them at least 24×24, ideally 44.
- Add a skip link in `__root`, and announce dashboard loading and errors to screen readers.
- Check each page in Playwright at 360×800 and 1280. Run axe on /, /marketplace, /marketplace/$id, /offerings/$id, /stake, /tessera and /issuer.

## Technical details
- New shared helper `src/lib/format-time.ts` (`formatLocalAndUtc`). It runs only in the browser after the page loads, to avoid hydration mismatches.
- No changes to queries, server functions, schema or contract code. Copy reads tickers and names from `BRAND`. Role-gated links reuse the existing role hook.
- Tests to add: unit tests for the date helper, a test for menu link visibility by role, and the existing filter/stage tests.
