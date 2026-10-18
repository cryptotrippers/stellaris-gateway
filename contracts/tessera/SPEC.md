# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State (implemented: `validators/reserve.ak`)
Datum `ReserveState` (`lib/tessera/reserve_state.ak`): `minted_supply`,
`attested_reserve`, `mint_cap`, `attestation_epoch`, `attested_at`, `epoch`,
`operators`, `threshold`, `paused`, and (Phase 2.3) the eligibility switches
`kyc_mint`, `kyc_redeem`, `kyc_stake` plus `eligibility_policy` (§1a).

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
| `Mint{qty, holder}` | M-of-N, not paused; `holder` eligible if `kyc_mint` | `minted_supply += qty` | `+qty` |
| `Burn{qty, holder}` | anyone, even when paused; `holder` eligible if `kyc_redeem` | `minted_supply -= qty` | `-qty` |
| `Attest{reserve}` | M-of-N | reserve, `attestation_epoch+1`, `attested_at = lower bound` | 0 |
| `SetCap{mint_cap}` | M-of-N | `mint_cap` | 0 |
| `SetPaused{paused}` | M-of-N | `paused` | 0 |
| `Rotate{operators, threshold}` | current M-of-N **and** new M-of-N, even when paused | `operators`, `threshold` | 0 |
| `SetKyc{kyc_mint, kyc_redeem, kyc_stake, eligibility_policy}` | M-of-N; policy must be 28 bytes | the three switches and `eligibility_policy` | 0 |

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

## 1a. Eligibility (Phase 2.3: `lib/tessera/eligibility.ak`, `validators/eligibility.ak`)

**One check.** Every action that can be gated calls only
`eligible(tx, policy, holder)`: it passes when `holder` (a payment key hash)
signed the transaction **and** a reference input or spent input holds
exactly one token of `policy` named `holder`. Keeping it to one function is
what lets the launch allowlist be replaced later, without touching the vaults
or the reserve's logic, by a **Midnight zero-knowledge credential**: only
`lib/tessera/eligibility.ak` changes. (Any change there still moves the hash
of every script that calls it, so a swap is a coordinated script upgrade, not
a datum flip.)

**Switches.** `kyc_mint` gates `Mint`, `kyc_redeem` gates `Burn`, and
`kyc_stake` is stored for the sTessera vault (not written yet). Each is off
or on independently; an off switch ignores `holder`. `SetKyc` (committee
M-of-N) sets the three switches and `eligibility_policy` (which must be a
28-byte policy id) and changes nothing else but `epoch + 1`. Repointing
`eligibility_policy` is how a Midnight-issued credential policy plugs in
later without a new reserve script. Genesis sets every switch and the policy
explicitly (the policy must be 28 bytes there too); on Preprod all switches
are off. Off is not forced on-chain: a launch that needs KYC from the first
block may start with switches on.

**Launch implementation: the eligibility registry.** `validators/eligibility.ak`
is both the token's minting policy and the address that holds the tokens. It
is parameterised by the reserve script hash, and reads the committee from the
genuine Reserve State (the one reference input carrying the reserve's thread
token at the reserve address), so a reserve `Rotate` carries over.

* *Issue:* committee M-of-N; each minted name is a 28-byte key hash, minted
  once per transaction; every output carrying a token is at the registry,
  holding exactly ADA plus one token. Tokens never sit in a wallet, so they
  cannot be transferred, and the committee can always revoke them.
* *Revoke:* committee M-of-N spends the registry UTxO and burns its token.
  Nothing at the registry can be spent without the committee, and a token
  can only leave the registry by being burned.
* *Uniqueness* is not enforced on-chain (a policy sees only its own
  transaction): the committee is trusted not to double-issue. A duplicate is
  harmless: `eligible` needs exactly one matching token in some input, and a
  duplicate can be revoked like any other.

**Who the check gates.** `eligible` proves an allowlisted key signed the
transaction. It does not restrict where minted TSRA goes, and TSRA itself
stays freely transferable (native tokens cannot be frozen; DESIGN.md §2).
With `kyc_redeem` on, `Burn` is no longer purely bearer: the committee can
block a holder's redemption by revoking their token. That is the compliance
intent, and it overrides the "burn is never gated by the committee" property
from §1 while the switch is on.

**Design notes for 2.6 (redemption queue).**
* (a) *Eligibility is checked when a redemption request is created, not at
  settlement.* The holder signs and proves eligibility once, when locking
  TSRA into a Request UTxO; settlement then needs no holder signature and
  stays permissionless (anyone may submit it; funds go only to `owner`).
  This resolves the conflict between `eligible`'s holder signature and
  permissionless settlement.
* (b) *A revoked holder keeps a grace period to redeem TSRA they already
  hold* — to be confirmed with counsel. Without it, revoking a token with
  `kyc_redeem` on would strand that holder's TSRA. The mechanism (e.g. a
  revocation timestamp the queue honours for a window) is open until the
  counsel answer; it is not implemented here.

## 2. TSRA policy
The reserve script **is** the TSRA policy (policy id = script hash, token name
`TSRA`), and the same policy carries the `state` thread token. A mint naming
`state` is genesis (§1). Any other mint only requires that the genuine State
is spent in the same transaction; the `spend` handler enforces the exact TSRA
quantity and refuses any other token name under the policy.

## 3. sTSRA vault (implemented: `validators/stsra_vault.ak`, Phase 2.4)

Status: **implemented and tested** (Phase 2.4). The design below was
approved with every recommended default in §3.12 (items marked **[D-n]**);
§3.13 lists where the implementation adds to or departs from it. Datum
types live in `lib/tessera/vault_state.ak`, the Reserve State lookup in
`lib/tessera/reserve_ref.ak`.

### 3.1 Topology

One script, `validators/stsra_vault.ak`, parameterised by
`(seed: OutputReference, reserve: PolicyId)`. It is:

* the spending validator for the vault State, for long-tier Positions and
  for cooldown Tickets;
* the minting policy for three asset names under its own hash: `state` (the
  one-shot thread token, `lib/stellaris/thread.ak`), `sTSRA` (the
  fungible short-tier share token), and `position` (the marker in every
  Position and Ticket — the Phase 1 F-4 lesson).

The committee and the `kyc_stake` switch are read from the **genuine Reserve
State** as a reference input (the one input holding the reserve's thread
token at the reserve address), exactly as `validators/eligibility.ak` does,
so a reserve `Rotate` or `SetKyc` applies to the vault immediately. **[D-6]**

**One State, not one per tier [D-1].** A single State UTxO holds the
accounting of both tiers. ReportYield must update both tiers' prices
atomically (the weighting depends on both tiers' assets in the same
instant); two States would force every ReportYield to spend both anyway,
and would let a stake land in one tier between the two halves of a split.

### 3.2 Tier representation [D-2]

| | Short tier (7–14 day cooldown) | Long tier (30-day lock, ≤ 90) |
|---|---|---|
| Share | fungible **`sTSRA` token** (bearer, transferable) | **Position UTxO** at the vault (marker, non-transferable) |
| Share class | class S: `short_shares`, `short_assets` | class L: `long_shares`, `long_assets` |
| Exit | `RequestUnstake` → cooldown Ticket → `Claim` | `UnlockLong` after `unlock_at` (no extra cooldown) **[D-3]** |

Why two share classes: one exchange rate can only pay one yield rate, so a
1.25x weighting needs the long tier to have its own price. Why the long tier
is a Position and not a second token: a lock cannot be enforced on a bearer
token (it could be sold or moved the moment it is minted). The short tier
stays a token so sTSRA is liquid without touching the vault.

### 3.3 Datum

```
VaultState {
  short_shares: Int,        -- == total sTSRA supply
  short_assets: Int,        -- TSRA owned by class S
  long_shares: Int,         -- == sum of shares over live Positions
  long_assets: Int,         -- TSRA owned by class L
  loss_index: Int,          -- 1e12 at genesis; only ReportLoss (2.5) lowers it
  long_weight_bps: Int,     -- 12_500 proposed; 10_000 <= w <= 15_000
  short_cooldown_ms: Int,   -- 7 days proposed; 7 d <= c <= 14 d
  long_lock_ms: Int,        -- 30 days proposed; c <= l <= 90 d
  protocol_bps: Int,        -- 1_250 proposed; 0 <= p <= 2_000
  first_loss_addr: Address, -- bootstrap parameter until 2.5
  treasury_addr: Address,
  epoch: Int,
}

Position { owner: Address, shares: Int, unlock_at: Int }      -- class L
Ticket   { owner: Address, value: Int, index_at_request: Int,
           claim_after: Int }                                -- cooling
```

The State UTxO holds exactly ADA + the thread token + `short_assets +
long_assets` TSRA (exact-value check, as the reserve does), so
`total_assets` always equals the TSRA physically locked, and no one can
donate TSRA to skew a price. A Position holds exactly ADA + one marker (its
TSRA stays in the State). A Ticket holds exactly ADA + one marker + `value`
TSRA. "TSRA" always means the reserve policy's `TSRA` asset name; any other
token is refused.

Like the reserve datum, `VaultState` is provisional and will move to
`lib/tessera/vault_state.ak` (shared with 2.5/2.6).

### 3.4 Redeemers

| Redeemer | Spends | Who | Effect |
|---|---|---|---|
| `StakeShort{amount, holder}` | State | anyone; `holder` eligible if `kyc_stake` | +`amount` TSRA to State; mint `mint_shares(amount, S)` sTSRA |
| `StakeLong{amount, holder, owner}` | State | anyone; `holder` eligible if `kyc_stake` | +`amount` TSRA to State; create Position (marker) with `unlock_at == hi + long_lock_ms` |
| `RequestUnstake{shares, owner}` | State | anyone holding sTSRA | burn `shares` sTSRA; move `v = redeem_value(shares, S)` TSRA from State into a new Ticket (marker) with `index_at_request == loss_index`, `claim_after == hi + short_cooldown_ms` |
| `Claim` | Ticket (State as **reference input**) | anyone; pays only `owner` | after `claim_after`: pay `owner` `v · loss_index_now / index_at_request`, burn the marker, burn the excess TSRA |
| `UnlockLong` | State + Position | anyone; pays only `owner` | after `unlock_at`: pay `owner` `redeem_value(shares, L)`; burn the marker |
| `ReportYield{gross}` | State | committee M-of-N | §3.5 |
| `SetBounds{…}` | State | committee M-of-N | change weight / cooldown / lock / protocol bps within the hard limits; nothing else |
| `ReportLoss{…}` | State | committee M-of-N | **2.5** — §3.8 |

Every State transition: exactly one genuine State in and out, exact next
datum (only the fields that redeemer may change, `epoch + 1`), exact State
value. Time comes from the validity range: `hi` is the finite upper bound
(the latest the transaction can land), `lo` the lower bound; "after T" means
`lo >= T`.

Minimums (per class): the first stake into an empty class is at least
`min_initial_deposit` (10 TSRA); a Position or Ticket worth less than
`min_position_value` (2 TSRA) cannot be created **[D-7]**. All share and value
maths is `lib/tessera/exchange.ak` (floor rounding in the protocol's
favour), so no non-loss redeemer can lower either class's price.

The policy (`mint` handler): `state` only at genesis (§3.10); `sTSRA` mint or
burn only with the genuine State spent (the State branch fixes the exact
amount); marker mint only with the genuine State spent; marker burn always
allowed by the policy — a marker only exists inside a Position or Ticket,
whose own spend rules decide when it may be burned.

### 3.5 ReportYield and the weighting

Inputs: `gross > 0`, current `A_S = short_assets`, `A_L = long_assets`,
`w = long_weight_bps`, `p = protocol_bps`.

```
cut       = gross * p / 10_000                 (floor)
to_reserve = cut / 2                            (floor)  -> first_loss_addr
to_treasury = cut - to_reserve                         -> treasury_addr
net       = gross - cut                                  -> stays in the State

W_S = A_S * 10_000
W_L = A_L * w
y_L = net * W_L / (W_S + W_L)                   (floor)
y_S = net - y_L

short_assets' = A_S + y_S      long_assets' = A_L + y_L
shares unchanged
```

On-chain checks: committee M-of-N; `gross > 0`; `W_S + W_L > 0` (yield into
an empty vault is refused); the State's TSRA rises by exactly `net`; an
output at `first_loss_addr` carries at least `to_reserve` TSRA and one at
`treasury_addr` at least `to_treasury` (both must physically leave in this
transaction, so "yield reported without funds" cannot pass — the TSRA must
come from the committee's inputs).

**Conservation.** `y_S + y_L = net` by construction (y_S is the remainder),
and `net + to_reserve + to_treasury = gross`, so every unit of reported
yield is accounted for exactly once.

**Weighting.** Up to one unit of rounding (which falls to class S),
`y_L / A_L = (w / 10_000) · y_S / A_S`: one TSRA in the long tier earns
`w/10_000` times what one TSRA in the short tier earns. The long tier's
extra comes out of `net`, i.e. out of the short tier's share of the stakers'
pool, never out of `cut`: `cut` is fixed from `gross` before the split, and
`w` does not appear in it. Both increments are `>= 0`, so ReportYield never
lowers a price.

**Fee settlement [D-4].** The protocol cut is **paid out in TSRA**, not
minted as shares: the protocol never holds stake, so it cannot dilute
stakers and is not shielded inside the pool when a loss lands, and the
State's TSRA stays equal to `short_assets + long_assets`. (`exchange.ak`'s
`fee_shares_for` is therefore unused.)

**The 3% first-loss cap [D-5].** The reserve should stop receiving half the
cut once it reaches 3% of TSRA liabilities. Liabilities are readable
(`minted_supply` in the Reserve State reference input), but the first-loss
reserve's balance is not: a plain address can hold many UTxOs and a
transaction cannot prove their total. Until 2.5 gives the first-loss reserve
its own State UTxO with a tracked balance, 2.4 always sends half the cut to
`first_loss_addr`; the 3% check is added in 2.5 (the vault then reads that
State as a reference input). This never under-funds the reserve.

### 3.6 Cooldown tickets: "the lower of request-time and claim-time value"

At `RequestUnstake` the holder's sTSRA is burned and its current value
`v = redeem_value(shares, S)` leaves the pool into the Ticket, which also
records `index_at_request = loss_index`. From then on the Ticket earns
nothing: ReportYield credits only `short_assets` and `long_assets`, and the
Ticket's TSRA is no longer in either.

At `Claim` (after `claim_after`):

```
payout = v * loss_index_now / index_at_request          (floor)
excess = v - payout                                      (burned)
```

`loss_index` starts at 1e12 and only ReportLoss lowers it (by the loss
rate applied to the stakers), so `payout = min(v, value at claim time)`:

* no loss during cooldown → `loss_index_now == index_at_request` →
  `payout = v` (the request-time value; no yield earned in cooldown);
* a loss of rate `r` during cooldown → `payout = v·(1−r)`, exactly what the
  same TSRA would be worth had it stayed staked — nobody escapes a loss
  recorded during cooldown.

`Claim` reads the State only as a **reference input**, so claims never
contend with the State. `excess` is 0 until ReportLoss exists; once it can
be positive it must be burned through the reserve (TSRA `Burn`) in the
claim transaction — the 2.5 loss path.

### 3.7 Long-tier unlock

`UnlockLong` (after `unlock_at`) pays `redeem_value(shares, L)` at the
current class-L price and removes the Position; the 30-day lock is itself
the notice period, so there is no second cooldown **[D-3]**. Partial
unlocks are not supported (a Position is all or nothing), which also makes
the 2 TSRA minimum a creation-time rule **[D-7]**.

### 3.8 ReportLoss (2.5) — the hook

Only a committee-signed `ReportLoss` may lower a share price, and 2.5 will
allow it only after the first-loss reserve is exhausted (proved from the
first-loss reserve's State). Its shape, which 2.4 already accommodates:

* a loss rate `r` applied **by assets** to both classes (`short_assets`
  and `long_assets` × (1−r); shares unchanged) — the weighting is a yield
  rule, not a loss rule;
* `loss_index × (1−r)`, which Tickets pick up at Claim (§3.6);
* the lost TSRA burned through the reserve in the same transaction.

Nothing in 2.4 blocks this: no invariant says a price only rises (only that
non-loss redeemers cannot lower it), the index exists from genesis, and
Tickets already compute against it. **Reserve dependency:** a vault-driven
burn has no holder signature, so with `kyc_redeem` on the reserve's `Burn`
would refuse it; 2.5 needs a committee-signed loss-burn path on the
reserve that `kyc_redeem` does not gate. Flagged now so 2.5 plans it.

### 3.9 eUTxO contention

| Action | Touches | Contention |
|---|---|---|
| sTSRA transfer | nothing of the vault | none |
| Claim | Ticket; State as reference input | none (unless a loss excess must be burned) |
| StakeShort / StakeLong / RequestUnstake / UnlockLong | the single State | **serialised: one per State update** |
| ReportYield / SetBounds | the single State | rare, committee-driven |
| every action that needs the committee or `kyc_stake` | the Reserve State as reference input | **stale reference**: the Reserve State changes on every TSRA mint and burn, so a vault tx built against an old one fails and must be rebuilt **[D-6]** |

Mitigations in 2.4: Claims and transfers never touch the State; Tickets
carry their own TSRA so the cooldown queue scales without the State;
committee actions are rare. Stake/unstake throughput is one State
transition per block (~20 s on Preprod) — acceptable for Preprod, and the
known upgrade path is batching through order UTxOs (like the redemption
queue), deferred until volume needs it. For the stale Reserve State the
builder retries against the latest UTxO; the alternative, caching the
committee and `kyc_stake` in the vault State with a permissionless `Sync`
redeemer, removes the dependency but opens a window where a rotation or a
`SetKyc` has not reached the vault yet.

### 3.10 Genesis

As `reserve.ak`: the `state` mint consumes the seed, mints exactly one
`state` and nothing else, spends no vault input, and creates exactly one
output at the vault address holding exactly ADA + the token (no TSRA), with
an inline `VaultState` of zero shares and assets, `loss_index == 1e12`,
`epoch == 0`, parameters within their hard limits, and `first_loss_addr` /
`treasury_addr` that are not the vault itself.

### 3.11 Test plan

*Genesis:* good genesis accepted; each bad field rejected (non-zero
balances, index ≠ 1e12, epoch ≠ 0, weight > 1.5x or < 1x, cooldown outside
7–14 d, lock > 90 d or < cooldown, protocol bps > 20%, fee address = vault);
token sent elsewhere; two vault outputs; TSRA or foreign tokens in the
State; seed not spent; State spent alongside; `state` minted twice.

*StakeShort / StakeLong:* first stake ≥ 10 TSRA accepted, 9.999999
rejected (**first-depositor inflation**); shares minted = `mint_shares`,
floor; minting one more sTSRA than owed rejected; TSRA other than the
reserve's `TSRA` rejected; State TSRA not rising by `amount` rejected;
`kyc_stake` on + ineligible rejected, on + eligible accepted, off needs
nothing; Position without marker / with two markers / with TSRA inside
rejected; `unlock_at` earlier than `hi + long_lock_ms` rejected; unbounded
validity rejected; Position below 2 TSRA rejected.

*RequestUnstake / Claim:* Ticket value = `redeem_value`, floor; Ticket
`claim_after` earlier than `hi + cooldown` rejected; `index_at_request` ≠
`loss_index` rejected; sTSRA not burned (or burned short) rejected;
**early claim** (`lo < claim_after`) rejected (**cooldown bypass**); claim
paying anyone but `owner` rejected; claim paying more than
`v · index_now / index_at_request` rejected; claim with a **planted
Ticket** (no marker, or marker forged without the State) rejected;
**ticket replay** — the marker must be burned and the Ticket is a spent
UTxO, so a second claim of the same Ticket cannot be built; claim against
a planted vault State reference rejected; a claim after a simulated index
drop pays the lower value and must burn the excess.

*UnlockLong:* **early unstake** (`lo < unlock_at`) rejected; pays exactly
`redeem_value(shares, L)` to `owner`; marker not burned rejected; a
**planted Position** (no marker) rejected.

*ReportYield:* committee required (and follows a reserve `Rotate`);
**yield reported without funds** — State TSRA not rising by `net`
rejected; fee outputs missing or short rejected; first-loss / treasury
split wrong rejected; split between tiers ≠ the formula rejected (and the
remainder rule: short gets the rounding); empty vault rejected; `gross ≤ 0`
rejected; the conservation identity `y_S + y_L + cut = gross` as a
property-style test over a table of values; ReportYield changing shares or
params rejected.

*SetBounds:* committee required; **weighting above cap** (> 1.5x) rejected;
**fee above cap** (> 20%) rejected; cooldown < 7 d or > 14 d rejected; lock
> 90 d rejected; touching balances rejected.

*Identity / generic:* **planted State** (no thread token) cannot be spent,
cannot authorise sTSRA or marker mints; two genuine States rejected;
foreign tokens in the State rejected; sTSRA minted without the State spent
rejected; markers conserved (no marker leaves the vault except by burning).

Then a mutation pass over every guard, as in §6.

### 3.12 Decisions to confirm

* **[D-1]** One State for both tiers.
* **[D-2]** Short tier = fungible `sTSRA` token; long tier = locked Position
  UTxO with its own share class.
* **[D-3]** Long tier pays out directly at unlock (no extra 7-day cooldown);
  Positions are all-or-nothing.
* **[D-4]** Protocol cut paid out in TSRA at ReportYield (half to
  `first_loss_addr`, half to `treasury_addr`), not minted as shares.
* **[D-5]** The 3%-of-liabilities stop for the first-loss share is
  deferred to 2.5; until then half the cut always goes to the first-loss
  address.
* **[D-6]** Committee and `kyc_stake` read live from the Reserve State
  reference input (accepting rebuilds when it changes), rather than cached
  in the vault with a `Sync` redeemer.
* **[D-7]** The 2 TSRA minimum applies at creation of Positions and
  Tickets; the 10 TSRA minimum applies per class to the first stake.
* Tickets escrow their TSRA (so Claim does not touch the State) and use a
  loss index for the "lower of" rule.
* Claims and unlocks are permissionless (funds only to `owner`); owners are
  full addresses, not just key hashes.
* `kyc_stake` gates staking only; unstake, claim and unlock are never
  gated (sTSRA is transferable; redemption gating lives on the reserve's
  `Burn`).
* 2.5 needs a reserve loss-burn path not gated by `kyc_redeem` (§3.8).

### 3.13 Implementation notes (deviations from the design above)

* **One Ticket per Claim, one Position per UnlockLong.** Both pay an owner,
  so two of them in one transaction could be satisfied by a single payout
  output (double satisfaction). A Claim may spend no other vault UTxO; an
  UnlockLong spends exactly the State and one Position.
* **Fee payments are summed per address** (`paid_tsra`), and genesis requires
  `first_loss_addr != treasury_addr` and neither at the vault, so one output
  cannot count towards both fee checks.
* **The Claim payout is capped at the escrowed value** (`min(v, v · index_now
  / index_at_request)`). The index can only fall, so the cap never binds
  today; it stops a future index bug from paying out more than the Ticket
  holds.
* **`StakeLong` names the Position's `owner`** in the redeemer, and the
  Position datum must match it; `RequestUnstake` does the same for the
  Ticket.
* **`unlock_at` and `claim_after` are exact** (`== hi + lock`,
  `== hi + cooldown`): a builder sets the upper bound, so the contract fixes
  the earliest exit to it rather than accepting any later time.
* **Time windows are not capped.** A staker may choose a far-future upper
  bound; that only delays their own exit.
* **`SetParams` is named `SetBounds`** (as approved).

### 3.14 Open items

1. **For 2.5 — loss-burn path on the reserve.** A vault-driven TSRA burn
   (ReportLoss, or a Claim's excess after a loss) has no holder signature,
   so with `kyc_redeem` on the reserve's `Burn` refuses it. 2.5 must add a
   committee-signed loss-burn path on the reserve that `kyc_redeem` does not
   gate.
2. **Before 2.6 — split the Reserve State?** Decide whether to split it into
   a rarely-changing *config* UTxO (committee, switches, eligibility policy),
   read by the vault and the queue, and a hot *supply* UTxO (minted supply,
   attested reserve). Today every TSRA mint or burn invalidates in-flight
   vault transactions that reference the Reserve State (§3.9, D-6).

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

### Phase 2.3 (eligibility)

36 mutants over `lib/tessera/eligibility.ak` (6), `validators/eligibility.ak`
(16) and the reserve's KYC guards (14). All are killed except three, which
are equivalent.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| `eligible()` | holder signature not required; reference / spent inputs not searched; token count `>= 1`; token name ignored; token policy ignored | `token_without_the_holders_signature_is_not_eligible`, `another_holders_token_is_not_eligible`, `exactly_one_token_is_required`, `a_token_under_another_policy_is_not_eligible`, `signer_with_a_spent_token_is_eligible` |
| Issue | committee not required; amounts unchecked; name need not be a key hash; more than one per name; empty mint | `issuing_needs_the_committee`, `issuing_by_the_holder_alone_is_rejected`, `issuing_a_name_that_is_not_a_key_hash_is_rejected`, `issuing_two_of_one_name_into_separate_outputs_is_rejected`, `an_empty_mint_does_not_pass` |
| Registry | tokens may leave; address unchecked; extra value allowed; several names per output | `issuing_into_a_wallet_is_rejected`, `a_registry_output_may_not_carry_extra_tokens`, `two_holders_tokens_may_not_share_a_registry_output` |
| Committee source | planted Reserve State accepted; reserve address unchecked | `issuing_against_a_planted_reserve_state_is_rejected`, `issuing_against_a_reserve_state_off_the_reserve_address_is_rejected`, `issuing_follows_a_rotated_committee` |
| Revoke | committee not required; burn not required | `revoking_needs_the_committee`, `the_holder_cannot_spend_their_registry_token`, `junk_at_the_registry_needs_the_committee_to_sweep`, `a_registry_token_cannot_be_moved_without_burning` |
| Reserve KYC gates | Mint / Burn gate dropped; gate always open; gate ignores the switch; Mint reads the redeem switch; Burn reads the mint switch | `kyc_mint_on_an_ineligible_mint_is_rejected`, `kyc_redeem_on_an_ineligible_burn_is_rejected`, `kyc_mint_off_minting_needs_no_eligibility`, `kyc_redeem_alone_does_not_gate_minting`, `kyc_mint_alone_does_not_gate_burning` |
| SetKyc | committee not required; may mint; next datum unchecked; each switch taken from the datum; epoch not bumped | `set_kyc_without_the_committee_is_rejected`, `set_kyc_cannot_mint`, `set_kyc_cannot_change_the_eligibility_policy`, `set_kyc_datum_mint_switch_must_match_the_redeemer`, `set_kyc_datum_redeem_switch_must_match_the_redeemer`, `set_kyc_datum_stake_switch_must_match_the_redeemer`, `set_kyc_must_bump_the_epoch` |
| Genesis | eligibility policy unchecked | `genesis_with_an_eligibility_policy_that_is_not_a_policy_id_is_rejected` |

**Equivalent survivors (3).**
* *Issue: zero quantity allowed* (`qty < 0` → `qty <= 0`). The ledger never
  carries a zero-quantity entry in a transaction's mint field, so `qty == 0`
  cannot reach the policy.
* *Registry: any count per output* (`[Pair(name, 1)]` → `[Pair(name, _)]`).
  The exact-value check on the same output (`without_lovelace(value) ==
  from_asset(policy, name, 1)`) already requires the count to be 1.
* *Committee: several Reserve States accepted* (`[s]` → `[s, ..]`). Only one
  UTxO can ever hold the reserve's thread token (one-shot mint, never
  burned), so at most one reference input can match.

Three survivors in the first run were real test gaps and now have tests:
two of one name minted into two separate registry outputs, and the SetKyc
mint and redeem switches each taken from the datum instead of the redeemer.

2.3 review: `SetKyc` may now also repoint `eligibility_policy`. 7 mutants on
that guard (length check dropped, `>= 28`, `<= 28`, policy taken from the
datum, policy never changes, committee not required, next datum unchecked),
all killed — by `set_kyc_with_an_invalid_policy_id_is_rejected`,
`set_kyc_with_a_29_byte_policy_id_is_rejected`,
`set_kyc_datum_policy_must_match_the_redeemer`,
`set_kyc_changing_the_policy_with_the_committee_is_accepted`,
`set_kyc_changing_the_policy_without_the_committee_is_rejected` and others.
