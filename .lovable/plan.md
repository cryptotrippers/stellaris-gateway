
# Goal

Turn Stellaris Finance's homepage into a shareable, retail-friendly public landing page so that links posted on TikTok/Instagram/X/Reddit convert curious visitors into wallet-connect signups. The current `/` route drops visitors straight into a portfolio dashboard with mock numbers — great for logged-in users, terrible as a share target.

## Approach

Split the home route: keep the current dashboard behind `/app`, and build a brand-new public landing page at `/` with hooks, big numbers, social proof, and share affordances aimed at general retail users.

## Scope

### 1. Route split
- Move the current dashboard component from `src/routes/index.tsx` to `src/routes/app.tsx` (URL: `/app`), keeping all existing logic and mock data.
- Update in-app links that currently point to `/` for the "portfolio" tab (BottomNavBar, TopAppBar, quick actions) to point at `/app`.
- Rewrite `src/routes/index.tsx` as the new marketing landing page.

### 2. Landing page (retail hook stack)
Structure top to bottom:
- Hero: bold headline ("Own a piece of the real world. From ₳10."), animated value counter, one primary CTA "Explore assets" → `/marketplace`, secondary CTA "See a live portfolio" → `/app`.
- Social proof strip: "$2.4M+ tokenized", "1,200+ investors", "7.9% blended APY", "ZK-verified compliance" — pulled from mock-data aggregates.
- "How it works" 3-step: Pick asset → Invest with wallet or card → Earn yield. Big icons, no jargon.
- Featured assets carousel/grid — reuses existing asset cards from mock data (solar, farms, real estate). Each card links to `/marketplace/$id`.
- Impact strip: ESG/stewardship numbers linking to `/stewardship`.
- FAQ (accordion, ~6 Q's) covering: Is this safe? Do I need crypto? Minimum? Fees? Who can invest? What's Cardano?
- Final CTA band with wallet-connect + "Browse marketplace" buttons.
- Footer with links to /marketplace, /yield, /governance, /security, /developers.

Tone: retail-consumer, plain English, big numbers, generous whitespace, keep the existing dark institutional palette so it doesn't clash with the rest of the app. No new fonts, no new color tokens — use existing `card-institutional`, gradients, and semantic tokens.

### 3. SEO + social share optimization
- Per-route `head()` on the new landing: distinctive `<title>` (<60 chars), meta description (<160 chars), `og:title`, `og:description`, `og:type: "website"`, `og:url`, `twitter:card: "summary_large_image"`, canonical link on this leaf.
- Generate a 1200×630 `og:image` (branded hero card, "Own real-world assets on Cardano") via imagegen, upload via `lovable-assets`, wire absolute URL into `og:image` and `twitter:image`.
- Add JSON-LD: `Organization` on `__root.tsx` (name, url, logo) and `WebSite` with `SearchAction` on `/`, plus a `FAQPage` schema on `/` using the FAQ copy.
- Update `src/routes/sitemap[.]xml.ts` to keep `/` at priority 1.0 and add `/app` at 0.7.
- Update `head()` on `marketplace.tsx`, `yield.tsx`, `governance.tsx`, `security.tsx`, `stewardship.tsx` so each has a unique title/description/og pair (many currently share defaults). This is what makes individual page shares look good, not just the homepage.

### 4. Share affordances (viral loop)
- Add a small `<ShareRow />` component (native `navigator.share` with copy-link fallback + X/Reddit intent URLs) placed:
  - Bottom of landing page ("Share Stellaris")
  - On each `/marketplace/$id` asset detail page ("Share this asset")
- Pre-composed share text per asset: "I'm eyeing {asset.name} — {apy}% APY, ESG {rating}, on Cardano. {url}"

### 5. Analytics hook (lightweight)
- Add a tiny `trackEvent(name, props)` util that no-ops when no analytics is wired, and instrument: `landing_hero_cta_click`, `landing_share_click`, `asset_share_click`, `wallet_connect_click`. This gives the user a single place to plug in Plausible/PostHog later without another refactor. No provider is added now.

## Explicitly out of scope

- No referral/invite system (that was the other option).
- No backend/Lovable Cloud changes.
- No new fonts, palette overhaul, or design-system rewrite.
- No changes to auth, wallet, Stripe, or Blockfrost logic.
- No A/B test harness.

## Technical notes

```text
src/routes/
  index.tsx          ← NEW public landing (marketing)
  app.tsx            ← moved from old index.tsx (dashboard)
  __root.tsx         ← add Organization + WebSite JSON-LD
  sitemap[.]xml.ts   ← add /app entry
src/components/
  landing/Hero.tsx
  landing/HowItWorks.tsx
  landing/FeaturedAssets.tsx
  landing/ImpactStrip.tsx
  landing/FAQ.tsx
  landing/ShareRow.tsx
src/lib/
  analytics.ts       ← trackEvent no-op stub
src/assets/
  og-landing.jpg.asset.json  ← generated 1200×630 share card
```

Nav updates: `BottomNavBar` "Portfolio" item's `to` becomes `/app` (exact:true), and any `<Link to="/">` inside the dashboard that meant "portfolio home" retargets to `/app`. The marketing `/` is not added to the bottom nav (it's a public entry point, not an in-app tab).
