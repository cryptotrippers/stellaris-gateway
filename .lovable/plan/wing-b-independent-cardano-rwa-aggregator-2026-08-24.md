# Wing B — Independent Cardano RWA Aggregator

Reposition the app as the neutral **RWA entry point for Cardano capital**: any Cardano
stablecoin (or ADA) can be deposited into open, issuer-agnostic vaults. Stellaris becomes
one issuer among many; the accelerator work stays, one level down.

## 1. Open deposit-asset registry

A single source of truth for what can be deposited, so no issuer is hard-coded.

- New table `deposit_assets`: symbol, display name, `unit` (policy id + hex name, empty for
  ADA), decimals, network (`preprod` / `mainnet`), `status` (`live` | `planned` | `test`),
  issuer name, docs URL, CIP-113 registry metadata pointer.
- Seeded rows: **ADA** (live, Preprod), **USDr test policy** (test, Preprod — our own
  Preprod stand-in), **USDM** and **iUSD** (planned, mainnet policy ids recorded, inactive
  on Preprod).
- Public read (anon SELECT), admin-only writes, GRANTs in the same migration.
- Client helpers in `src/lib/deposit-assets.ts` for formatting amounts by decimals and for
  filtering to what is actually usable on the current network.

## 2. Multi-asset vault validator (Aiken)

New validator `contracts/vault/validators/multi_asset_vault.ak`, derived from the audited
`yield_vault.ak`, parameterised by `(version, asset_id, deposit_policy, deposit_name)`:

- Value accounting moves from lovelace-only to "quantity of the parameterised unit", with
  ADA expressed as the empty policy so one validator covers both cases.
- Every existing invariant is preserved: sole state UTxO, single Position input/output
  continuity, bound receipt policy, fee cap at 500 bps, pause semantics.
- Aiken unit tests mirrored for a token-denominated vault (bootstrap, deposit, partial
  withdraw, accrue, fee settle, hostile-token rejection).
- `aiken build`, then pin the unapplied blueprint hash/CBOR in `src/lib/multi-asset-vault.ts`
  the same way `yield-vault.ts` and `susdr-vault.ts` do, and extend
  `scripts/verify-vault-hash.mjs` + `src/lib/script-identity.ts` so CI catches drift.

Existing ADA vaults (`yield_vault` v3) keep running untouched; the new validator is opt-in
per asset via the `asset_vaults` registry row.

## 3. Adapter interface (CIP-0113 / CIP-0143 compatible)

`src/lib/rwa-adapter.ts` defines the plug-in contract an issuer implements to appear in the
aggregator, with no code change on our side beyond a registry row:

- `DepositAssetAdapter` — resolve unit, decimals, and CIP-113 registry metadata for a token.
- `ShareAdapter` — how fractional shares are represented (our receipt policy today; a
  CIP-143 style share token for external issuers later).
- Two reference implementations shipped: native ADA and CIP-113 fungible token.
- A written spec at `docs/rwa-adapter.md` plus a `/developers` tab section showing the
  interface, the pinned hashes, and how to register a new asset.

## 4. Aggregator UI and repositioning

- `/` rebuilt around the neutral pitch: "RWA entry point for Cardano capital" — supported
  deposit assets strip (live vs planned badges), open-interface promise, then the
  Stellaris-run projects as the first supply.
- Nav leads with **Invest / Assets / Developers**; Pipeline and Learn move under the
  accelerator grouping.
- New `/assets` route: the deposit-asset registry as a public page (status, issuer, policy
  id, which vaults accept it).
- Marketplace cards and the vault action card show the deposit denomination instead of
  assuming ₳, using the registry's decimals and symbol.
- Route-level `head()` metadata updated for the new positioning on `/`, `/assets`,
  `/developers`.

## 5. Honesty guardrails

No fabricated liquidity. Anything not deployable on Preprod today renders as
**planned**, with its policy id shown and deposit disabled. Preprod-only posture and the
mainnet guard in `src/lib/network.ts` are unchanged.

## Technical notes

- `contracts/vault/plutus.json` is regenerated and committed; CI's blueprint-drift job is
  extended to the new validator, matching the existing `susdr-vault` job.
- New pinned constants follow the existing pattern: unapplied blueprint in the repo,
  `applyParamsToScript` in the browser at runtime.
- Server-side reads of `deposit_assets` go through a publishable-key client in a
  `*.functions.ts` module; no service-role usage for public data.

## Suggested order

1. Migration + registry helpers (visible immediately as `/assets`).
2. Aiken multi-asset validator + tests + pinned hashes + CI.
3. Adapter interface and developer docs.
4. Homepage/nav repositioning and denomination-aware UI.
