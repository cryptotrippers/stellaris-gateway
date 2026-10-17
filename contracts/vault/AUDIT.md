# Stellaris vault contracts — security scan

Date: 2026-08-09
Scope: `validators/vault.ak`, `validators/yield_vault.ak`, `validators/receipt.ak`,
`lib/stellaris/shares.ak`, and the off-chain transaction builders in
`src/lib/yield-position.ts`, `src/lib/vault-accrual.ts`, `src/lib/vault-bootstrap.ts`,
`src/lib/yield-vault.ts`, `src/lib/yield-chain-decode.ts`.

Method: manual review against the invariants in `SPEC.md` §7 and `YIELD.md` §5.
Each finding names the missing rule, the transaction that exploits it, and the
fix. **Close-out (2026-08-10):** V-01, V-03, V-05 and O-03 are fixed, V-02 is
mitigated on-chain, V-04 is decided as (a). **Close-out (2026-08-11):** O-01
and O-02 are fixed — the last two open off-chain findings. Per-finding status
is recorded in its own section.

**Phase 1 re-verification (2026-10-17).** Every "FIXED" claim below was
re-checked against the code with mutation tests (remove the fix, see whether a
test fails). Two contract-level defects this scan missed were found and fixed,
one fix had regressed, and one regression test did not test anything. See
**Phase 1 findings** at the end of this document; corrections are also noted
inline under V-01, V-02 and O-03.

Status legend: **FIXED** (shipped, with a regression test), **MITIGATED-ON-CHAIN**
(cannot be prevented, but cannot be exploited), **DECIDED-(x)** (design call
recorded), **OPEN** (accepted, not yet fixed), **INFO** (recorded, no action).

Migration note that applies to every code fix below: touching a validator moves
its blueprint hash, which moves every applied vault address. All accepted fixes
must ship in a single rebuild, and every live Preprod position must be withdrawn
from the current addresses first.

---

## V-01 — No "exactly one State input" rule — HIGH — **FIXED**

> **Fixed** in the security-scan close-out: the `State` branch now applies
> `sole_state(ins)` to the script inputs, mirroring the output rule, so two
> State UTxOs can never be spent together. Regression test:
> `two_state_inputs_are_rejected` in `validators/yield_vault.ak`. Blueprint hash
> moved to `e79ee0c4c5d5e0e29d095d616046cbcb9554ab6ba64b428236e11875`.
>
> **Phase 1 correction:** the guard was in place, but `two_state_inputs_are_rejected`
> still passed with the guard deleted: its `Deposit` with a negative value delta
> fails for unrelated reasons. Replaced by a control/attack pair,
> `v01_single_state_deposit_is_accepted` and
> `v01_two_state_inputs_merged_into_one_are_rejected`, verified to fail when the
> guard is removed. With F-1 fixed, the state-thread token makes a second genuine
> State impossible, so this guard is now defence in depth; the test fabricates a
> second token to keep it isolated.

**Where:** `yield_vault.ak`, `State` branch, around the `expect Some(next) =
sole_state(outs)` line.

**Missing rule.** The output side is constrained: `sole_state(outs)` returns
`None` unless exactly one output carries a `State` datum, and the `expect` then
fails the script. The input side has no equivalent. `script_inputs` is summed
into `locked_in` without ever asking how many of those inputs are `State`.

**What it enables.** If two `State` UTxOs ever coexist at one applied address,
they can be spent in a single transaction and collapsed into one output. The
validator runs once per State input, but both runs read `sole_state(outs)` — the
same single output — and both compare it against their own datum. `locked_in`
becomes the sum of both States' lovelace, so `value_delta` is measured against a
pool the surviving datum does not account for. The surviving `n_assets` only has
to satisfy one branch's arithmetic; the other State's lovelace is free to leave
the script in the same transaction. That is a direct drain of accounted assets.

The `Position` branch has the same shape of hole in the opposite direction: it
only asks `sole_state(ins)` to be `Some(_)`, which is satisfied by exactly one
State input, so it is already correct.

**Fix.** In the `State` branch, compute the State inputs explicitly and require
exactly one, mirroring `sole_state(outs)`:

```
expect Some(_) = sole_state(ins)
```

placed alongside the existing `expect Some(next) = sole_state(outs)`. This is a
one-line change and costs nothing in execution units beyond the filter already
performed for `position_shares`.

**Test to add.** `two_state_inputs_collapse_is_rejected`: two State inputs
(10 ADA + 10 ADA accounted), one State output accounting for 10 ADA, 10 ADA
leaving to an attacker address, redeemer `Deposit` with `deposit == 0`. Must
fail. Today it does not.

---

## V-02 — Anyone can create a State-shaped output at the vault address — HIGH — **MITIGATED-ON-CHAIN**

> **Phase 1 correction: the mitigation below was wrong; now FIXED by F-1.**
> V-01 only forbids spending two States *together*. A planted State spent
> *alone* passed every rule, so it was not "permanently unspendable"; it was a
> fully working fake vault (see F-1). It is now inert because it lacks the
> state-thread token.
>
> **Mitigated.** A planted State can still be *created* (nothing can stop a
> third party paying an inline datum to an address), but with V-01 fixed it is
> permanently unspendable: any transaction spending it alongside the genuine
> State traps. The remaining risk was off-chain display, fixed via O-03 — the
> decoder now refuses an ambiguous address instead of trusting the first State
> it finds.

**Where:** structural, not a single line. The vault address accepts any payment.

**Missing rule.** A validator only runs when a UTxO at its address is *spent*.
Nothing prevents a third party from paying an output with an inline `State`
datum of their own construction to the applied vault address. Once V-01 is
fixed, such a UTxO is inert — no transition can spend two States, so the
attacker's State can never be merged with the real one, and the attacker has
simply donated the min-ADA they attached. Until V-01 is fixed, this is the setup
step that makes V-01 exploitable by an outsider rather than only by a botched
bootstrap.

**What it enables.** Exploit path for V-01 at a cost of roughly 2 ADA. Also a
nuisance: the off-chain reader in `yield-chain-decode.ts` looks for a State
datum at the address and will surface whichever one it finds first, so a planted
State can make the UI display a fabricated share price and TVL even when the
contract is safe.

**Fix.** Two parts:
1. On-chain: V-01's fix makes a planted State unspendable and therefore harmless
   to funds.
2. Off-chain: `yield-chain-decode.ts` must reject ambiguity rather than pick.
   When more than one State datum is found at the address, return "vault state
   ambiguous" and refuse to build any transaction, instead of using the first
   match. The bootstrap-detection path that currently reports "no state UTxO"
   should gain a distinct "multiple state UTxOs" case.

**Test to add.** Contract test as in V-01, plus a unit test on the decoder
asserting that two State candidates produce an error, not a value.

---

## V-03 — Withdraw accounting is aggregate, not per-owner — MEDIUM — **FIXED**

> **Fixed.** `Withdraw` now requires exactly one `Position` input and at most
> one `Position` output, the returned Position must carry the spent Position's
> owner and exactly `held - shares`, and `shares.withdraw_ok` (previously
> defined and tested but never called) is wired in alongside `deposit_ok`.
> Tests: `partial_withdraw_must_preserve_owner`,
> `batched_withdraw_cannot_reshuffle_shares`.

**Where:** `yield_vault.ak`, `Withdraw` branch, and `positions_well_formed`.

**Missing rule.** Three separate checks that Stage 3's `vault.ak` performs are
absent from the yield vault:

1. **Owner continuity.** `positions_well_formed` checks `shares > 0` and
   min-ADA on returned positions. It never checks that a returned Position's
   `owner` equals the owner of a Position that was spent. The Stage 3 validator
   explicitly enforces owner-preserving datum continuity for partial withdrawals
   (`SPEC.md` §3); the yield vault dropped that rule when it moved to aggregate
   share accounting.
2. **Per-position bound.** `shares <= total_shares - treasury_shares` bounds the
   redeemer against the *whole vault*, not against the positions actually spent.
   The tie back to reality is indirect, via `shares_delta == -shares`.
3. **Unused guard.** `shares.withdraw_ok` — which encodes exactly the
   per-position bound plus the min-ADA remainder rule — is defined and tested in
   `shares.ak` but is **not imported by the validator**. The validator imports
   `deposit_ok` and not its withdraw counterpart. The rule exists, is tested,
   and does not run.

**What it enables.** Every Position input requires its own owner's signature, so
this is not a theft-from-strangers bug. It is a re-attribution bug among
co-signers: in a transaction spending Alice's 100-share and Bob's 100-share
positions, the aggregate `shares_delta == -shares` is satisfied by any split of
the returned shares, so 150 of the remaining shares can be returned in a
position datumed to Alice and 50 to Bob. Both signed, but neither signed a
statement about *the split*, and a wallet or a malicious dApp front-end
assembling a batched withdrawal decides it unilaterally. It also means a
position can be returned to an owner who never appeared in the inputs at all.

**Fix.** Import and apply `withdraw_ok`, and add owner continuity: every
returned Position's owner must appear among the input Positions' owners, and
per-owner share totals must be non-increasing except for the exact `shares` the
redeemer names. The simplest correct form, given the current one-position-per-tx
off-chain builder, is to require exactly one Position input and at most one
Position output, with `out.owner == in.owner`. That is strictly weaker in
generality but exactly matches what `yield-position.ts` actually builds today,
and it closes the hole without new aggregate machinery.

**Test to add.** `partial_withdraw_must_preserve_owner` (returned position
datumed to a different key — reject) and `batched_withdraw_cannot_reshuffle_shares`
(two owners in, shares redistributed out — reject).

---

## V-04 — The receipt is not a bearer instrument — MEDIUM — **DECIDED-(a)**

> **Decision (a): receipts remain proof of claim with owner-authorized
> redemption.** `RECEIPT.md` now carries a "Transferability status" section
> stating that a transferee acquires no redemption right, that bearer
> redemption is a future stage needing its own spec, and that no UI may present
> receipts as tradeable until it ships. The yield vault card labels receipts
> "proof of claim — not transferable value" and offers no transfer affordance.

**Where:** `yield_vault.ak` `Withdraw`, plus `receipt.ak`.

**Current state.** The binding between the vault and the receipt policy is
two-way and correct as far as supply goes: `Deposit` must mint exactly the
depositor-share delta, `Withdraw` must burn exactly `shares`, every other
redeemer must move zero, and the policy independently re-derives the delta from
the vault's own state transition. Supply cannot drift.

**What is missing.** Authorization is still the `Position` owner's signature.
Consequences:

* A receipt holder who is not the Position owner **cannot** redeem. The token
  transfers freely on-chain but conveys no redemption right, so anyone who buys
  one on a secondary market has bought nothing enforceable.
* The owner **can** redeem without personally holding receipts: the rule is a
  burn of N units of the right policy and name, from anywhere in the
  transaction's inputs. If the owner sold their receipts, they can still redeem
  by sourcing (buying, borrowing, flash-swapping) N units to burn — and the
  buyer's tokens are the ones destroyed if the owner obtains them cheaply.

This is `RECEIPT.md` remaining step 3, and it is a design decision, not a bug:
the current model is "receipt as proof of claim", which is coherent as long as
nothing represents it as tradeable.

**Decision required.** Either
(a) keep owner-authorized redemption and make the non-transferability explicit —
the vault UI must state that receipts are a claim *proof*, not a bearer claim,
and no transfer/trade affordance may be offered; or
(b) move to receipt-authorized redemption: drop the `Position` owner signature
requirement in `Withdraw`, key the payout to whoever burns N receipts, and
delete the `Position` datum's owner field from the authorization path. This is a
substantially larger contract change with its own double-satisfaction surface
and needs its own spec section before code.

Until (b) ships, (a)'s UI warning should be treated as a required mitigation,
not a nicety.

---

## V-05 — Fee proration has no upper time bound — LOW — **FIXED**

> **Fixed as specified below.** `max_settle_window = 7_776_000_000` (90 days)
> added to `shares.ak`; `Accrue` and `SetFee` now require a finite validity
> upper bound and enforce `now <= hi` and
> `now - last_fee_time <= max_settle_window` via `fee_anchor_ok`. Tests:
> `accrue_rejects_future_anchor`, `accrue_rejects_oversized_settle_window`.

**Where:** `yield_vault.ak`, `Accrue` and `SetFee`, via `lower_bound_time`.

**Missing rule.** `now` is the transaction's validity-range *lower* bound, which
the transaction author chooses. The only constraints are `now >= last_fee_time`
and the datum's `n_last_fee_time == now`. There is no comparison against the
validity range's upper bound, and no cap on `now - last_fee_time`.

**What it enables.** The operator committee — which already has to reach M-of-N
for these actions, so this is an insider-only issue — can set a lower bound
arbitrarily far in the future within what the ledger will accept, and charge
management fee for elapsed time that has not elapsed. Fee is settled by minting
treasury shares, so the effect is dilution of every depositor in favour of the
treasury. It is bounded in practice by the ledger's acceptance of the validity
range, not by the contract.

Note the flip side is already handled correctly: the fee is settled *before* the
yield is booked in `Accrue`, so fee is never charged on yield that has not
landed.

**Fix.** Require a finite upper bound and constrain the anchor:
`Finite(hi)` must exist, `now <= hi`, and `now - last_fee_time <= max_settle_window`
(propose 90 days as a constant in `shares.ak`). A committee that misses the
window settles in two transactions instead of one; nothing is lost.

**Test to add.** `accrue_rejects_future_anchor` and
`accrue_rejects_oversized_settle_window`.

---

## V-06 — First-depositor grief is bounded; document the number — LOW — INFO

`shares.min_initial_deposit` is 10 ADA and `deposit_ok` requires the bootstrap
deposit to meet it, with shares minted 1:1 at `total_shares == 0`, fixing the
initial price at exactly 1. Later deposits require `mint_shares > 0`, so dust
deposits that would round to zero shares are rejected.

The classic inflation grief needs the attacker to raise `total_assets` without
raising `total_shares`. The only path that does that is `Accrue`, which requires
M-of-N operator signatures, and a plain donation of lovelace to the address does
**not** raise `total_assets` because the datum is what is accounted, not the
balance. The attack is therefore closed by construction, not merely by the
minimum. Worst-case rounding loss remains 1 lovelace per action, always in the
vault's favour.

No action. Recorded so the reasoning is not re-derived each review.

---

## V-07 — `shares.solvent` is never called — LOW — INFO

`solvent(acc, locked_lovelace)` exists and is tested but is not imported by the
validator. This is deliberate and the validator says so: a transaction contains
only a subset of Position UTxOs, so the total lovelace locked at the address is
not observable on-chain, and a local solvency comparison would be comparing
`total_assets` against a partial balance and would reject honest transactions.

Global solvency is maintained inductively instead — every branch ties `n_assets`
to the exact `value_delta` at the script address. That argument is only as good
as the completeness of the branch set, which is why V-01 matters.

Recommend keeping the function (it is the right check for an off-chain monitor)
and adding a comment at its definition saying it is off-chain-only, so a future
reader does not "fix" the validator by wiring it in.

---

## V-08 — Legacy Stage 3 positions — INFO

`vault.ak` version 1 and 2 addresses remain spendable and must stay that way;
funds there are recoverable by their owners. They carry no share accounting, no
receipt, and no fee. They must never be aggregated into yield-vault TVL or share
price, and the UI must not present them as yield positions. Current behaviour is
correct; recorded as a standing constraint.

---

## Off-chain findings

**O-01 — `assertYieldVaultAddress` is defined and never called — MEDIUM — FIXED.**
> **Fixed.** `assertYieldVaultAddress` now takes the structural shape
> `{ address, assetId }` so it can be reused outside `AppliedYieldVault`.
> `loadMyVaultView`, `depositToYieldVault` and `withdrawFromYieldVault`
> (`yield-position.ts`, via their shared `connect()`) and `buildAccrual`
> (`vault-accrual.ts`) all take an optional `registryAddress` and call the
> guard immediately after deriving the script, before any UTxO is read or
> spent. `useDerivedVaultAddress`'s `isStale` check now delegates to the same
> function instead of a local inequality. `bootstrapYieldVault` deliberately
> does **not** call it — bootstrap (including the re-bootstrap flow in
> `RebootstrapVaultCard`) intentionally targets whatever address the current
> build derives, not the registry's old one; that distinction is recorded as a
> comment at the call site. `AccrueYieldCard` passes the registry's
> `script_address`; `YieldVaultActionsCard` fetches it via `getAssetVault`.

`src/lib/yield-vault.ts` exports it as the drift guard that compares the derived
address against the stored one, but no call site exists anywhere in `src/`.
`assertReceiptPolicy` *is* called, twice, in `yield-position.ts`. The result is
that deposits and withdrawals verify the receipt policy against the datum but
never verify that the address they are building against is the one the current
build derives. After a blueprint change that is exactly the failure mode that
produced the stale sfm-01 address. Fix: call it at the top of every builder in
`yield-position.ts`, `vault-accrual.ts`, and `vault-bootstrap.ts`, and in the
`useDerivedVaultAddress` hook's comparison path.

**O-02 — hand-rolled State datum encoders — MEDIUM — FIXED.**
> **Fixed.** `encodeStateDatum(lucidMod, state)` in `yield-chain-decode.ts` is
> now the single writer for the 11-field `State` constructor, built next to
> `decodeState` so the two stay symmetric. `vault-bootstrap.ts`,
> `vault-accrual.ts` and `yield-position.ts`'s `encodeState` helper all
> delegate to it instead of hand-rolling `Constr(1, [...])`. Regression:
> `scripts/verify-state-datum-roundtrip.ts` (`bun run
> verify:state-datum`, wired into `.github/workflows/contracts.yml`) encodes
> representative states, decodes them with the production `decodeState`, and
> fails on any field mismatch.

`vault-bootstrap.ts`
and `vault-accrual.ts` each build the 11-field `State` constructor by hand as a
positional `Constr(1, [...])` array. `yield-chain-decode.ts` reads it back with
an explicit `fields.length !== 11` guard, but the two writers have no such
guard, and nothing cross-checks writer against reader. A field written in the
wrong position or with the wrong CBOR major type produces a UTxO the validator
cannot spend — funds locked permanently, with no transaction failure at build
time to warn anyone. Fix: a single shared `encodeStateDatum(state)` used by both
writers, plus a round-trip test that encodes a state, decodes it with the
production decoder, and asserts field-for-field equality.

**O-03 — decoder picks the first State — REGRESSED, re-FIXED in Phase 1.**
> **Phase 1:** by 2026-09-17 every transaction builder (`yield-position.ts`,
> `vault-accrual.ts`, `vault-set-fee.ts`, `treasury-claim.ts`) and two readers
> had moved to `selectCanonicalState`, which picks the State with the *highest
> epoch*, a value the planter of a fake State chooses. Both helpers are gone:
> `selectThreadState` / `genuineStateAt` / `genuineLucidState` select the State
> carrying the state-thread token and ignore (and count) the rest, so a planted
> State can neither be built against nor displayed.

Original note: `yield-chain-decode.ts` now
exports `soleStateOrThrow`, which collects every State-shaped UTxO at the
address and throws a descriptive "Vault state ambiguous" error when more than
one exists. Both `getVaultChainState` and `getVaultChainHistory` in
`src/lib/yield-chain.functions.ts` route through it, so a planted State can
never be silently trusted for display or for transaction building.

---

## Recommended order

1. You accept or defer each finding above; V-04 needs an explicit (a)/(b) choice.
2. Off-chain fixes O-01, O-02, O-03 — no blueprint change, no migration, ship
   independently and immediately.
3. Add failing negative tests for V-01, V-03, V-05 against today's validators.
4. Apply the validator fixes, `aiken check`, `aiken build`,
   `node scripts/verify-vault-hash.mjs --strict`, re-pin hashes, update
   `YIELD.md` and `RECEIPT.md`.
5. Withdraw every live Preprod position from the current addresses, re-derive,
   re-bootstrap sfm-01 and sfm-02.

Steps 3-5 are one atomic migration. Do not start step 3 until step 1 is
finished, so the rebuild happens exactly once.

---

## Phase 1 findings (2026-10-17)

Found during the Phase 0 recon of the Tessera rebuild and verified with Aiken
probe tests before any fix. All fixes ship in one rebuild; every affected
shared-State address was empty on Preprod (`scripts/live-state-check.ts`), so
no live position had to migrate, except the legacy yield v3 one noted in F-5.

### F-1 — No state identity: a planted State can be spent alone — CRITICAL — **FIXED**

**Where:** `yield_vault.ak`, `multi_asset_vault.ak`, `fraction_vault.ak`
(fixed); `susdr_vault.ak` (frozen, see below).

**What it enables.** Nothing marked the genuine State, and the V-01 rule only
counts States within one transaction. An attacker pays a State datum copied
from the genuine one but with a cheap share price, spends it on its own in a
`Deposit` (every rule passes), and receives a Position for far more shares than
the deposit is worth. Positions are not bound to the State they were minted
under, so those shares are then withdrawn against the genuine State at its real
price. Probe results: `yield_vault` 10 ADA in, 60 ADA out; `susdr_vault` 11 USDr
in, the whole 100 USDr pool out (its mint handler accepted the planted State
too). The genuine books are left owing the remaining depositors more than they
hold.

**Fix.** Each shared-State validator takes a `seed: OutputReference` parameter
and doubles as the minting policy of a one-shot **state-thread token**
(`lib/stellaris/thread.ak`). Bootstrap must consume the seed, mint exactly one
token, spend no State, and create a valid empty ledger carrying it; the token
can never be burned. Every State transition requires the spent and the
returned State to carry it, the Position branch requires the State input to
carry it, and the State may carry nothing else beside it. Consequence: an
instance's address depends on its seed, so it exists only once bootstrapped and
is pinned in `src/lib/vault-instances.ts`.

**Tests.** `yield_vault`: `planted_state_cannot_be_spent_alone` with its control
`genuine_state_deposit_with_the_same_shape_is_accepted`,
`position_cannot_be_spent_against_a_planted_state`,
`state_must_keep_its_thread_token`,
`state_cannot_carry_junk_beside_its_thread_token`, and seven bootstrap-mint
tests. Equivalent sets in `fraction_vault` (including
`planted_offering_cannot_sell_fractions`) and `multi_asset_vault` (which had no
validator tests at all before). Mutation-checked: removing any thread-token rule
fails at least one test, except two equivalent mutants recorded in the Phase 1
report.

**`susdr_vault`: FROZEN, not fixed.** Never bootstrapped, nothing minted; the
Phase 3 TSRA/sTSRA validators replace it. Its README carries a do-not-bootstrap
notice.

### F-2 — Receipt policy cannot decode the State the vault writes — HIGH — **FIXED**

`receipt.ak` decoded the vault datum through a hand-copied 11-field mirror.
Stage 7 (2026-09-17) widened `State` to 13 fields, so `expect d: Mirror = raw`
crashed on every real State: no `Deposit` (which must mint receipts) or
`Withdraw` (which must burn them) could validate on the v4 blueprint. The
"mirror matches" test built a mirror value and read it back, so it could never
fail. Nothing was stranded only because no v4 instance was ever bootstrapped.

**Fix.** `YieldDatum` moved to `lib/stellaris/yield_datum.ak`, imported by both
validators, so drift is now a compile error. Tests:
`mint_accepts_the_13_field_state_yield_vault_writes`,
`an_11_field_legacy_state_is_rejected`. **F-2 must never ship without F-1:**
while receipts could not be minted, the F-1 drain was blocked end to end by
accident.

### F-3 — Offering reader displays the first Offering datum — MEDIUM — **FIXED**

`readOfferingChainState` (`offerings.functions.ts`) returned `states[0]`, so a
planted Offering could fake the public counters; `registerOffering` and the
fraction event recorder likewise took the first match. All three now use
`genuineOfferingAt` (thread-token based). `offering-tx.ts` refused to build when
two Offerings existed, which made a planted datum a permanent denial of
service; it now ignores token-less Offerings.

### V-03 addendum — `withdraw_ok` had no discriminating test — LOW — **FIXED**

Removing the `withdraw_ok` call left every test passing. Its distinct job is
valuing the *remaining* shares at the current price (`positions_well_formed`
only checks the UTxO's lovelace). Test:
`partial_withdraw_cannot_leave_shares_worth_less_than_the_floor`. On a full
close the call is redundant with other rules (an equivalent mutant).

### F-4 — Position UTxOs are not authenticated — MEDIUM — **OPEN**

Like a planted State, a Position datum can be paid to the vault by anyone. With
F-1 fixed it can only be redeemed against the genuine State, and `Withdraw`
must burn receipts equal to its shares — so whoever holds receipts can create a
Position for themselves and redeem it, paid from the State UTxO's lovelace,
while the original depositor's Position becomes unredeemable. Receipts are
transferable on-chain (V-04), so this is reachable only if a depositor parts
with their receipts, which the UI tells them not to do. Not fixed in Phase 1:
the coherent fix is the bearer-token model (receipts ARE the claim, no Position
UTxOs), which is what the Phase 3 TSRA/sTSRA design uses.

### F-5 — Legacy yield v3 instances are unreachable and pre-F-1 — MEDIUM — **OPEN**

The v4 change (2026-09-17) dropped the v3 blueprint from the app, so v3 UTxOs
cannot be spent from the UI. Preprod on 2026-10-17: `ph-solar-01` v3 holds one
Position of 1,000 tADA (owner = the operator key) plus a duplicate empty State;
`sfm-01`/`sfm-02` v3 hold only empty States. v3 is subject to F-1, so a griefer
could break its books and lock that Position. Recommended: a one-off v3 exit
builder pinned to the frozen v3 blueprint, then retire v3.

### M-1 — `multi_asset_vault` solvency check is a tautology — LOW — **OPEN**

`solvent(VaultAccounting { .., total_assets: n_assets }, n_assets)` compares
`n_assets <= n_assets`. Solvency rests on the per-branch value-delta rules, as
in `yield_vault` (V-07). The vault has no off-chain builder; recorded so the
check is not mistaken for a guard.

### Tooling found broken in Phase 0/1

* `scripts/verify-live-scripts.mjs` crashed: `VAULT_VERSION` moved to
  `vault-params.ts`. `derive-vault-addresses.mjs` failed the same way, and
  `dapp-readiness.mjs` silently fell back to version 1 and checked the wrong
  legacy vault. All three are fixed and seed-aware.
* `src/lib/network.ts` claimed to refuse mainnet but only logged an error; it
  now never resolves to mainnet config while `MAINNET_NOT_ALLOWED` is true.
