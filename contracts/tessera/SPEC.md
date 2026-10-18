# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State (implemented: `validators/reserve.ak`)
Datum `ReserveState`: `minted_supply`, `attested_reserve`, `mint_cap`,
`attestation_epoch`, `attested_at`, `epoch`, `operators`, `threshold`, `paused`.

**Authenticity.** The genuine State is the single UTxO carrying the one-shot
state-thread token (asset name `state`, `lib/stellaris/thread.ak`, the same
module the vaults use) under the reserve script's own policy. `reserve.ak` is
parameterised by a `seed` UTxO and mints the token itself, once, by consuming
the seed. The reserve script is also the TSRA minting policy, and the backing
is attested off-chain, so without the token anyone could plant their own State
at the script address (own committee, huge `attested_reserve`) and mint real
TSRA. A State without the token is ignored on both inputs and outputs.

**Genesis (on-chain since Phase 2.2).** The thread-token mint is the only
transaction that creates the State, and it checks:

* the seed is consumed and exactly one `state` token is minted under the
  policy, nothing else (no TSRA in the same transaction);
* no State is spent alongside it;
* exactly one output at the reserve address, holding exactly ADA plus the
  token (no foreign tokens, no TSRA) — which also proves the token went
  there and nowhere else;
* an inline `ReserveState` with `minted_supply == 0`, `attestation_epoch == 0`,
  `epoch == 0`, `attested_reserve >= 0`,
  `0 <= mint_cap <= 1,000,000,000 TSRA` (`rules.max_mint_cap`, 1e15 units)
  and a valid committee;
* `attested_at` equals the transaction's validity lower bound, inside a
  finite window of at most 1 day (`rules.window_ok`). Without this, a
  genesis `attested_at` far in the future would keep `rules.fresh` true
  forever, so the committee could mint up to the genesis `attested_reserve`
  without ever attesting again.

The thread token can never be burned or minted again: any mint naming it goes
through the genesis check, which needs the (already spent) seed.

**Committee (hard limits).** A valid committee has no duplicate keys and
`2 <= threshold <= size` (`rules.min_threshold`). The proposed launch
committee is 3-of-5, a bootstrap parameter, not a validator constant.

| Redeemer | Who | Effect on datum | TSRA mint delta |
|---|---|---|---|
| `Mint{qty}` | M-of-N, not paused | `minted_supply += qty` | `+qty` |
| `Burn{qty}` | anyone, even when paused | `minted_supply -= qty` | `-qty` |
| `Attest{reserve}` | M-of-N | reserve, `attestation_epoch+1`, `attested_at = lower bound` | 0 |
| `SetCap{mint_cap}` | M-of-N | `mint_cap` | 0 |
| `SetPaused{paused}` | M-of-N | `paused` | 0 |
| `Rotate{operators, threshold}` | current M-of-N **and** new M-of-N, even when paused | `operators`, `threshold` | 0 |

Every transition: exactly one token-bearing State input and output; the next
datum must **equal** the expected datum (`s0` with only the permitted fields
changed, `epoch + 1`); the next committee is valid; the State output holds
exactly ADA + the thread token. `SetCap` is bounded by the same
1,000,000,000 TSRA hard ceiling as genesis. The proposed genesis `mint_cap` is
5,000,000 TSRA; that is a bootstrap parameter the committee can later move
with `SetCap`, not a validator limit. Minting is still bounded by the lower
of `attested_reserve` and `mint_cap` (`rules.mint_allowed`).

**Rotation.** `Rotate` replaces `operators` and `threshold` and nothing else.
The current committee must meet its threshold (authorisation) and so must
the new one (liveness: a rotation cannot hand the State to keys nobody
controls). The datum must install exactly the committee named in the
redeemer. Rotation is allowed while paused, so a compromised key can be
replaced during an incident.

Mint requires `minted_supply + qty <= min(attested_reserve, mint_cap)`, and a
finite validity upper bound `<= attested_at + 7 days` (`rules.fresh`).
Attest requires a finite range of at most 1 day whose lower bound is not before
the previous `attested_at` (`rules.window_ok`). Attesting a reserve *below*
`minted_supply` is allowed: it reports an undercollateralised reserve honestly
and blocks further minting.

**Datum is provisional.** The `ReserveState` fields above (in particular the
committee model, the attestation format and whether a reserve asset is held
on-chain) depend on counsel's answers on the issuance structure and on
DESIGN.md decision 4 (reserve asset and custodian). Expect the datum, and so
the script hash, to change before any bootstrap; nothing should be deployed
or pinned against this version.

Known gaps:
* ~~Committee rotation~~ — **closed in Phase 2.2** (`Rotate`, above).
* ~~Genesis validation at bootstrap~~ — **closed in Phase 2.2**: the NFT mint
  moved into `reserve.ak` (thread pattern), which removed the NFT-policy /
  reserve-hash circularity and lets the mint check the genesis output.
  `state_nft.ak` is retired.
* Rotation has no time lock or cancellation window: the current and new
  committees can rotate in a single transaction. A delay would need a
  pending-rotation field in the (provisional) datum.
* Every burn spends the single State UTxO, so burns serialise (the queue
  batches them).

## 2. TSRA policy
The reserve script **is** the TSRA policy (policy id = script hash, token name
`TSRA`), and the same policy carries the `state` thread token. A mint naming
`state` is genesis (§1). Any other mint only requires that the genuine State
is spent in the same transaction; the `spend` handler enforces the exact TSRA
quantity and refuses any other token name under the policy.

## 3. sTessera vault
Share-price accounting per `lib/tessera/exchange.ak`. `total_assets` must equal
the TSRA physically locked at the script every transition.

## 4. Redemption queue
Instant tier up to the buffer; Request UTxOs bucketed per day; payable after
`bucket_end + settle_delay` (max 7 days); permissionless settlement to `owner`;
owner cancel before settlement.

## 5. Invariants
1. TSRA supply never exceeds the lesser of attested reserve and mint cap.
2. No transition spends or creates more than one State UTxO.
3. Funds only ever leave to the position owner (or the treasury for fees).

## 6. Mutation testing (`validators/reserve.ak`, `lib/tessera/rules.ak`)

Each guard was deleted (or weakened) in turn and `aiken check` re-run; a
mutant "survives" if no test fails. Phase 2.2 ran the new guards (genesis,
rotation, committee hard limits, cap ceiling, exact State value) and re-ran
every Phase 1 mutant, re-pointed where the code moved: 43 mutants in
`reserve.ak` and 7 in `rules.ak`. All are killed except one, which is
equivalent.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| Genesis datum | each of `minted_supply == 0`, `attestation_epoch == 0`, `epoch == 0`, `attested_reserve >= 0`, `mint_cap >= 0`, cap ceiling, committee check dropped | `genesis_with_non_zero_supply_is_rejected`, `genesis_with_non_zero_epoch_is_rejected`, `genesis_with_cap_above_the_hard_limit_is_rejected`, `genesis_with_duplicate_operators_is_rejected`, `genesis_with_threshold_zero_is_rejected` |
| Genesis anchor | `attested_at == lo` dropped; window dropped; unbounded validity accepted | `genesis_with_a_future_dated_attestation_is_rejected`, `genesis_with_an_oversized_window_is_rejected`, `genesis_without_a_validity_bound_is_rejected_even_at_time_zero` |
| Genesis shape | one-shot / seed dropped; State spent alongside; State value unchecked; extra reserve outputs; mint handler always passes / never routes to genesis | `genesis_without_the_seed_is_rejected`, `genesis_cannot_spend_a_state_alongside`, `genesis_nft_sent_elsewhere_is_rejected`, `genesis_state_cannot_hold_tsra`, `genesis_with_two_outputs_at_the_reserve_is_rejected`, `good_genesis_is_accepted`, `the_thread_token_can_never_be_burned` |
| Rotation | current committee not required; new committee need not sign; may mint; next datum unchecked; datum operators / threshold need not match redeemer; epoch not bumped | `rotation_below_the_current_threshold_is_rejected`, `rotation_the_new_committee_did_not_sign_is_rejected`, `rotation_cannot_mint`, `rotation_cannot_touch_the_reserve`, `rotation_datum_must_match_the_redeemer`, `rotation_datum_threshold_must_match_the_redeemer`, `rotation_must_bump_the_epoch`, `after_rotation_the_old_committee_cannot_rotate_back` |
| Committee hard limits | min threshold 2 → 1; `threshold <= size` dropped; duplicates allowed; structural check dropped | `genesis_with_a_single_key_threshold_is_rejected`, `rotation_to_a_single_key_committee_is_rejected`, `genesis_with_threshold_above_committee_size_is_rejected`, `rotation_to_an_empty_committee_is_rejected` |
| Signature threshold | Mint / Attest / SetCap / SetPaused without `signed`; `threshold_met` always true | `mint_below_threshold_is_rejected`, `attest_needs_the_committee`, `set_cap_needs_the_committee`, `pause_needs_the_committee`, `after_rotation_the_old_committee_cannot_mint` |
| Pause | Mint ignores `paused` | `mint_while_paused_is_rejected` |
| Reserve cap / mint cap | each bound removed (call site and `rules.mint_allowed`); SetCap ceiling dropped | `mint_above_attested_reserve_is_rejected`, `mint_above_cap_is_rejected`, `set_cap_above_the_hard_limit_is_rejected` |
| Freshness | `rules.fresh` removed; unbounded validity accepted; `<=` → `<`; Attest window removed / inverted / unbounded | `mint_with_stale_attestation_is_rejected`, `mint_with_unbounded_validity_is_rejected`, `attest_with_oversized_window_is_rejected`, `inverted_window_is_rejected` |
| Thread-token check | filter ignores token; quantity ≠ 1 accepted; whole check removed; input / output side unchecked; spent input need not be the State; TSRA mint handler without State | `a_planted_input_beside_the_genuine_state_is_rejected`, `a_state_holding_two_nfts_is_not_genuine`, `a_stray_output_at_the_script_does_not_block_the_state`, `two_genuine_states_cannot_be_spent_together`, `planted_state_cannot_unlock_tsra_mint_handler` |
| Exact datum | next datum unchecked per redeemer; epoch not bumped; Attest anchor unchecked | `burn_cannot_change_the_committee`, `attest_cannot_change_the_cap`, `set_cap_cannot_change_the_committee`, `set_paused_cannot_change_the_reserve`, `attest_must_anchor_at_the_validity_lower_bound`, `mint_replayed_epoch_is_rejected` |
| State value / foreign tokens | State value unchecked; thread count only (TSRA parked in the State); foreign name / second name under the TSRA policy | `state_output_may_not_carry_foreign_tokens`, `the_state_cannot_hold_tsra`, `a_foreign_token_name_cannot_be_minted_under_the_tsra_policy`, `a_second_token_name_cannot_ride_along_with_an_attestation` |
| Quantities | `delta` unchecked per redeemer; Burn `qty > 0` / `qty <= supply`; negative reserve / cap | `burn_with_a_negative_qty_cannot_mint`, `attest_cannot_mint`, `pause_cannot_mint`, `set_cap_cannot_mint_with_an_exact_datum` |

**Equivalent survivor (1).** Removing `list.unique` from `threshold_met`. A
signer can only be counted twice if a committee list holds a duplicate key,
and none ever can: genesis requires `operators_valid`, every transition
requires it of the next State, `Rotate` must install exactly the committee
named in its redeemer (so the new committee checked by `threshold_met` is the
validated one), and every other redeemer keeps the committee unchanged. Kept
as defence in depth.

Two Phase 2.2 mutants survived the first run and were real test gaps, now
closed: an unbounded genesis with `attested_at == 0`
(`genesis_without_a_validity_bound_is_rejected_even_at_time_zero`), and a
rotation whose datum threshold differs from the redeemer's
(`rotation_datum_threshold_must_match_the_redeemer`).

Notes:
* `a_planted_input_beside_the_genuine_state_is_rejected` is defence in depth
  at the transaction level: the genuine State's own spend would still need
  the real committee. The unit test pins the per-input rule anyway.
* `a_state_holding_two_nfts_is_not_genuine` cannot happen on chain (the token
  is one-shot, quantity 1); the test pins the rule in case genesis changes.
* `burn_with_a_negative_qty_cannot_mint` was the most serious Phase 1 gap:
  Burn needs no signature, so without `qty > 0` a negative burn is an
  unsigned, uncapped mint. The guard was present; nothing tested it.
