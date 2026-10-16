# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State (implemented: `validators/reserve.ak`)
Datum `ReserveState`: `minted_supply`, `attested_reserve`, `mint_cap`,
`attestation_epoch`, `attested_at`, `epoch`, `operators`, `threshold`, `paused`.

**Authenticity.** The genuine State is the single UTxO carrying the one-shot
NFT `TSR-STATE` (`validators/state_nft.ak`, minted by spending a seed UTxO).
The reserve script is also the TSR minting policy, and the backing is attested
off-chain, so without the NFT anyone could plant their own State at the script
address (own committee, huge `attested_reserve`) and mint real TSR. A State
without the NFT is ignored on both inputs and outputs.

| Redeemer | Who | Effect on datum | TSR mint delta |
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

Known gaps: no committee rotation; every burn spends the single State UTxO so
burns serialise (the queue batches them).

## 2. TSR policy
The reserve script **is** the TSR policy (policy id = script hash, token name
`TSR`). The `mint` handler only requires that the genuine State is spent in the
same transaction; the `spend` handler enforces quantity and rules.

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
