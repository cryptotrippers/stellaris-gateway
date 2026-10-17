# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State (implemented: `validators/reserve.ak`)
Datum `ReserveState`: `minted_supply`, `attested_reserve`, `mint_cap`,
`attestation_epoch`, `attested_at`, `epoch`, `operators`, `threshold`, `paused`.

**Authenticity.** The genuine State is the single UTxO carrying the one-shot
NFT `TSRA-STATE` (`validators/state_nft.ak`, minted by spending a seed UTxO).
The reserve script is also the TSRA minting policy, and the backing is attested
off-chain, so without the NFT anyone could plant their own State at the script
address (own committee, huge `attested_reserve`) and mint real TSRA. A State
without the NFT is ignored on both inputs and outputs.

| Redeemer | Who | Effect on datum | TSRA mint delta |
|---|---|---|---|
| `Mint{qty}` | M-of-N, not paused | `minted_supply += qty` | `+qty` |
| `Burn{qty}` | anyone, even when paused | `minted_supply -= qty` | `-qty` |
| `Attest{reserve}` | M-of-N | reserve, `attestation_epoch+1`, `attested_at = lower bound` | 0 |
| `SetCap{mint_cap}` | M-of-N | `mint_cap` | 0 |
| `SetPaused{paused}` | M-of-N | `paused` | 0 |

Every transition: exactly one NFT-bearing State input and output; the next
datum must **equal** the expected datum (`s0` with only the permitted fields
changed, `epoch + 1`); State output holds only ADA + the NFT.

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
* **Committee rotation — Phase 2 must-have.** No redeemer can change
  `operators` or `threshold`; every redeemer's exact-datum check keeps them
  fixed. A lost or compromised operator key therefore cannot be replaced, and
  the only way out is a new State NFT and a new script. Phase 2 must add a
  `Rotate` redeemer (current committee M-of-N, plus `operators_valid` on the
  new committee) before anything leaves Preprod.
* **Genesis datum is not checked on-chain.** `state_nft.ak` only checks the
  seed and the quantity; it does not check where the NFT goes or the initial
  datum. A bad bootstrap (e.g. `threshold: 0`) produces a State that every
  redeemer rejects (`operators_valid`), so it fails closed, but the bootstrap
  builder must validate the datum, and off-chain readers must verify it.
* Every burn spends the single State UTxO, so burns serialise (the queue
  batches them).

## 2. TSRA policy
The reserve script **is** the TSRA policy (policy id = script hash, token name
`TSRA`). The `mint` handler only requires that the genuine State is spent in the
same transaction; the `spend` handler enforces quantity and rules.

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
mutant "survives" if no test fails. 39 mutants in `reserve.ak` and 7 in
`rules.ak`; all are killed except one, which is equivalent.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| Signature threshold | Mint / Attest / SetCap / SetPaused without `signed`; `threshold_met` always true; `operators_valid` dropped | `mint_below_threshold_is_rejected`, `attest_needs_the_committee`, `set_cap_needs_the_committee`, `pause_needs_the_committee`, `a_zero_threshold_committee_cannot_act_unsigned` |
| Pause | Mint ignores `paused` | `mint_while_paused_is_rejected` |
| Reserve cap / mint cap | each bound removed (call site and `rules.mint_allowed`) | `mint_above_attested_reserve_is_rejected`, `mint_above_cap_is_rejected` |
| Freshness | `rules.fresh` removed; unbounded validity accepted; `<=` → `<`; Attest window removed / inverted / unbounded | `mint_with_stale_attestation_is_rejected`, `mint_with_unbounded_validity_is_rejected`, `attest_with_oversized_window_is_rejected`, `inverted_window_is_rejected` |
| NFT check | filter ignores NFT; quantity ≠ 1 accepted; whole check removed; input side / output side unchecked; spent input need not be the State; mint handler without State | `planted_state_without_nft_cannot_mint`, `the_state_nft_cannot_leave_the_state`, `a_state_holding_two_nfts_is_not_genuine`, `a_planted_input_beside_the_genuine_state_is_rejected`, `two_genuine_states_cannot_be_spent_together` |
| Exact datum | next datum unchecked per redeemer; epoch not bumped; Attest anchor unchecked | `burn_cannot_change_the_committee`, `attest_cannot_change_the_cap`, `set_cap_cannot_change_the_committee`, `set_paused_cannot_change_the_reserve`, `attest_must_anchor_at_the_validity_lower_bound`, `mint_replayed_epoch_is_rejected` |
| Foreign tokens | State output may carry junk; foreign name / second name under the TSRA policy | `state_output_may_not_carry_foreign_tokens`, `a_foreign_token_name_cannot_be_minted_under_the_tsra_policy`, `a_second_token_name_cannot_ride_along_with_an_attestation` |
| Quantities | `delta` unchecked per redeemer; Burn `qty > 0` / `qty <= supply`; negative reserve / cap | `burn_with_a_negative_qty_cannot_mint`, `attest_cannot_mint`, `pause_cannot_mint`, `set_cap_cannot_mint_with_an_exact_datum` |

**Equivalent survivor (1).** Removing `list.unique` from `threshold_met`. A
duplicate could only be counted twice if `operators` held a duplicate, but
`operators_valid` rejects any next State with duplicate operators, and every
redeemer's exact-datum check makes the next State's operators equal the
current ones, so a State with duplicates can never be transitioned at all.
Kept as defence in depth: it stops being redundant once committee rotation
(§1 known gaps) lets `operators` change.

Notes:
* `a_planted_input_beside_the_genuine_state_is_rejected` is defence in depth
  at the transaction level: the genuine State's own spend would still need
  the real committee. The unit test pins the per-input rule anyway.
* `a_state_holding_two_nfts_is_not_genuine` cannot happen on chain (the NFT is
  one-shot, quantity 1); the test pins the rule in case `state_nft.ak` changes.
* `burn_with_a_negative_qty_cannot_mint` was the most serious gap: Burn needs
  no signature, so without `qty > 0` a negative burn is an unsigned, uncapped
  mint. The guard was present; nothing tested it.
