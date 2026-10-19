# Stellaris Finance — Phase 0 audit & feature preservation register

Snapshot: 2026-10-19. Network: Cardano Preprod only (`MAINNET_NOT_ALLOWED = true`).

## Stack
TanStack Start v1 + React 19, Vite 7, Tailwind v4, shadcn/ui, Lovable Cloud (Postgres, Auth, RLS),
Lucid Evolution + CIP-30 / WalletConnect, Blockfrost, Stripe, Aiken contracts (vault, fraction-vault,
multi-asset-vault, susdr-vault [frozen], tessera).

## Feature classification

| Feature | Route / module | Status |
| --- | --- | --- |
| Wallet connect + network guard | `wallet-store.ts`, `network.ts` | Verified functional |
| Blockfrost health / chain status | `/blockfrost-health`, `ChainStatusCard` | Verified functional |
| Project registry (assets table) | `/marketplace`, `/marketplace/$id` | Verified functional (3 rows are demo) |
| Yield vault deposit/withdraw/accrue | `yield-vault.ts`, `vault-accrual.ts` | Implemented, Preprod-verified; legacy v3 withdrawal finding open |
| Fraction offerings (buy/redeem/mint) | `/offerings`, `offering-tx.ts` | Implemented but unverified (no live offering signed yet) |
| Offering registration retry | `OpenOfferingCard`, `offering-registration.shared.ts` | Verified (tests) |
| Governance proposals, voting, set_fee execute | `/governance/*`, `vault-set-fee.ts` | Implemented, partially verified |
| Funding requests / issuers onboarding | `/funding/*`, `/issuers/$id` | Implemented, unverified end to end |
| Operator console / bootstrap | `/operators`, `DeploymentWizard` | Implemented; requires master wallet |
| Auth (email/password, roles) | `/auth`, `user_roles` | Verified functional |
| Security settings | `/security` | Implemented |
| Referral / invite | `/invite`, `referral.ts` | Implemented |
| Stripe upgrade | `/upgrade/*` | Implemented, test mode |
| Developer API + MCP | `/api/v1/*`, `/[.mcp]/*`, `/developers` | Implemented |
| TSRA / sTSRA staking | `/stake`, `staking.mock.ts` | Illustrative/demo |
| Transparency (reserve, NAV, loss order) | `/transparency`, `transparency.mock.ts` | Illustrative/demo |
| Yield dashboard (sUSDr) | `/yield` | Legacy, frozen contract |
| Property AU/SEA | `/property` | Planned |
| Independent audit | — | Planned (not completed) |
| Early access list, CMS insights, newsletter | — | Planned (not built) |
| Investor app sub-routes (`/app/*`), issuer portal (`/issuer/*`) | — | Planned (brief Phase 3) |

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
