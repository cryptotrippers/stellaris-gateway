# sUSDr / RealFi vault — status report

This is the honesty-bar report the offload brief's Phase 4 asks for: what's
compiled/tested vs. what's only been manually walked through, transaction
hashes where real ones exist, and an explicit simulated-vs-real list. Read
alongside `DESIGN.md` (architecture + decisions) and the git history on
`claude/susdr-realfi-vault-build-wl4ml9` (four commits, one per phase below).

## tl;dr

Phases 0–2 are real and verified — compiled, tested, executed against real
tooling (a real Aiken compiler, a real Postgres instance), not just written
and inspected. Phase 3 (UI) is **written but not walked through** — this
session has no funded Preprod wallet and no interactive browser with a CIP-30
extension, so the actual on-chain user journey (connect wallet → bootstrap →
deposit → accrue → see price move → withdraw) has **not been run once**. No
transaction hashes exist yet because no transaction has been submitted.
**Nothing in this build should be treated as "demoed" until that walkthrough
happens on Preprod with a real wallet.**

## Phase 0 — Aiken contracts: REAL, VERIFIED

- `aiken check`: **90 checks, 0 errors, 0 warnings** (`realfi/committee` 9,
  `stellaris/shares` 27 — the verbatim copy, still checks out standalone,
  `susdr_vault` 46, `usdr_mint` 8).
- `aiken build`: clean, `plutus.json` committed, hashes recorded in
  `DESIGN.md`.
- Toolchain note: `install.aiken-lang.org` is blocked by this sandbox's
  egress policy, so the `aiken` binary used here was compiled from source via
  `cargo install aiken --locked` (crates.io is allowed) — version
  `v1.1.23`, matching the compiler pin already used by `contracts/vault`.
- One real bug was caught and fixed during this phase, not glossed over: the
  first draft of the USDr test fixtures put the accounted USDr in the wrong
  UTxO (state vs. position), which `aiken check` correctly flagged as 3
  failing tests. Fixed and re-verified — see the Phase 0 commit.
- Known, disclosed gap: 5 of `yield_vault.ak`'s ~52 tests were not ported
  (fee/committee edge cases — see `DESIGN.md`, "Test coverage").
- The "one script, two purposes" design (sUSDr mint handler sharing the
  vault's spend handler hash) is not assumed — `plutus.json` was inspected
  after a real build and both handlers do share one hash:
  `255deaeead572430a9e159237690106e9f93d72ce78fb672e5b58c77`.

## Phase 1 — off-chain TS layer: REAL, PARTIALLY VERIFIED

- The Phase 1 gate ("derive the applied vault + USDr policy addresses and
  print them, without erroring, using the real pinned blueprint hashes")
  **passed for real**. Output, from a real run of
  `scripts/derive-susdr-vault-addresses.mjs`:

  ```
  [derive-susdr] OK: susdr_vault spend+mint share one hash (255deaeead572430a9e159237690106e9f93d72ce78fb672e5b58c77)
  [derive-susdr] OK: src/lib pins match plutus.json

  [usdr-mint] admins=3 threshold=2
    policyId: 141b26ce43bcea0bc54e193b292576a2fe71731a8b0ec11cce2dc5f4

  [susdr-vault] version=1 usdrPolicy=141b26ce43bcea0bc54e193b292576a2fe71731a8b0ec11cce2dc5f4
    scriptHash: 5586823ed72dc93d2644f8c747ad4254051661f5616f3398604b0eaa
    preprod:    addr_test1wp2cdq376ukuj0fxgnuvw3adgf2q29np74sk7vucvp9sa2s7qvcue
    susdrUnit:  5586823ed72dc93d2644f8c747ad4254051661f5616f3398604b0eaa7355534472
  ```

  The admin committee used (`admins=3 threshold=2`) is a **fixture**, not a
  real committee — no real admins have been designated yet.
- `scripts/verify-susdr-vault-hash.mjs` also ran clean against the real
  `plutus.json`.
- **Environment constraint, not a code problem**: this repo's committed
  `bun.lock` resolves packages against a private Lovable-hosted registry
  mirror (`*-npm.pkg.dev`) that this sandbox cannot reach (403). `bun install`
  therefore fails for the whole app here. Both scripts above were verified
  by installing a standalone `@lucid-evolution/lucid` from the public npm
  registry into a scratch `node_modules` instead — real GitHub Actions CI
  does not have this problem (`registry.npmjs.org`/the private mirror are
  both reachable there).
- Because of that, **no `tsc` or `eslint` pass has run** on any of the new
  TS files. They were checked with `bun build --target=browser <file>` per
  file, which parses full TS/JSX syntax and reports parse errors distinctly
  from module-resolution errors — every new file produced zero parse errors,
  only the expected "could not resolve" errors for packages that aren't
  installed. That is real signal (catches malformed syntax, mismatched
  braces, bad JSX) but it is **not** a type-check — a real `bun run build` or
  `bunx tsc --noEmit` on this branch, wherever full deps resolve, is still
  owed before this is trustworthy.

## Phase 2 — Supabase migrations: REAL, VERIFIED

- Not just written and eyeballed. A local Postgres 16 instance was started
  in this sandbox, stubbed with `auth.users`/`auth.uid()`/the
  `anon`/`authenticated`/`service_role` roles and Supabase's standard
  public-schema default grants, and the **entire existing migration
  history** (24 files) was replayed in order through the new migration with
  zero errors. (One pre-existing, unrelated migration needed a seeded admin
  row to satisfy its own bootstrap-retirement guard — not a susdr change,
  and not something a fresh real Supabase project would hit either, since a
  real admin bootstrap would have happened first.)
- RLS was exercised directly, not just read — switched Postgres role and
  the `auth.uid()` session GUC between statements and confirmed all 5
  cases behave as intended: an own-row watchlist insert succeeds, a
  cross-user watchlist insert is rejected, a non-admin `susdr_vaults` insert
  is rejected, an admin insert succeeds, and `anon` can read the vault
  registry.

## Phase 3 — UI: WRITTEN, NOT WALKED THROUGH

**This is the one that matters most to get right, honestly: nothing here has
touched a real UTxO.** No transaction hash exists for any susdr action
because no susdr transaction has ever been submitted, on Preprod or
anywhere else.

What exists:

- `SusdrVaultActionsCard.tsx` (deposit/withdraw), `SusdrOperatorConsole.tsx`
  (Accrue/SetFee/pause/unpause), `routes/susdr.tsx` (vault detail — share
  price, epoch, committee, fee, APY from real accrual-cache history, or an
  honest "not registered yet" empty state when there's nothing to show).
- `susdr-vaults.functions.ts`/`.shared.ts` wiring the UI to the Phase 2
  tables.
- Every new file parses cleanly (see Phase 1's verification note — same
  method applied here).

What does NOT exist yet, and is required before any of this can be called
"demoed":

1. `bun install` succeeding somewhere with access to this repo's real
   package registry (this sandbox cannot; try a normal dev machine or CI).
2. `bun run dev` actually serving the app, which also regenerates
   `src/routeTree.gen.ts` for the new `/susdr` route — that file has **not**
   been regenerated in this branch, so `/susdr` will not resolve until a
   dev/build run happens.
3. A real Preprod wallet (Lace/Eternl/etc.) funded from the faucet.
4. A real USDr test batch actually minted under `usdr_mint.ak` with a real
   (even if small, even if 1-of-1) admin committee — `susdr-params.ts`'s
   `USDR_POLICY_ID_PLACEHOLDER` is a fixture, not a real policy, and is
   called out as such in its own doc comment.
5. A real vault bootstrap (`bootstrapSusdrVault`), a real deposit, a real
   `Accrue` with actual USDr landing at the script address, a share-price
   change visibly reflected in the UI afterward, and a real withdrawal —
   each with its transaction hash recorded here, with an explorer link.

None of steps 1–5 can be performed autonomously from this sandboxed session.
They need either a differently-configured environment (real registry access,
a browser with a wallet extension) or a human in the loop with a funded
testnet wallet.

## Simulated / illustrative vs. real — the explicit list

| Claim | Status |
| --- | --- |
| Aiken validators compile and their own test suite passes | **Real** — `aiken check`/`build` output above |
| sUSDr mint policy id == vault script hash | **Real** — confirmed from a real `plutus.json`, twice (Phase 0 commit and the Phase 1 gate script) |
| Applied vault/USDr addresses shown above | **Real derivations**, but against a **fixture** admin committee (3 made-up key hashes) — not a real deployment |
| Supabase migration applies cleanly, RLS behaves correctly | **Real** — executed against live Postgres, not inspected |
| UI components/route render without crashing in a browser | **Not verified** — no dev server was run |
| Any deposit/withdraw/accrue/bootstrap transaction | **Does not exist** — no transaction hash anywhere in this report is real because none has been submitted |
| USDr's real decimals / real token metadata | **Unknown** — no real USDr token exists yet on any network; `shares.ak`'s reused constants assume 6 decimals, unverified (see `DESIGN.md`) |
| "sUSDr, a yield-bearing wrapper token... for the RealFi ecosystem" (marketing framing in the original brief) | **Not a live product** — this is Preprod-only, unlaunched, zero real users, zero real USDr in circulation |

## What a human needs to do next

1. Get a working `bun install` against this repo's real registry, run
   `bun run build` (regenerates `routeTree.gen.ts`, runs the prerender step,
   and will surface any real TS/lint errors this sandbox couldn't catch).
2. Stand up a real (even if tiny) USDr admin committee and mint a small real
   USDr test batch on Preprod via `usdr-mint.ts`.
3. Bootstrap a real sUSDr vault against that policy (`susdr-bootstrap.ts`),
   register it (`registerSusdrVault`), and run the full deposit → accrue →
   withdraw walkthrough with a funded Preprod wallet, recording every
   transaction hash here with an explorer link.
4. Only then should this feature be described anywhere as working, demoed,
   or ready for review.
