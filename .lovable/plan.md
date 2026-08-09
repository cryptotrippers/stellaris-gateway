# Smart contract security scan

A read-through of `vault.ak`, `yield_vault.ak`, `receipt.ak`, `shares.ak` and the
off-chain builders found the core accounting sound, plus a short list of gaps
worth closing before real value is at risk. This plan produces a written audit
and a prioritised fix set.

## What the scan produces

1. `contracts/vault/AUDIT.md` — one entry per finding: severity, the exact rule
   that is missing, the attack it enables, the test that proves it, the fix.
2. New Aiken negative tests, one per finding, that fail against today's
   validators (proving the gap is real) and pass after the fix.
3. Validator fixes for the accepted findings, then `aiken check` + `aiken build`
   + `node scripts/verify-vault-hash.mjs --strict` and re-pinned hashes.

Any validator change moves the blueprint hashes, so every vault address changes
and must be re-bootstrapped. Positions at old addresses have to be withdrawn
first. That migration is the reason to batch all accepted fixes into one build.

## Findings to write up and test

**High — no "exactly one State input" rule.** The `State` branch calls
`sole_state(outs)` but never checks the inputs. Two State UTxOs at the same
address (a duplicated bootstrap, or a State parked there by anyone who can write
an inline datum) can be spent together and collapsed into one output, with
`locked_in` summed across both. Fix: require exactly one State among
`script_inputs`, mirroring the output rule.

**High — anyone can create a State-shaped output at the vault address.** Nothing
stops a third party paying a `State` datum to the address; combined with the
above this is the setup step for the merge attack. Fix is the same rule plus
treating a second State as unspendable rather than mergeable.

**Medium — Withdraw accounting is aggregate, not per-owner.** `shares_delta` is
the sum over all Position inputs and outputs, and `positions_well_formed` only
checks `shares > 0` and min-ADA; it never checks that a returned Position keeps
its input owner. In a multi-position transaction the co-signers' shares can be
re-attributed between them. The Stage 3 vault enforces owner continuity; the
yield vault should too.

**Medium — receipt burn is not tied to who redeems.** `Withdraw` requires
`receipt_delta == -shares`, but authorization still comes from the Position
owner's signature, so a receipt holder who is not the owner cannot redeem and
the owner can redeem without holding receipts (any burnable supply works). This
is the known Stage 6 step 3 gap; it should be recorded as a finding with an
explicit "not a bearer instrument" warning in the UI until closed.

**Low — Accrue/SetFee time source.** Proration anchors on the validity lower
bound, which operators choose. `now >= last_fee_time` bounds it below, but there
is no upper bound against `now`, so an operator committee can post-date a fee
settlement inside the ledger's allowed window. Add an upper-bound check against
`validity_range.upper_bound` and a maximum settle window.

**Low — no minimum first deposit.** `deposit_ok` and `mint_shares` guard the
`S == 0` case, but confirm the first-depositor price-inflation grief is actually
bounded and document the number.

**Informational — legacy Stage 3 `vault.ak` addresses stay spendable.** Correct
by design, but the audit should record that version 1 and 2 positions have no
receipt or share accounting and must not be shown as yield positions.

**Off-chain checks included in the same pass:** transaction builders in
`yield-position.ts`, `vault-accrual.ts` and `vault-bootstrap.ts` re-encode the
11-field datum by hand — verify each writes exactly the fields the validator
compares, since a mis-encoded datum is an unspendable UTxO, not a rejected
transaction. Also verify `assertReceiptPolicy` and `assertYieldVaultAddress` are
called on every build path.

## Order of work

1. Write `AUDIT.md` with all findings (no code changes) — you review and accept
   or defer each one.
2. Add the failing negative tests for the accepted findings.
3. Apply validator fixes, `aiken check`, `aiken build`, re-pin hashes, update
   `RECEIPT.md`/`YIELD.md`.
4. Re-derive addresses and re-run the Preprod bootstrap for sfm-01 and sfm-02.

Step 1 is safe to do now. Steps 2-4 are the breaking migration and should only
start once you have withdrawn any live Preprod positions.
