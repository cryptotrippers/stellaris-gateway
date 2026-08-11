# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Stellaris Gateway (package name `tanstack_start_ts`) is a real-money-adjacent Cardano
dApp: a marketplace of tokenized real-world-asset vaults with deposit/withdraw,
yield accrual, and on-chain governance. It is **synced with [Lovable](https://lovable.dev)**
— commits pushed to the connected branch show up in the Lovable editor, and force-pushing
or rewriting published history breaks that sync (see the Lovable notice in `AGENTS.md`).

The repo is Preprod-only. See `NETWORK.md` for the current deployment status and the gated
path to mainnet. `src/lib/network.ts` refuses to resolve to mainnet config
(`MAINNET_NOT_ALLOWED = true`) — do not weaken that guard.

## Commands

Package manager is **bun** (`bunfig.toml`, CI uses `oven-sh/setup-bun`); both `bun.lock` and
`package-lock.json` are committed, but prefer `bun` for local installs.

```bash
bun install                              # install deps
bun run dev                              # vite dev server
bun run build                            # production build (runs prerender, see vite.config.ts)
bun run build:dev                        # development-mode build
bun run preview                          # preview a production build
bun run lint                             # eslint .
bun run format                           # prettier --write .
```

There is no JS/TS unit test suite (no vitest/jest config, no `test` script) — the only
automated tests in the repo are the Aiken validator tests under `contracts/vault/`.

### Smart contract commands (`contracts/vault/`)

```bash
cd contracts/vault
aiken check                              # run validator unit tests
aiken build                              # compile validators -> plutus.json
```

After changing the Aiken source, **always run `aiken build` and commit the regenerated
`plutus.json`** — CI (`.github/workflows/contracts.yml`) fails the build if the committed
`plutus.json` doesn't match a clean build, or if the pinned blueprint hashes drift.

```bash
node scripts/verify-vault-hash.mjs [--strict]   # blueprint drift guard (same check as CI)
node scripts/verify-live-scripts.mjs            # verify live/published script state
node scripts/verify-ref-scripts.mjs             # verify published reference-script UTxOs are unspent
node scripts/derive-vault-addresses.mjs         # derive per-asset script hash/address from the pinned blueprint
```

## Architecture

### Stack

TanStack Start (file-based routing + SSR) on Vite, React 19, Tailwind v4, shadcn/ui
("new-york" style, see `components.json`), Supabase (Postgres + Auth + RLS), Stripe,
and Cardano on-chain interaction via `@lucid-evolution/lucid` + CIP-30 wallets +
WalletConnect. The Vite config (`vite.config.ts`) is layered on
`@lovable.dev/vite-tanstack-config`, which already wires TanStack Start, React,
Tailwind, path aliases, and dev tooling — **do not re-add those plugins manually**,
only extend via the `vite`/`tanstackStart` keys passed to `defineConfig`.

### Routing (`src/routes/`)

File-based routing per `src/routes/README.md`:

| File | URL |
| --- | --- |
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `users/index.tsx` | `/users` |
| `users/$id.tsx` | `/users/:id` (dynamic — bare `$`) |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment) |
| `files/$.tsx` | `/files/*` (splat — read via `_splat`, never `*`) |
| `_layout.tsx` | layout route (`<Outlet />`) |
| `__root.tsx` | app shell wrapping every page |

`src/routeTree.gen.ts` is auto-generated — never hand-edit it. Don't introduce
`src/pages/`, `src/routes/_app/index.tsx`, or `app/layout.tsx` (Next.js/Remix
conventions that don't apply here). `[.mcp]` and `[.well-known]` are bracket-escaped
literal directory names (routes serving `/.mcp/...` and `/.well-known/...`).

### Server/client code-splitting convention (`src/lib/`)

`src/lib` uses a strict file-suffix convention to control what ships to the client
bundle vs. what stays server-only. This split is load-bearing (ESLint enforces the
`server-only` package ban in favor of it) — follow it when adding new modules:

- **`*.functions.ts`** — TanStack Start server functions (`createServerFn`). These
  files may contain **only** imports, types, and server-function declarations. Runtime
  helpers must live elsewhere, because handler bodies get split out of this file for
  the client bundle and any other top-level code is dropped with them.
- **`*.shared.ts`** — plain runtime helpers/types shared between a `.functions.ts`
  module and client code (e.g. `asset-vaults.shared.ts` backs
  `asset-vaults.functions.ts`).
- **`*.server.ts`** — server-only modules (e.g. `client.server.ts`, `stripe.server.ts`,
  `blockfrost-fetch.server.ts`). Top-level imports of these are only safe from other
  `.server.ts` modules; route files and `*.functions.ts` files ship to the client, so
  server-only modules must be dynamically `import()`-ed from there instead.
- Everything else in `src/lib` is plain shared code (browser + server), e.g.
  `network.ts`, `wallet-store.ts`, `vault.ts`.

### Supabase (`src/integrations/supabase/`)

`client.ts` (publishable key, RLS-scoped, client + SSR safe via `import.meta.env` /
`process.env` fallback) vs. `client.server.ts` (`supabaseAdmin`, service-role key,
bypasses RLS — server-only, never import from client code). `auth-middleware.ts`
(`requireSupabaseAuth`) validates a Bearer JWT and injects `{ supabase, userId, claims }`
into server-function context; `auth-attacher.ts` wires this into `startInstance` in
`src/start.ts`. These three files plus `types.ts` are marked "automatically generated" —
regenerate rather than hand-edit when the schema changes. Migrations live under
`supabase/migrations/` as timestamped SQL files.

### On-chain vault logic

The Aiken source lives in `contracts/vault/` (`validators/vault.ak`,
`validators/yield_vault.ak`, `validators/receipt.ak`); compiling produces
`contracts/vault/plutus.json`. The app never re-derives the validator from source —
it pins the **unapplied** blueprint (hash + CBOR) from `plutus.json` directly in
`src/lib/vault.ts` (`VAULT_BLUEPRINT_*`) and `src/lib/yield-vault.ts`
(`YIELD_BLUEPRINT_*`). The validator is parameterized by `(version, asset_id)`;
`@lucid-evolution/lucid`'s `applyParamsToScript` derives the applied script hash and
Preprod address **in the browser at runtime** — bumping `VAULT_VERSION` mints a new
vault instance without touching Aiken source. `scripts/verify-vault-hash.mjs` (run in
CI) fails the build if the pinned blueprints drift from a fresh `aiken build`. See
`contracts/vault/SPEC.md` for state transitions/invariants and `CHANGELOG.md` for the
staged history (Stage 1 per-user vault → Stage 2 per-asset shared vault → Stage 3
partial-withdrawal continuity).

Lucid Evolution is dynamically imported inside on-chain-facing functions
(e.g. `asset-vaults.shared.ts`, `vault.ts`) so it never ships into the SSR bundle —
follow this pattern for new wallet/tx code, and keep such calls scoped to run in the
browser after a CIP-30 wallet is connected on Preprod.

### MCP server (`src/lib/mcp/`)

`src/lib/mcp/index.ts` (`defineMcp`) registers the app's public MCP tools under
`src/lib/mcp/tools/` (asset browsing, yield estimates) plus authenticated tools
(`list_vault_activity`, `list_stewardship`) gated by an `apiKey` argument
(`src/lib/api-keys-store.ts`). Served via the `[.mcp]` route directory and
`src/routes/mcp.ts`; `.lovable/mcp/manifest.json` describes it to Lovable.

### Server entry / security headers (`src/server.ts`, `src/start.ts`)

`src/server.ts` wraps the TanStack Start server entry and applies, on every response:
baseline hardening headers (nosniff, frame-deny, HSTS, COOP, Permissions-Policy), a
report-only CSP (`Content-Security-Policy-Report-Only` — tighten allow-lists here
rather than switching to enforcing mode ad hoc), a same-origin CSRF guard for
non-safe HTTP methods (exempting `/api/public/*` webhooks and `/[.mcp]/*`, which
authenticate themselves), and normalization of h3-swallowed 500s into a rendered
error page. `src/start.ts` wires `attachSupabaseAuth` as function middleware and a
catch-all error middleware as request middleware via `createStart`.

### Payments and webhooks

Stripe checkout lives in `src/lib/payments.functions.ts` / `stripe.server.ts`.
Public webhook endpoints (`src/routes/api/public/payments/webhook.ts`,
`.../blockfrost/webhook.ts`) are CSRF-exempt by path and must verify their own
signatures inside the handler (see `src/lib/webhook-verify.ts`).

## Conventions

- TypeScript strict mode; `@/*` path alias resolves to `src/*`.
- Prettier: 100-char width, double quotes, trailing commas, semicolons — run via
  `bun run format`; ESLint delegates formatting complaints to Prettier
  (`eslint-plugin-prettier`).
- `bunfig.toml` enforces a 24h supply-chain guard on new package versions
  (`minimumReleaseAge`); only a short allow-list of `@lovable.dev/*` packages is
  exempted. Adding a new exemption needs explicit user confirmation.
- Never hand-edit `routeTree.gen.ts` or the "automatically generated" Supabase
  integration files (`client.ts`, `client.server.ts`, `auth-middleware.ts`, `types.ts`).
