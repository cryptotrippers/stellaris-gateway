# Stellaris Finance — Phase 0 audit & feature preservation register

Snapshot: 2026-10-19. Network: Cardano Preprod only (`MAINNET_NOT_ALLOWED = true`).

## Stack
TanStack Start v1 + React 19, Vite 7, Tailwind v4, shadcn/ui, Lovable Cloud (Postgres, Auth, RLS),
Lucid Evolution + CIP-30 / WalletConnect, Blockfrost, Stripe, Aiken contracts (vault, fraction-vault,
multi-asset-vault, susdr-vault [frozen], tessera).

## Feature classification

Labels: WORKING · UNVERIFIED · DEMO · PLANNED · BROKEN.

| Feature | Route / module | Status |
| --- | --- | --- |
| Wallet connect + network guard | `wallet-store.ts`, `network.ts` | WORKING |
| Blockfrost health / chain status | `/blockfrost-health`, `ChainStatusCard` | WORKING |
| Project registry (assets table) | `/marketplace`, `/marketplace/$id` | WORKING (3 rows are DEMO) |
| Yield vault deposit/withdraw/accrue | `yield-vault.ts`, `vault-accrual.ts` | WORKING on Preprod; legacy v3 withdrawals BROKEN (open finding) |
| Fraction offerings (buy/redeem/mint) | `/offerings`, `offering-tx.ts` | UNVERIFIED (no live offering signed yet) |
| Offering registration retry | `OpenOfferingCard`, `offering-registration.shared.ts` | WORKING (tests) |
| Governance proposals, voting, set_fee execute | `/governance/*`, `vault-set-fee.ts` | UNVERIFIED |
| Funding requests / issuers onboarding | `/funding/*`, `/issuers/$id` | UNVERIFIED |
| Operator console / bootstrap | `/operators`, `DeploymentWizard` | UNVERIFIED (requires master wallet) |
| Auth (email/password, roles) | `/auth`, `user_roles` | WORKING |
| Security settings | `/security` | UNVERIFIED |
| Referral / invite | `/invite`, `referral.ts` | UNVERIFIED |
| Stripe upgrade | `/upgrade/*` | UNVERIFIED (test mode) |
| Developer API + MCP | `/api/v1/*`, `/[.mcp]/*`, `/developers` | UNVERIFIED |
| TSRA / sTSRA staking | `/stake`, `staking.mock.ts` | DEMO |
| Transparency (reserve, NAV, loss order) | `/transparency`, `transparency.mock.ts` | DEMO |
| Yield dashboard (sUSDr) | `/yield` | DEMO (legacy, frozen contract) |
| Property AU/SEA | `/property` | PLANNED |
| Independent audit | — | PLANNED (not completed) |
| Early access list, CMS insights, newsletter | — | PLANNED |
| Investor app sub-routes (`/app/*`), issuer portal (`/issuer/*`) | — | PLANNED |

## Preservation register (test before and after each redesign step)
1. Connect a Preprod wallet; wrong-network wallet is blocked from signing.
2. `/marketplace` lists assets; demo assets show banner and no invest action.
3. Project page deposit → tx hash → recorded transaction.
4. Withdraw from a funded position.
5. Governance: create proposal, vote, execute set_fee.
6. Operators: bootstrap card loads for admin; `getMyRoles` only runs signed in.
7. Offering buy flow builds a transaction and shows the fee split before signing.
8. Sign up / sign in / sign out.
9. Blockfrost webhook verifies signature.
10. `/api/v1/yield` and MCP list-tools respond.

## Rules
No mainnet deploy, no contract logic changes without review, no fabricated data, no RLS changes
without review, keep existing deep links (add redirects before renaming routes).

## Design architecture (Stellaris 2.0)
- Clear Standard (light, editorial): home, About, Learn, Trust Centre.
- Tangible Future (photography): marketplace, project pages, For Issuers.
- The Protocol (dark, `.protocol` scope): Tessera, staking, transparency, governance, app.
- Brand values live once as `--stellaris-*` tokens in `src/styles.css`.
- Shared blocks: `components/brand/` (StatusPill, DataSourceStamp, DisclosureBanner, SectionHeader),
  `components/layout/` (MarketingNav, MarketingFooter).

## QA & release checklist (run per milestone)
1. Preservation register above passes.
2. Desktop 1280, tablet 820, mobile 390 render without overflow.
3. Keyboard: every nav link, menu and button reachable; visible focus.
4. Contrast AA on light and `.protocol` sections.
5. Every figure has a source + timestamp or an "Illustrative" label.
6. Testnet disclosure visible on every public page.
7. No fabricated people, partners, audits, regulation or returns.
8. Each route has its own title/description/og tags.
9. Page speed measured (not assumed) before release.
10. Nothing published without explicit approval.
