# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State
Datum: `minted_supply`, `attested_reserve`, `mint_cap`, `attestation_epoch`,
`paused`, `operators`, `threshold`. Exactly one State UTxO on both inputs and
outputs of every transition (V-01 rule from `contracts/vault/AUDIT.md`).

## 2. TSR policy
Mint only if the same transaction spends the Reserve State and
`minted_supply + qty <= min(attested_reserve, mint_cap)`. Burn is always
allowed to the holder.

## 3. sTessera vault
Share-price accounting per `lib/tessera/exchange.ak`. `total_assets` must equal
the TSR physically locked at the script every transition.

## 4. Redemption queue
Instant tier up to the buffer; Request UTxOs bucketed per day; payable after
`bucket_end + settle_delay` (max 7 days); permissionless settlement to `owner`;
owner cancel before settlement.

## 5. Invariants
1. TSR supply never exceeds the lesser of attested reserve and mint cap.
2. No transition spends or creates more than one State UTxO.
3. Funds only ever leave to the position owner (or the treasury for fees).
