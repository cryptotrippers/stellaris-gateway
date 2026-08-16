# sUSDr / RealFi vault — design

**Where this lives:** Option B — a namespaced module inside `stellaris-gateway`
(`contracts/susdr-vault/`, and later `src/lib/susdr-*.ts`, `src/routes/susdr/`),
not a new standalone repository. This is the more surprising of the two options
described in the offload brief, and it was NOT a free choice: this session's
git harness is bound to develop and push only on
`claude/susdr-realfi-vault-build-wl4ml9` in `cryptotrippers/stellaris-gateway`
("NEVER push to a different branch without explicit permission"), and its
GitHub tool access is scoped to that one repository. Standing up a second repo
was not achievable from inside those constraints, so Option B was taken as the
only actionable path. If sUSDr is meant to ship as its own branded product
with its own Supabase project and marketing surface, re-litigating this
decision — and actually provisioning a second repository — is the first thing
a follow-up session with broader access should do.

**Provenance note:** the Aiken sources here were NOT handed to this session
pre-written, despite the offload brief's framing ("these already exist").
No `susdr_vault.ak` / `usdr_mint.ak` / DESIGN.md existed anywhere in the repo
or the conversation when this work started. The user explicitly chose to have
this session write them from the specification, porting logic from
`contracts/vault/validators/yield_vault.ak` and copying
`contracts/vault/lib/stellaris/shares.ak` verbatim, rather than have the
session block on files that were never actually supplied. Every departure from
a literal lovelace-to-USDr find/replace is called out below.

## Two decisions already honored, unchanged

1. **`Accrue` requires real, on-chain USDr in the same transaction.** The
   `susdr_vault` validator's `Accrue` rule requires `value_delta == amount`,
   where `value_delta` is computed from the actual USDr quantity delta at the
   script address across this transaction's own inputs/outputs — not from a
   number typed into the redeemer alone. There is no "report yield now,
   repatriate capital later" path anywhere in this build; nothing in the TS
   layer, the DB schema, or the UI planned for later phases proposes one
   either. If off-chain-deployed capital is ever wanted, it needs its own spec
   section and its own risk review — not a code change slipped in here.
2. **sUSDr is a proof-of-claim receipt, not a bearer token.** `Withdraw` is
   authorized by `owner_signed` on the `Position` UTxO (`extra_signatories`
   containing `datum.owner`), never by holding or burning sUSDr. sUSDr itself
   is only ever minted/burned as a side effect of a `Position`'s depositor-share
   delta (see the `mint` handler below) — a transferee who acquires sUSDr on a
   secondary market gets a token that mirrors somebody else's claim, not a
   redemption right of their own. Every sUSDr balance shown in the UI (Phase 3)
   must carry stellaris-gateway's own "proof of claim — not transferable
   value" labeling (see its `RECEIPT.md`, "Transferability status"), with no
   transfer/trade affordance.

## What exists

| File | Role |
| --- | --- |
| `validators/susdr_vault.ak` | The vault: `Deposit` / `Withdraw` / `Accrue` / `SetPaused` / `RotateCommittee` / `SetFee` / `ClaimFee`, denominated in a native USDr token. Also defines the sUSDr **minting policy**, in the same validator block — see "One script, two purposes" below. |
| `validators/usdr_mint.ak` | USDr's own minting policy: M-of-N admin-committee-gated mint, unrestricted burn. |
| `lib/stellaris/shares.ak` | **Copied verbatim, byte-for-byte identical** to `contracts/vault/lib/stellaris/shares.ak` (verified with `diff`, checked into this commit). Pure share-accrual/fee arithmetic; already asset-agnostic, so nothing needed to change. |
| `lib/realfi/committee.ak` | New. M-of-N signature-threshold checking, factored out so `susdr_vault.ak` and `usdr_mint.ak` don't each hand-roll their own copy — see "Why a new shared helper" below. |

Test coverage: `aiken check` → **90 checks, 0 errors, 0 warnings**
(`realfi/committee` 9, `stellaris/shares` 27 — unchanged from upstream,
confirming the verbatim copy still checks out standalone — `susdr_vault` 46,
`usdr_mint` 8). `aiken build` → clean, `plutus.json` generated.

## Blueprint hashes (unapplied, from `plutus.json`, compiler `v1.1.23`, Plutus v3)

- `susdr_vault` — **`255deaeead572430a9e159237690106e9f93d72ce78fb672e5b58c77`**
  (shared by all three handlers in the block: `spend`, `mint`, `else` — see below).
  Parameters: `(_version: Int, usdr_policy: ByteArray, usdr_asset_name: ByteArray)`.
- `usdr_mint` — **`3a66ba3d1a6c18b613b2c62f5349e13eb010716d3a38ecb8dee1973b`**.
  Parameters: `(admins: List<ByteArray>, threshold: Int)`.

These are the values a future `scripts/verify-vault-hash.mjs`-equivalent for
this project should pin and check in CI, exactly as `contracts/vault` does for
`VAULT_BLUEPRINT_HASH` / `YIELD_BLUEPRINT_HASH`.

## One script, two purposes: why `susdr_vault.ak` needs no separate receipt policy

stellaris-gateway's own yield vault needed a *second* file
(`validators/receipt.ak`) and a *two-step deploy order* to bind a receipt
token to the vault: derive the applied vault hash, derive a policy
parameterized by that hash, then bootstrap the vault with the policy id
written into its own datum (an 11th `State` field, `receipt_policy`) — see its
`RECEIPT.md`. That design is *inherited* from an earlier stage of that
contract's history (the receipt policy was bolted on after the vault already
existed) and it works, but it is not the simplest thing to build fresh.

Aiken (since the "handlers" feature landed, current here at v1.1.23) lets one
`validator name(params) { spend(...) { .. } mint(...) { .. } else(_) { fail } }`
block define **multiple purposes that compile to a single script and a single
hash**, dispatching internally on which purpose the ledger invoked it for.
`susdr_vault.ak` uses this directly: the `mint` handler in the same block as
`spend` mints/burns sUSDr, and because they share one hash, the sUSDr policy
id **is** the vault's own spending script hash — structurally, not by
convention. Consequences:

- No `receipt_policy` field in the `State` datum at all (`susdr_vault`'s
  `State` has exactly the 10 fields `yield_vault.ak`'s had *before* its Stage
  6 receipt work — see its own history).
- No two-step "derive vault, then derive policy from applied vault hash, then
  write policy id into the bootstrap datum" ordering, and nothing to check
  in the `spend` handler that guards against the policy id being swapped out
  from under the vault (`yield_vault.ak`'s
  `n_receipt_policy == receipt_policy` / `receipt_policy_cannot_be_swapped`
  test) — there is no mutable field to swap, so that entire bug class doesn't
  exist here.
- The `mint` handler reads `policy_id` (the argument the ledger always passes
  to a `mint` purpose) and treats it directly as "this vault's own script
  hash" to find the `State`/`Position` UTxOs at that address — no extra
  parameter needed, unlike `receipt.ak`'s `vault_hash: ByteArray` parameter.

**This is not assumed — it is checked.** `plutus.json` after `aiken build`
shows `susdr_vault.susdr_vault.spend`, `susdr_vault.susdr_vault.mint`, and
`susdr_vault.susdr_vault.else` all carrying the identical hash
`255deaeead572430a9e159237690106e9f93d72ce78fb672e5b58c77`. Anyone touching
this file should re-run `aiken build` and diff `plutus.json`'s validator
hashes before trusting this property still holds — it depends on Aiken's
compiler behavior for multi-purpose validator blocks, not on anything this
codebase enforces independently.

The mint rule itself is a direct, one-purpose-removed port of `receipt.ak`'s
logic: exactly one token name may move under the policy, and its quantity
must equal the depositor-share delta (`total_shares - treasury_shares`)
between the sole `State` input and the sole `State` output — so `Deposit`
mints, `Withdraw` burns, and `Accrue` / `SetFee` / `ClaimFee` /
`SetPaused` / `RotateCommittee` all move depositor shares by zero and the
policy refuses to run at all for those redeemers.

## Why a new shared helper (`lib/realfi/committee.ak`)

`yield_vault.ak`'s `threshold_met` and `operators_valid` are private functions
defined *inside* that validator file. Aiken cannot import a private helper
defined inside one validator module from another validator module — so
`usdr_mint.ak`, which needs the exact same M-of-N logic to gate its own admin
committee, could not reuse them as written. The options were: hand-duplicate
the check in both files, or factor it into a library module both can import.
Given CLAUDE.md's own stated concern about exactly this bug class (duplicated
money-relevant logic drifting apart — its example is `AUDIT.md` finding O-02,
about a datum constructor hand-rolled in more than one place), duplication was
rejected. `lib/realfi/committee.ak` holds `threshold_met` and the renamed
`committee_valid` (was `operators_valid` in `yield_vault.ak`; renamed because
it's now shared by an "admins" list too, not only vault "operators"), each
independently tested (9 tests) rather than only exercised indirectly through
the two validators that use them.

This is new code, not part of the "copied verbatim" set — flagged here per
the spec-first rule.

## `usdr_mint.ak` — a genuinely new contract, not a port

Unlike `susdr_vault.ak`, there is no `yield_vault.ak` equivalent for a
stablecoin's own minting policy in `stellaris-gateway` to port from. Design:

- **Parameters, not a datum.** `usdr_mint(admins: List<ByteArray>, threshold: Int)`
  bakes the admin committee into the compiled script at deploy time, rather
  than reading it from a mutable state UTxO the way `susdr_vault`'s operator
  committee is stored and rotated. A minting policy has no state UTxO of its
  own to carry a mutable committee in — there is nothing analogous to
  `susdr_vault`'s `State` datum for a bare minting policy to read. Rotating
  USDr's admin committee therefore means deploying a **new policy** (a new
  `admins`/`threshold` pins a new policy id), the same "redeploy for a new
  instance" posture `_version` already gives `susdr_vault` at the parameter
  level. This is a real, disclosed limitation: existing USDr tokens under the
  old policy id don't migrate automatically to a new one. A future revision
  that wants live-rotatable USDr admins without a redeploy would need a
  registry UTxO (e.g. an NFT-pinned admin-list datum read as a reference
  input) — deliberately not built here since it's unrequested scope and its
  own trust-model question (who can update the registry, and how is *that*
  authorized?).
- **Mint: M-of-N gated, no reserve check.** The policy cannot and does not
  attempt to verify that real off-chain USD backs a mint — no UTxO chain can
  read a bank balance. The trust model is exactly what a fiat-backed,
  custodially-issued stablecoin's mint has to be: M of N named admins attest,
  by signing, that USDr is being created against real backing. Auditing that
  attestation is an off-chain governance/reporting problem. This build is
  Preprod-only (`MAINNET_NOT_ALLOWED = true` in `src/lib/network.ts`, per
  CLAUDE.md / `NETWORK.md`), so no such claim is made about any real money
  here — no mainnet USDr will exist as a consequence of this work.
- **Burn: unrestricted, by design.** Destroying value needs no committee
  signature — whoever is spending the USDr-bearing input as part of the burn
  transaction already satisfied *that* UTxO's own spending conditions
  (typically their own wallet signature, or `susdr_vault`'s own `Withdraw`
  rule when USDr is leaving the vault). Requiring committee sign-off to burn
  would let admins hold depositors' own USDr hostage.
- **One token name, always.** `usdr_asset_name` is a fixed module constant
  ("USDr" in UTF-8), not a parameter — there is exactly one USDr, shared by
  every vault, unlike `susdr_vault`'s per-deployment `usdr_asset_name`
  parameter (which exists so the vault can be pointed at a real USDr policy
  once one is chosen; the vault itself doesn't mint USDr).

## Cardano-specific subtleties

**Min-UTxO-ADA is a ledger rule, not something the validator checks.** Every
UTxO on Cardano — script-owned or not — must carry a minimum amount of
lovelace, computed by the ledger from the UTxO's size (datum + value). This is
enforced by the ledger *before* any Plutus script runs; a transaction that
tries to create an under-funded UTxO is rejected at the ledger layer, and
`susdr_vault` never sees it. Because of this, `susdr_vault.ak` — unlike
`yield_vault.ak`, where lovelace was simultaneously the accounted currency
*and* the min-ADA currency, so one dust-floor check did double duty — makes
**no attempt** to check that any output carries "enough" lovelace. Doing so
would be redundant with a rule the ledger already enforces unconditionally,
and getting the ledger's own min-UTxO formula wrong inside a validator would
be a real way to introduce a bug for no safety benefit.

**Why `only_usdr_and_lovelace` exists.** What the validator *does* still need
to check is that a `State`/`Position` output doesn't carry a *third* native
asset beyond lovelace (required by the ledger rule above, and otherwise
untouched) and the accounted USDr token. `yield_vault.ak`'s equivalent,
`values_pure`, could require outputs be pure lovelace, full stop, because
lovelace was the only currency ever meant to sit there. `susdr_vault.ak`
legitimately needs *two* assets in every living output (lovelace for min-ADA,
USDr for the accounted claim), so the purity check has to allow exactly that
pair and reject anything else — an attacker-planted NFT or foreign token would
otherwise inflate the output's real min-ADA requirement or simply pollute
accounting, exactly the risk `values_pure` was written to close for
lovelace-only vaults.

**The decimal assumption baked into the reused `shares.ak` constants.**
`shares.ak` was copied verbatim, so its two dust-floor constants —
`min_initial_deposit = 10_000_000` and `min_position_value = 2_000_000` — are
now being reinterpreted as USDr base units instead of lovelace, without
adjustment. Because lovelace has 6 decimals (1 ADA = 1,000,000 lovelace), this
implicitly assumes **USDr also uses 6 decimals**, so those constants read as
"10 USDr minimum first deposit" and "2 USDr minimum dust floor for a
surviving position." This has NOT been verified against a real USDr token's
actual on-chain decimals (there is no real, deployed USDr this build points
at yet — see the "No fabricated data" ground rule; nothing about the token's
real parameters is invented here beyond what's needed to compile and test).
**Before pointing this vault at a real USDr policy — even on Preprod — confirm
its decimals convention and adjust these two constants (in a project-local
fork of `shares.ak`, which would then no longer be "verbatim," disclosed as
such) if it differs from 6.**

## Test coverage — what's carried over, what isn't

`susdr_vault.ak`'s 46 tests mirror `yield_vault.ak`'s structure test-for-test
for deposit, withdraw (including partial-withdraw continuity and the
V-01/V-03 batched-withdrawal security-scan regressions), pause, committee
rotation, value purity, the management-fee lifecycle (`Accrue` settling fee
before yield, `SetFee`, `ClaimFee`), and the sUSDr mint/burn rules (folded
into this file's own `mint` handler tests rather than a separate
`receipt.ak`-style suite). `usdr_mint.ak` and `realfi/committee.ak` are new
and have their own, from-scratch coverage (8 and 9 tests respectively).

**Known gap — not yet ported from `yield_vault.ak`'s ~52 tests:**

- `accrue_rejects_future_anchor` — V-05, an unbounded/open-ended validity
  upper bound on an `Accrue` tx.
- `fee_claim_cannot_exceed_the_accrued_fee_shares`
- `depositors_cannot_withdraw_against_treasury_shares`
- `fee_rate_needs_the_operator_threshold`
- `fee_rate_cannot_be_changed_during_a_deposit`

These are exactly the kind of double-satisfaction / fee-edge / committee-edge
cases the offload brief anticipated needing porting "the same mechanical way."
The underlying validator logic for all five is an unmodified port of
`yield_vault.ak`'s (same `fee_anchor_ok`, same `n_treasury_shares <= n_shares`
structural bound, same `fee_frozen`/`threshold_met` gates on `SetFee`), so
these are very likely already enforced — they are just not yet *proven* by a
USDr-denominated test the way the rest of the suite is. Porting them is
mechanical (swap the lovelace fixtures for USDr quantities per the
"position holds its own claim, state holds 0 unless money passes through it
directly" convention established above) and should happen before this
contract is treated as launch-ready.

## Next steps

Phase 1 (off-chain TS integration layer) is next: `src/lib/susdr-vault.ts` /
`susdr-mint.ts` / `susdr-bootstrap.ts` / `susdr-position.ts` /
`susdr-accrual.ts` / `susdr-chain-decode.ts`, mirroring
`contracts/vault`'s equivalents and this repo's `.functions.ts` /
`.shared.ts` / `.server.ts` code-splitting convention, pinning the two
blueprint hashes above and deriving the applied vault address + USDr policy
via `applyParamsToScript` in the browser at runtime, never re-derived from
Aiken source in the app.
