# Page-by-page build-out guide

A single ordered track through every page in the app. Each step is self-contained: finish it, verify it, then move to the next. No step depends on a later one.

Confirmed from the codebase before writing this: `src/lib/mock-data` is still imported by `index.tsx`, `app.tsx` and `stewardship.tsx`, and `invite.tsx` carries a hardcoded leaderboard marked "swap for real data". Everything else already reads live chain or database state.

## Order and rationale

Public/marketing pages first (they are the entry point and the only pages a stranger sees), then the authenticated core, then operator/admin surfaces, then diagnostics.

### Step 1 — `/` Landing (`index.tsx`)
Remove the `ASSETS` mock import. Feature real rows from the `assets` table (server-loaded, cached) with an honest empty state when none are published. Keep the hero, tighten the single H1, confirm title/description/og tags.

### Step 2 — `/marketplace` list (`marketplace.tsx`)
Already live-queried. Polish only: search + category filter behaviour against real rows, skeleton loading state, empty state copy, per-card link to the detail route via `Link to`/`params`.

### Step 3 — `/marketplace/$id` detail (`marketplace.$id.tsx`)
Already live. Add the vault panel: derived vault address, current share price and TVL for that asset (from the yield chain reader), plus deposit entry point. Not-found handling for unknown ids with `noindex` metadata.

### Step 4 — `/app` Portfolio (`app.tsx`)
Remove `mock-data` entirely. Positions, ADA/USD totals and the sparkline series all come from `vault_positions` + `transactions` + on-chain holdings. Zero-state for a wallet with no positions rather than fabricated figures.

### Step 5 — `/yield` Yield engine (`yield.tsx`)
Already reading chain state. Add per-asset selection so the page can show any bootstrapped vault, not just the default, and surface accrual history with tx links to a Cardano explorer.

### Step 6 — `/governance` + `/governance/new`
List and detail already live. Finish the loop: proposal detail view, vote counts, and connecting an executed proposal to the vault action it authorises. Submission wizard gets validation and a post-submit confirmation state.

### Step 7 — `/security` (`security.tsx`)
Live sessions, audit log and the four toggles already persist. Add the wallet-linking step (register a wallet against the signed-in account) since transactions require it, and make each toggle's effect explicit in the UI.

### Step 8 — `/stewardship` (`stewardship.tsx`)
Currently the thinnest page and still on `sparkline` from mock-data. Decide its real source: impact metrics per asset from `assets`/`oracle_feeds`, steward referral counts from the referral store. Replace the hardcoded `STL-STEWARD-9F2A` code with the signed-in user's real code.

### Step 9 — `/invite` (`invite.tsx`)
Replace the mock leaderboard with real aggregated referral confirmations, or remove the leaderboard if the data can't be sourced honestly. Audit log and anti-abuse UI stay as-is.

### Step 10 — `/operators` (`operators.tsx`)
Admin surface, already gated by master wallet. Remaining: vault list view (every bootstrapped asset with its state UTxO), and accrual history per vault alongside the existing build/sign/submit card.

### Step 11 — `/developers` (`developers.tsx`)
API key management is in place. Add endpoint documentation that matches the actual `/api/public/*` routes, plus example requests.

### Step 12 — Diagnostics: `/testnet`, `/blockfrost-health`, `/upgrade/*`
Lowest priority. Confirm each still works after the above changes, mark the diagnostic pages `noindex`, and verify the upgrade return flow.

### Step 13 — Cleanup
Delete `src/lib/mock-data.ts` once no page imports it. Re-check every route's `head()` for unique title/description/og tags.

## Technical notes

- Data reads follow the existing pattern: server function or `queryOptions` + `ensureQueryData` in the loader, `useSuspenseQuery` in the component. No `useEffect` fetching.
- Any page reading authenticated data keeps its loader out of public routes; protected reads go through the component with `useServerFn`.
- Chain reads keep using the existing `plutus-cbor` / `yield-chain.functions.ts` path so the Blockfrost key stays server-side.
- No fabricated figures at any step — a missing number renders as an empty state.
