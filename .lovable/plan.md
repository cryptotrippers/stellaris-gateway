# Marketplace and asset page rebuild (brief sections 7 and 8)

Presentation-only. No changes to contracts, wallet, deposit/withdraw logic, database schema or financial figures. Existing URLs (`/marketplace`, `/marketplace/$id`) stay the same.

## 1. Marketplace (`/marketplace`)
- New header in the "Tangible future" style: warm photo band, short headline, a clear testnet notice.
- Filter bar: search (name, issuer, location), asset class, location, issuer, project status (open / funded / demo / pilot), and sort (newest, funding progress, target size, name).
- Filters live in the page address so a filtered view can be shared or bookmarked.
- Grid and list view toggle; remembers choice while browsing.
- Cards show: photo by category, name, issuer, location, status badge, funding progress (only when real), minimum entry, term (when set), and a one-line risk label ("Demo — not investable", "Preprod test asset", "Unaudited contract").
- Realised returns from chain stay as today; nothing is shown when no on-chain data exists.
- Empty and "no matches" states with a reset button.

## 2. Asset page (`/marketplace/$id`)
Reorganised into clear sections with an in-page contents list on desktop:
- Top: photo (with "illustrative image" caption), name, issuer identity, status, location, testnet/demo banner.
- Summary and underlying business (from the description).
- Ownership and legal structure: states plainly "Not yet documented" when no legal wrapper exists.
- Jurisdiction and management arrangements.
- Fees and costs: shows on-chain fee settings where they exist, otherwise "Not published".
- Financial information: target, raised, minimum, term — only real stored values.
- Risk factors: standard list (testnet, unaudited contract, liquidity, issuer, legal) plus demo-specific text.
- Liquidity and transfer rules.
- Contract and blockchain references: vault address/script links to the explorer where bootstrapped.
- Supporting documents and verification status: audit link if present, otherwise "No independent audit yet".
- Latest updates: on-chain transaction history (existing).
- Support and complaints: contact link.
- Existing deposit, withdraw and legacy vault panels are kept as-is, in a dedicated "Take part" section; still hidden for demo projects.

## Rules kept
- No invented numbers, documents, audits, licences or partners; missing information is labelled as missing.
- All new styling uses existing brand tokens; home-page classes untouched.

## Technical details
- `marketplace.tsx`: `validateSearch` with zod + `fallback` for q, category, location, issuer, status, sort, view; split into small components under `src/components/marketplace/` (FilterBar, AssetCard, AssetListRow).
- `marketplace.$id.tsx`: split into section components under `src/components/marketplace/detail/`; reuses existing queries and vault cards unchanged; fee data via existing read functions only.
- Category images reuse `src/assets/home-*.jpg`; head() meta per page kept unique.
- Verify in the browser at desktop and mobile: filters, view toggle, demo page hides invest actions, a real asset still shows deposit panels.
