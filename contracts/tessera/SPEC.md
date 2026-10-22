# Tessera — specification (skeleton)

Fill each section before the matching validator is written. Test vectors are
listed in `DESIGN.md` §5.

## 1. Reserve State (implemented: `validators/reserve.ak`)

**Two UTxOs (Phase 2.5a).** The Reserve State is a **Config** and a **Supply**
at the reserve address, each carrying its own one-shot thread token under the
reserve script's policy (`config` and `supply`, `lib/tessera/reserve_threads.ak`).
Distinct datum constructors (`ReserveDatum = ConfigDatum | SupplyDatum`) mean
one can never be read as the other.

```
ConfigState {            -- changes only by committee action
  operators, threshold, paused,
  kyc_mint, kyc_redeem, kyc_stake, eligibility_policy,
  epoch                  -- Config's own replay counter
}
SupplyState {            -- the hot books
  minted_supply, attested_reserve, mint_cap,
  attestation_epoch, attested_at,
  epoch                  -- Supply's own replay counter
}
```

Why the split: every TSRA mint or burn spends the Supply, and the vault, the
eligibility registry and (later) the redemption queue all need the committee
and the switches. Read from a single State, any in-flight transaction would be
invalidated by supply traffic, and because `Burn` is permissionless anyone
could keep exits failing for the price of a transaction fee. They now read the
**Config by reference**, and only committee actions can spend it.

**Authenticity.** The genuine Config and Supply are the two UTxOs carrying the
one-shot thread tokens (`lib/stellaris/thread.ak`'s idea, two names, so the
shared four-project `thread.ak` is untouched). `reserve.ak` is parameterised by
a `seed` UTxO and mints both tokens itself, once, by consuming the seed. The
reserve script is also the TSRA minting policy, and the backing is attested
off-chain, so without the tokens anyone could plant their own Config or Supply
at the script address (own committee, huge `attested_reserve`) and mint real
TSRA. A UTxO without its token is ignored on both inputs and outputs, and a
datum of the wrong kind under a token is not genuine.

**Genesis (on-chain since Phase 2.2; two tokens since 2.5a).** The thread-token
mint is the only transaction that creates the Config and Supply, and it checks:

* the seed is consumed and exactly one `config` and one `supply` token are
  minted under the policy, nothing else (no TSRA in the same transaction);
* no Config or Supply is spent alongside it;
* exactly two outputs at the reserve address, each at the enterprise address
  with no reference script: the Config holding exactly ADA plus the `config`
  token, the Supply holding exactly ADA plus the `supply` token (no foreign
  tokens, no TSRA) — which also proves each token went to its own output and
  nowhere else;
* an inline `ConfigDatum` with `epoch == 0`, a valid committee and a 28-byte
  `eligibility_policy`;
* an inline `SupplyDatum` with `minted_supply == 0`, `attestation_epoch == 0`,
  `epoch == 0`, `attested_reserve >= 0`, `0 <= mint_cap <= 1,000,000,000 TSRA`
  (`rules.max_mint_cap`, 1e15 units);
* `attested_at` equals the transaction's validity lower bound, inside a
  finite window of at most 1 day (`rules.window_ok`). Without this, a
  genesis `attested_at` far in the future would keep `rules.fresh` true
  forever, so the committee could mint up to the genesis `attested_reserve`
  without ever attesting again.

**The thread tokens move only at genesis.** Outside it, the mint handler
refuses *any* mint or burn of `config` or `supply`: a transaction whose mint
names either token must be the exact genesis (one of each, seed spent), so a
second Config, a second Supply, a burn of either, or a TSRA mint that also
mints either is rejected.

**Committee (hard limits).** A valid committee has no duplicate keys and
`2 <= threshold <= size` (`rules.min_threshold`). The proposed launch
committee is 3-of-5, a bootstrap parameter, not a validator constant.

| Redeemer | Spends | Reads (reference) | Who | Effect on datum | TSRA mint delta |
|---|---|---|---|---|---|
| `Mint{qty, holder}` | Supply | Config | M-of-N, not paused; `holder` eligible if `kyc_mint` | `minted_supply += qty` | `+qty` |
| `Burn{qty, holder}` | Supply | Config | anyone, even when paused; `holder` eligible if `kyc_redeem` | `minted_supply -= qty` | `-qty` |
| `Attest{reserve}` | Supply | Config | M-of-N | reserve, `attestation_epoch+1`, `attested_at = lower bound` | 0 |
| `SetCap{mint_cap}` | Supply | Config | M-of-N | `mint_cap` | 0 |
| `SetPaused{paused}` | Config | — | M-of-N | `paused` | 0 |
| `Rotate{operators, threshold}` | Config | — | current M-of-N **and** new M-of-N, even when paused | `operators`, `threshold` | 0 |
| `SetKyc{kyc_mint, kyc_redeem, kyc_stake, eligibility_policy}` | Config | — | M-of-N; policy must be 28 bytes | the three switches and `eligibility_policy` | 0 |

Every transition: exactly one token-bearing UTxO of its kind in and out, and
**none of the other kind** (a Supply transition may not spend or return the
Config and vice versa; 2.5b relaxes this for `LossBurn` only); the next datum
must **equal** the expected datum (the old one with only the permitted fields
changed, that kind's `epoch + 1`); the output holds exactly ADA + its thread
token at the spent UTxO's exact address. A Supply transition also needs the
genuine Config as a **reference input** (a missing, duplicated, planted,
misplaced or wrong-kind Config aborts the transaction) and a valid committee in
it. A redeemer used on the other kind's datum fails. `SetCap` is bounded by the
same 1,000,000,000 TSRA hard ceiling as genesis. The proposed genesis
`mint_cap` is 5,000,000 TSRA; that is a bootstrap parameter the committee can
later move with `SetCap`, not a validator limit. Minting is still bounded by the
lower of `attested_reserve` and `mint_cap` (`rules.mint_allowed`).

**Rotation.** `Rotate` replaces `operators` and `threshold` and nothing else.
The current committee must meet its threshold (authorisation) and so must
the new one (liveness: a rotation cannot hand the Config to keys nobody
controls). The datum must install exactly the committee named in the
redeemer. Rotation is allowed while paused, so a compromised key can be
replaced during an incident. Because the Supply reads the committee from the
Config, a rotation applies to the next Mint, Attest and SetCap at once.

Mint requires `minted_supply + qty <= min(attested_reserve, mint_cap)`, and a
finite validity upper bound `<= attested_at + 7 days` (`rules.fresh`).
Attest requires a finite range of at most 1 day whose lower bound is not before
the previous `attested_at` (`rules.window_ok`). Attesting a reserve *below*
`minted_supply` is allowed: it reports an undercollateralised reserve honestly
and blocks further minting.

**Datums are provisional.** The `ConfigState` and `SupplyState` fields above
(in particular the committee model, the attestation format and whether a
reserve asset is held on-chain) depend on counsel's answers on the issuance
structure and on DESIGN.md decision 4 (reserve asset and custodian). Expect the
datums, and so the script hash, to change before any bootstrap; nothing should
be deployed or pinned against this version.

Known gaps:
* ~~Committee rotation~~ — **closed in Phase 2.2** (`Rotate`, above).
* ~~Genesis validation at bootstrap~~ — **closed in Phase 2.2**: the NFT mint
  moved into `reserve.ak` (thread pattern), which removed the NFT-policy /
  reserve-hash circularity and lets the mint check the genesis output.
  `state_nft.ak` is retired.
* ~~Every TSRA mint or burn invalidates in-flight vault transactions~~ —
  **closed in Phase 2.5a** (Config / Supply split, above).
* Rotation has no time lock or cancellation window: the current and new
  committees can rotate in a single transaction. A delay would need a
  pending-rotation field in the (provisional) Config.
* Every burn spends the single Supply UTxO, so burns serialise (the queue
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
genuine Reserve Config (the one reference input carrying the reserve's
`config` token at the reserve address), so a reserve `Rotate` carries over.

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
`TSRA`), and the same policy carries the `config` and `supply` thread tokens.
A mint naming either is genesis (§1) and must be exactly one of each; any
other mint or burn of them is refused. A TSRA mint only requires that the
genuine Supply is spent in the same transaction; the `spend` handler enforces
the exact TSRA quantity and refuses any other token name under the policy.

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
Config** as a reference input (the one input holding the reserve's `config`
token at the reserve address; the Supply is never read), exactly as
`validators/eligibility.ak` does, so a reserve `Rotate` or `SetKyc` applies to
the vault immediately. **[D-6]**

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
  vest_short: Int,          -- reported yield not yet in the class S price (2-H)
  vest_long: Int,           -- the same for class L
  vest_from: Int,           -- vesting line: from (vest_from, vest_*) ...
  vest_until: Int,          -- ... to (vest_until, 0); all 0 at genesis
  long_weight_bps: Int,     -- 12_500 proposed; 10_000 <= w <= 15_000
  short_cooldown_ms: Int,   -- 7 days proposed; 7 d <= c <= 14 d
  long_lock_ms: Int,        -- 30 days proposed; 2c <= l <= 90 d (2-H)
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
long_assets + vest_short + vest_long` TSRA (exact-value check, as the
reserve does), so
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
| `Claim` | Ticket (State as **reference input**) | anyone; pays only `owner` | after `claim_after`: pay `owner` `v · loss_index_now / index_at_request` and the Ticket's ADA, burn the marker, burn the excess TSRA |
| `UnlockLong` | State + Position | **the owner** (2-H, §3.15) | after `unlock_at`: pay `owner` `redeem_value(shares, L)` and the Position's ADA; burn the marker |
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
| every action that needs the committee or `kyc_stake` | the Reserve Config as reference input | **stale reference only on a committee action**: since 2.5a the Config is spent by `Rotate`, `SetPaused` and `SetKyc`, not by TSRA mints and burns (those spend the Supply), so a vault tx built against an old Config fails only after a real change **[D-6]** |

Mitigations in 2.4: Claims and transfers never touch the State; Tickets
carry their own TSRA so the cooldown queue scales without the State;
committee actions are rare. Stake/unstake throughput is one State
transition per block (~20 s on Preprod) — acceptable for Preprod, and the
known upgrade path is batching through order UTxOs (like the redemption
queue), deferred until volume needs it. For the (now rare) stale Reserve Config
the builder retries against the latest UTxO; the alternative, caching the
committee and `kyc_stake` in the vault State with a permissionless `Sync`
redeemer, removes the dependency but opens a window where a rotation or a
`SetKyc` has not reached the vault yet.

### 3.10 Genesis

As `reserve.ak`: the `state` mint consumes the seed, mints exactly one
`state` and nothing else, spends no vault input, and creates exactly one
output at the vault address holding exactly ADA + the token (no TSRA), with
an inline `VaultState` of zero shares and assets, `loss_index == 1e12`,
`epoch == 0`, parameters within their hard limits, and `first_loss_addr` /
`treasury_addr` that are not the vault itself. Phase 2-H: nothing vesting
(`vest_* == 0`), and the output sits at the vault's enterprise address (no
stake credential) with no reference script (AUDIT.md F-6).

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

**Equivalent mutants** (mutation pass, SPEC.md §6 has the totals):
* *StakeShort `amount > 0`* — `deposit_ok` already refuses a zero or negative
  stake (below 10 TSRA on an empty class, zero shares minted otherwise).
* *StakeLong / RequestUnstake output count* — `other_output` already requires
  exactly one vault output besides the State.
* *RequestUnstake `shares > 0`* — zero or negative shares give a value ≤ 0,
  which fails the 2 TSRA minimum.
* *UnlockLong input count* — `sole_state` finds the one State and
  `expect [pos]` forces exactly one other vault input.
* *Spent input must be the State (`in_state == s0`)* — every branch fixes the
  number of vault inputs, so a second State-shaped input can never join the
  genuine State, and with one vault input `sole_state` has already proven it
  is the genuine State. Kept as defence in depth.
* *Claim: no other vault input (`ins == [own]`)* — two Tickets in one claim
  burn two markers while each demands exactly one burned, and any other vault
  input fails its own validator (a State only in UnlockLong, which needs a
  Position; a Position only beside the State; planted UTxOs carry no
  marker). Kept as defence in depth against double satisfaction.
* *Reserve lookup: several Reserve States accepted* (`[s]` → `[s, ..]`) —
  only one UTxO can ever hold the reserve's one-shot thread token, so at most
  one reference input matches (the same survivor as 2.3, §6).

### 3.14 Open items

1. **For 2.5 — loss-burn path on the reserve.** A vault-driven TSRA burn
   (ReportLoss, or a Claim's excess after a loss) has no holder signature,
   so with `kyc_redeem` on the reserve's `Burn` refuses it. 2.5 must add a
   committee-signed loss-burn path on the reserve that `kyc_redeem` does not
   gate.
2. ~~Before 2.6 — split the Reserve State?~~ — **done in Phase 2.5a** (§1):
   a rarely-changing *Config* UTxO (committee, switches, eligibility policy),
   read by the vault, the registry and the queue, and a hot *Supply* UTxO
   (minted supply, attested reserve). TSRA mints and burns no longer
   invalidate in-flight vault transactions (§3.9, D-6).
3. **For 2.5 — ReportLoss eats unvested yield first.** A loss must first be
   taken from `vest_short` / `vest_long` (yield the stakers have not yet
   received), and only the remainder from `short_assets` / `long_assets` and
   the loss index. Otherwise stakers who exit during the vest week keep yield
   that the loss should have cancelled (§3.15).
4. **Audit item — no on-chain cap on `ReportLoss` (D-13).** The committee
   can burn any amount of staked TSRA, bounded only by the notice window
   (§3a.4), the M-of-N threshold and rotation. It is the same trust the
   committee already has over `Mint` and `Attest`, and capping a real loss
   would leave TSRA unbacked, but it is the largest standing power over staker
   funds and must be listed for the external auditor and in the Preprod →
   mainnet gate (`NETWORK.md`).

### 3.15 Phase 2-H hardening (approved 2026-10-19)

**Yield vesting (H2.1, option a).** ReportYield no longer moves the price
at once: the net yield is split as in §3.5 (weights now use each class's
*whole* TSRA, booked + vesting) and added to `vest_short` / `vest_long`,
which vest linearly over `vest_period_ms` = 7 days, a hard constant.

* *Booking.* Every State transition first folds what has vested by the
  validity **lower bound** `lo` into `short_assets` / `long_assets`
  (`vault_state.fold`). The ledger guarantees `lo` has been reached; `hi` has
  not, so booking at `hi` would let a staker with a far-future upper bound
  vest the whole week at once. A fold restarts the line at the fold time, so
  the slope (and the end date) is unchanged.
* *Pricing.* Stakes price at `hi` (booked + vested by `hi`): a staker never
  buys below the price at the moment the transaction lands. Unstakes and
  unlocks price at `lo` (booked only, after the fold): an exit never gets
  more than that price. Picking the validity range can only cost the user.
* *Rounding.* `vested` is clamped to `[0, unvested]` and rounded down; the
  dust stays unvested in the pool. Folding early can only lower a later price
  by that dust, never raise it (`folding_early_never_raises_a_price`).
* *Roll-over.* ReportYield adds the new yield to what is still vesting and
  restarts one 7-day line from `max(lo, vest_from)`; nothing is lost or
  counted twice (`vesting_report_conserves_every_unit`). Its window is at most
  1 day (`hi - lo <= max_attest_window`), so `lo` cannot be backdated to vest
  the yield early.
* *Known edge.* If every share of a class exits while yield is still
  vesting, that unvested yield passes to the next entrant of the class (as the
  rounding dust always has). Exiting forfeits unvested yield by design.
  **Superseded in 2.5 (§3a.7, D-19):** the unvested yield and dust of a class
  whose last share exits are paid to the first-loss reserve instead.

**Lock floor (H2.2).** `long_lock_ms >= 2 × short_cooldown_ms` in
`bounds_ok`, so genesis and SetBounds both enforce it (7-day cooldown: lock
at least 14 days; 14-day cooldown: at least 28).

**Owner authorisation and ADA (H2.3).** A Position keeps earning after
`unlock_at`, so only its owner may unlock it: a key owner signs; a script
owner has an input of its own script spent in the transaction (so its
validator decides). Claim stays permissionless — a Ticket earns nothing, so
an early claim costs its owner nothing. Both pay the owner the spent UTxO's
lovelace as well as the TSRA. A Position or Ticket owned by the vault
address itself is refused at creation (it could never be paid out).

**Output pinning (H1, AUDIT.md F-6).** The continuing State, and every new
Position and Ticket, sits at the spent State's exact address (stake
credential included) with no reference script, and the State never loses
lovelace: no vault redeemer pays ADA out of the State (Claim and UnlockLong
pay the Ticket's / Position's own ADA). The reserve State and eligibility
registry outputs follow the same rules; the reserve has no lovelace
exception either.

**Equivalent mutant** (Phase 2-H pass, §6):
* *`vested`: `t <= from` → `t < from`* — at `t == from` the formula gives
  0 anyway; it differs only when `vest_until == vest_from` with yield still
  vesting, which cannot happen (every ReportYield sets `vest_until =
  start + 7 days`, and genesis starts with nothing vesting).

## 3a. First-loss reserve and ReportLoss (Phase 2.5 — DESIGN CHECKPOINT, not implemented)

Status: **revision 6 — implemented in Phase 2.5b; the vault was split for size (§3a.15).** Revision 4 re-targeted the
design at the Config / Supply split (2.5a, PR #14) and was approved. Revision
5 records the three places where the implementation differs from the approved
text, each marked **[rev 5]** below: the escrow tracks the Tickets' CURRENT
value (a flaw in the approved `T == Σ value` rule), `LossBurn` may burn 0,
and `ReportLoss` needs something to write off. Everything below that says "Reserve State" now says
which of the two UTxOs it means. It completes §3.8 and closes the §3.14 items 1 (loss-burn path),
3 (unvested first) and the 3% cap deferred by D-5. Decisions continue the 2.4
numbering: **[D-8] … [D-19]**. Review outcome: D-9 to D-16, D-18 and D-19
approved as written; the 3% reading in D-10 confirmed (stop funding at 3% of
supply, overflow to the treasury); **D-11 and D-12 changed (Change 1,
`ticket_escrow`) and D-17 replaced (Change 2, `VaultClaimBurn`).**

### 3a.0 Base and what changes

* **[D-8] Base — resolved.** The design uses the Phase 2-H fields
  `vest_short`, `vest_long`, `vest_from`, `vest_until` and `vault_state.fold`
  (§3.15). PR #13 (`phase2-h-hardening`) is merged; this branch is rebased onto
  `origin/main` (bfd54f6).
* **Scripts touched** (every one moves its hash; nothing is deployed yet, and
  all pins/blueprints are rebuilt once at the end, as in 2.4):
  `reserve.ak` (two new Config fields, 5 redeemers; the Supply datum does not
  change), `eligibility.ak` (rehash only: it decodes the grown ConfigState), `stsra_vault.ak` (its
  ReportLoss / ReportYield / SetBounds / Claim-State checks live in `vault_ops.ak`, §3a.15) +
  `vault_state.ak` (new redeemer, datum changes, freeze reads, Claim becomes a
  State transition), new `first_loss.ak`. UI changes go in `docs/lovable-prompts/phase-2-5.md`,
  never in Lovable-owned files.
* **Price rule.** A class's TSRA-per-share, and `loss_index`, may fall **only**
  in `ReportLoss`. Every other redeemer keeps both non-decreasing (floor
  rounding in the protocol's favour already guarantees it; 3a.9 adds a test
  over every redeemer).

### 3a.1 The first-loss reserve: where it lives, funding, cap, draw

* **[D-9] Its own script UTxO, `validators/first_loss.ak`.** Not a reserve
  datum field: the Config and the Supply each hold exactly ADA + their thread
  token (§1), so neither can hold TSRA, and a burn needs the TSRA physically in the
  transaction. Same pattern as the vault: parameterised by `(seed, reserve:
  PolicyId)`, mints its own one-shot `state` thread token (genesis checked
  on-chain: one output, ADA + token only, `balance == 0`, `epoch == 0`),
  committee read live from the genuine reserve **Config** (reference input).

  ```
  FirstLossState { balance: Int, epoch: Int }
  ```

  The genuine UTxO holds exactly ADA + the thread token + `balance` TSRA (exact
  value check). Because it is a single token-marked UTxO, "balance" is
  provable by a reference input, which the plain `first_loss_addr` of 2.4
  could not offer (D-5).

  | Redeemer | Who | Effect |
  |---|---|---|
  | `Deposit{qty}` | anyone | `qty > 0` TSRA arrives; `balance += qty` |
  | `Draw{qty, deposit}` | committee M-of-N | `0 < qty <= balance`; `balance := balance - qty + deposit`; the same `qty` TSRA must be burned in this transaction (negative TSRA mint of the Reserve policy, ≥ `qty`) |

  There is **no other exit**: first-loss TSRA can only be burned against a
  loss, never paid to the treasury or an owner. Rotation/SetKyc on the reserve
  carry over (committee is read live).
* **[D-10] Funding and the 3% cap.** `ReportYield` pays
  `to_reserve = min(cut / 2, max(0, cap - balance))`, where
  `cap = 3% × minted_supply` (both from reference inputs: the genuine
  first-loss State and the genuine reserve **Supply**; `ReportYield` also
  references the Config for the committee, as in 2.4. Referencing the hot
  Supply means a TSRA mint or burn in the same block can invalidate an
  in-flight `ReportYield`; it is committee-driven and rare, and retried), and the rest of the
  half, `cut/2 - to_reserve`, goes to the treasury in addition to its half.
  `to_reserve > 0` requires the first-loss State to be **spent** with
  `Deposit{to_reserve}` (so the balance is updated, not donated beside it).
  `VaultState.first_loss_addr` is replaced by `first_loss: PolicyId`
  (immutable; the vault finds the genuine State by thread token, never by
  address). Genesis rejects a `first_loss` that is not a 28-byte id.
  **ASSUMED:** your brief says "the 3% cap from 2.4 option (a)", but I cannot
  find an "option (a)" in `SPEC.md`, `DESIGN.md` or any commit message; the
  only 2.4 text is D-5 ("3% of TSRA liabilities"). I took (a) to mean *stop
  funding at 3% and send the overflow to the treasury*. If (a) meant the
  overflow stays with the stakers, say so; only the overflow line changes.
  The cap limits **inflow from ReportYield only**: the sweeps (3a.6, 3a.7)
  deposit unconditionally. (Confirmed in review.)
* **How it is drawn.** Only inside `ReportLoss` (3a.2), via `Draw`.

### 3a.2 ReportLoss and the waterfall

* **[D-11] One committee input, a deterministic waterfall.** `ReportLoss{loss}`
  (committee M-of-N, `loss > 0`, finite validity window ≤ 1 day like Attest,
  `lo` the anchor). Everything else is recomputed on-chain from the datums, so
  the committee chooses only the amount, never the allocation:

  ```
  s1  = fold(s0, lo)                      -- book what has vested by lo
  U   = vest_short + vest_long
  1. u   = min(loss, U)                   -- unvested yield first
     u_S = u * vest_short / U (floor), u_L = u - u_S
  2. d   = min(loss - u, fl.balance)      -- then the first-loss reserve
  3. rem = loss - u - d
     A   = short_assets + long_assets     -- (post-fold), stakers' booked TSRA
     T   = ticket_escrow                  -- TSRA escrowed in open Tickets
     E   = A + T                          -- everyone still exposed
     rem' = min(rem, E)
     R_stakers = rem' * A / E (floor)     -- E = 0 => 0; then the stakers, by ASSETS
     R_S = R_stakers * short_assets / A (floor), R_L = R_stakers - R_S
     R_tickets = rem' - R_stakers         -- NOT burned now: see below
  4. loss_index' = max(min_loss_index, loss_index * (E - rem') / E)   (rem' > 0)
  residual = rem - rem'                   -- loss beyond everything; see below
  ```

  `fold` first because yield that has already vested by `lo` belongs to the
  stakers; draining the raw `vest_*` fields would burn staker money before the
  buffer. Unvested yield is drained pro rata between the two classes' vest
  fields (it is un-booked in both). Staker loss is by assets, not weighted
  (§3.8: the weighting is a yield rule). `R_L <= long_assets` holds (it is
  `ceil(R_stakers·A_L/A)`).
* **[D-11, revised] Tickets are charged once.** Open Tickets are exposed to a
  loss during their cooldown (§3.6), but their TSRA sits in Ticket UTxOs, not in
  the State. So the State tracks it: `VaultState.ticket_escrow` (T). The
  remaining loss is spread over `A + T` pro rata, so a Ticket bears exactly the
  same rate as a staker, and the total charged equals the loss, not more.
  The first revision cut the stakers by the whole remainder *and* the Tickets
  by `R/A`, which charged more than the loss.
  * `RequestUnstake`: `T += v` (the Ticket's `value`), checked exactly.
  * **[rev 5] `ReportLoss`: `T -= r_tickets`.** The Tickets' share of the
    loss leaves the escrow the moment it is written off.
  * **[rev 5] `Claim`: `T = max(0, T - payout)`**, where `payout` is what
    the Ticket is paid at the State's current index (the approved text said
    `T -= t.value`, payout + excess, and `T == Σ value`). **Why it changed:**
    with `T == Σ value` a Ticket that lives through two losses is charged
    the second loss on its ORIGINAL value, although the first loss already took
    its excess out of what it is worth. Its allocation is `v·f2`, but the
    Claim burns only `v·(1−f1)·f2`; the difference `v·f1·f2` is written off
    from `attested_reserve` and burned by nobody (a 50% / 50% pair of losses
    leaves a quarter of the Ticket unabsorbed), and the stakers are charged
    too little. Tracking the CURRENT value fixes both: `T` is what the open
    Tickets would be paid now, so the `A + T` split, `r_tickets` and the
    Claims' excess all describe the same money. The clamp at 0 absorbs rounding
    dust (the floors can leave `T` a unit or two short of the last payout, and
    the Ticket must stay claimable). **This makes `Claim` a State transition** (it
    spends the State; it used to read it by reference). Consequence: Claims
    serialise with stakes and unstakes on the State, and the §3.9 "Claims never
    touch the State" mitigation no longer holds. Accepted in review; the
    batching path (§3.9) is the upgrade if volume needs it. `Claim` still
    spends exactly one Ticket (double satisfaction, §3.13).
  * **[rev 5] Invariant: `T >= 0` and `T` ≈ Σ current value over live
    Tickets** (exact until the first loss; afterwards within the floors'
    dust, which only ever errs towards charging the stakers a unit more).
    Tickets are created only by `RequestUnstake` and destroyed only by
    `Claim`, each marker-gated; genesis starts at 0.
* **What moves, and who burns what.**
  * At `ReportLoss`: burned = `u + d + R_stakers`, exactly (through `LossBurn`,
    3a.3). State TSRA falls by `u + R_stakers` (+ sweeps, 3a.6), first-loss
    falls by `d`, `minted_supply` falls by `u + d + R_stakers`.
  * At each later `Claim`: the Ticket's `excess = t.value - payout` is burned
    (`VaultClaimBurn`, 3a.5). Summed over the Tickets, that is the
    `R_tickets` share, applied by `loss_index'`.
  * **Conservation (the check you asked for).** Over time, total burned =
    `u + d + R_stakers + Σ excess_i`, and `Σ excess_i ≈ R_tickets`. Exactly:
    the stakers' share is floored, so the Tickets' is the larger remainder;
    each Ticket's `payout` is floored, so each `excess_i` rounds *up* by < 1
    unit, and `loss_index'` is floored, which adds ≤ 1 unit per Ticket for a
    Ticket of at most 1,000,000 TSRA (`value ≤ 1e12` units against an index
    near 1e12). Hence, once all `n` Tickets open at the loss have claimed,
    `loss_absorbed <= burned_total <= loss_absorbed + 2n` where
    `loss_absorbed = loss - residual` (**[rev 5]** the lower bound is 0, not -1: the Tickets' written-off share
    is the stakers' floor's remainder, rounded up, and every Claim's excess is
    at least its exact share, so the burn can only meet or pass the write-off);
    with no rounding (round numbers) it is exactly `loss_absorbed`. The test
    pins both the exact case and the bound (3a.9). Overshoot is Ticket-holder
    dust burned in the protocol's favour.
  * State conservation at ReportLoss:
    `State_before = State_after + u + R_stakers + sweeps`.
* **Residual.** If `loss` exceeds unvested + first-loss + all staker assets +
  all escrowed Ticket value, the vault absorbs what it can and the rest is
  **not** an on-chain event: the committee must `Attest` a reserve below
  `minted_supply`, which already blocks minting (§1). ReportLoss does not fail
  on a residual.
* **[D-12] Index floor.** `min_loss_index = 1_000_000` (1e-6 of par): the
  index never reaches 0, so `Claim` never divides by a zero
  `index_at_request`. After >99.9999% cumulative loss later losses no longer
  reduce new Tickets; at that point the vault should be retired, not patched.
* **Authority/atomicity.** The transaction must spend exactly: the vault State,
  the genuine reserve **Supply and Config** (both under `LossBurn`, 3a.3) and,
  if `d > 0` or there is a sweep, the genuine first-loss State (`Draw`). The
  vault checks all four transitions' datums and the exact burn quantity
  itself, so a missing companion input cannot pass.
* **[D-13] No on-chain cap on `loss`.** The committee can burn any amount of
  staked TSRA, the same trust it already has to mint (§1) and to attest the
  reserve. Capping a *real* loss would leave TSRA unbacked. The mitigations
  are the notice window (3a.4), the M-of-N threshold, rotation, and that
  everything is public before it lands. Listed as an open risk, not solved.

### 3a.3 Reserve changes (`reserve.ak`)

* **ConfigState gains two fields** (the SupplyState does not change):
  `loss_pending_until: Int` (POSIX ms; `0` = none; genesis must be `0`) and
  `vault_policy: ByteArray` (the sTSRA vault's script hash; empty = unset;
  genesis must be empty, otherwise 28 bytes). They go in the Config, not the
  Supply, because the vault reads them on every exit and stake and must not be
  invalidated by supply traffic (§1). Hard constants in `rules.ak`:
  `max_loss_pending_ms = 7 days`, `loss_reopen_gap_ms = 7 days`.
* **[D-17a] `vault_policy` is a Reserve Config field, not a script
  parameter.** A parameter is impossible: the vault is parameterised by the
  reserve's policy, so the reserve cannot also be parameterised by the vault's
  hash (circular). `SetVault{vault_policy}` (committee M-of-N, 28 bytes) sets
  or repoints it, exactly like `eligibility_policy` (`SetKyc`, §1a): a vault
  upgrade then needs no new reserve. Repointing is safe because
  `VaultClaimBurn` (3a.5) can only burn TSRA that the same transaction's own
  inputs supply, so a wrong policy can burn nothing of anyone else's. It is
  *not* a trust anchor for funds, only for which vault's Tickets may use the
  ungated burn. (Recommended over "set once": a set-once field would force a
  new reserve, and so a new TSRA policy, for every vault redeploy.)
* **[D-14] Redeemers** (committee M-of-N except `VaultClaimBurn`; each: exact
  next datum with only the named fields changed, that kind's `epoch + 1`,
  thread-token UTxO value unchanged and pinned (F-6), allowed while `paused`,
  mint nothing unless stated). **Which UTxO each one spends is part of the
  rule** (the 2.5a rule "one kind per transition" holds for all of them
  except `LossBurn`):

  | Redeemer | Spends | Reads (reference) | Preconditions | Next datum |
  |---|---|---|---|---|
  | `OpenLoss{until}` | **Config** | — | finite window ≤ 1 day; `lo >= loss_pending_until + loss_reopen_gap_ms`; `hi < until <= lo + max_loss_pending_ms` | Config: `loss_pending_until = until` |
  | `CancelLoss` | **Config** | — | finite window; `loss_pending_until > lo` (an active freeze) | Config: `loss_pending_until = lo` |
  | `SetVault{vault_policy}` | **Config** | — | 28-byte policy id | Config: `vault_policy` |
  | `LossBurn{qty, written_off}` | **Supply and Config** (the only redeemer allowed to spend both) | — | finite window ≤ 1 day; `hi < loss_pending_until` (freeze active for the whole validity, read from the spent Config); **[rev 5]** `0 <= qty <= minted_supply`; `written_off >= qty`; **`written_off > 0`**; TSRA mint delta == `-qty` | Supply: `minted_supply -= qty`, `attested_reserve = max(0, attested_reserve - written_off)`; Config: `loss_pending_until = lo` |
  | `VaultClaimBurn{qty}` | **Supply only** | Config (for `vault_policy` only) | **no committee, no KYC, no pause check**; see 3a.5 for the full conditions | Supply: `minted_supply -= qty`; `attested_reserve` **unchanged**. Config untouched (so the freeze is untouched) |

  **How `LossBurn` stays sound across two inputs.** A spend validator runs once
  per script input, each with its own redeemer. Both executions run the same
  `loss_burn` check, which requires exactly one genuine Supply **and** exactly
  one genuine Config in the inputs and both returned (exact datums, exact
  values, pinned), the committee from the **spent** Config, and the burn.
  Every other redeemer keeps the 2.5a rule that no input of the other kind is
  spent, so a transaction that gives the Supply `LossBurn` and the Config any
  other redeemer (or the reverse) fails on the Config's (or Supply's) own
  execution, and a transaction cannot use `LossBurn` on one kind while the
  other kind is absent. `LossBurn` is the *only* path on which the Supply
  moves with the Config spent, and the only one that moves
  `loss_pending_until` backwards by itself (to `lo`); it never touches the
  committee, the switches or `vault_policy`. Epochs: `LossBurn` bumps both
  counters; `VaultClaimBurn` only the Supply's.

  **[rev 5] `qty == 0` is allowed.** A loss that only the open Tickets absorb
  (no unvested yield, an empty reserve, no staked assets) burns nothing now, but
  its backing is still written off; refusing `qty == 0` would make such a loss
  unreportable. `written_off > 0` keeps a `LossBurn` from being a free
  freeze-closer (`CancelLoss` does that).
  `LossBurn` is **not** gated by `kyc_redeem` (no `holder`, no eligibility
  check), works while paused, and lowers `attested_reserve` by
  `written_off`, **not** by `qty`. **[D-14, revised]** `qty` is what is burned
  now (`u + d + R_stakers`); `written_off` is the whole lost backing that
  `ReportLoss` absorbed, `u + d + R_stakers + R_tickets = loss − residual`. The
  Tickets' share `R_tickets` is not burned until each Ticket claims, but the
  backing behind it is already gone, so it must leave `attested_reserve` now;
  otherwise the committee could mint `R_tickets` against backing that no longer
  exists until the next `Attest`. The reserve checks only `written_off >= qty`
  and the clamp at 0 (it cannot see the waterfall); the **vault's `ReportLoss`
  checks both numbers against its own waterfall** (`qty == u + d + R_stakers`,
  `written_off == loss − residual`, read from the Supply's spent input and
  returned output, and the Config's from its own pair), so a mismatched pair
  cannot pass. The committee
  re-attests the exact figure afterwards.
  `VaultClaimBurn` lowers `minted_supply` only: the Ticket excess it burns was
  already written off here.
  **Invariant:** `attested_reserve − minted_supply` after `ReportLoss` and every
  open Ticket's `Claim` equals its value before the loss, within
  `[−1, +2n]` (`n` Tickets claimed): the supply falls by `burned_total` and the
  attestation by `loss_absorbed`, and 3a.2 bounds `burned_total −
  loss_absorbed`. Unless `attested_reserve` was clamped at 0.
  The ordinary `Burn` is unchanged (still holder-signed, still `kyc_redeem`
  gated). `Mint` is unchanged and **not** frozen by a pending loss.

### 3a.4 The "loss pending" freeze

* **[D-15] Rule.** Read from the genuine reserve **Config** (reference input;
  `genuine_config` returns the two new fields). Only committee actions and
  `LossBurn` ever spend the Config, so supply traffic (Mint, Burn,
  `VaultClaimBurn`) can no longer invalidate an in-flight exit or stake that
  references it. The freeze is a pure function of time:

  ```
  frozen(rs, lo) = rs.loss_pending_until > lo
  ```

  `Claim`, `UnlockLong`, `RequestUnstake` (and, by [D-16], `StakeShort` /
  `StakeLong`) require `not frozen(rs, lo)`: the transaction's **lower bound**
  must be at or after `loss_pending_until`. `ReportLoss` requires the
  opposite for its **upper** bound (`hi < until`), so no transaction can be
  valid both as a user exit and as the loss report, and a user transaction
  cannot be backdated into the window. A missing, duplicated or planted
  Config fails closed (the exit is refused), as `genuine_config` already does.
  `ReportLoss` does not reference the Config for this: it **spends** it
  (`LossBurn`) and reads `loss_pending_until` from the spent input.
* **Time limit (cannot freeze forever).**
  1. One freeze lasts at most `max_loss_pending_ms` (7 days) from `lo` of its
     opening transaction, enforced on-chain; there is **no extension**.
  2. After a freeze ends (expiry, `CancelLoss`, or `LossBurn`, all of which
     leave `loss_pending_until <= the closing time`), a new one needs
     `lo >= loss_pending_until + 7 days`, so users always get at least a
     7-day exit window; worst-case duty cycle is 7 of every 14 days.
  3. Expiry needs no transaction: once `lo >= loss_pending_until` everything
     is open, even if the committee is unreachable.
  4. `Rotate` works throughout, so a committee that abuses the freeze can be
     replaced.
* **Consequence to accept.** If the assessment overruns 7 days the freeze
  lapses with no loss recorded and the committee must wait out the gap before
  reporting (a `ReportLoss` needs an active freeze). That is deliberate: no
  loss lands without public notice and a full window.
* **[D-16] Stakes are frozen too** (recommended; your list named three). A
  new staker prices at the pre-loss price and would take the loss on money
  they put in after it was known. Say if you want stakes left open.
* **Limits that stay.** (a) A same-block race: a user transaction ordered
  before `OpenLoss` in the opening block still passes. (b) sTSRA is a bearer
  token; the freeze cannot stop a secondary-market sale at the pre-loss price,
  only the vault exits. Both are inherent to the ledger and are open risks.

### 3a.5 Ticket excess: where it goes

* **[D-17, replaced] Claim excess is burned, not routed to first-loss.**
  `excess = t.value - payout` (§3.6) is TSRA whose backing was already written
  off at `ReportLoss`; sending it to first-loss would refill the reserve with
  unbacked TSRA. (My first revision proposed that; withdrawn.) It is burned
  through a new reserve redeemer, `VaultClaimBurn{qty}`, which needs **no
  committee and no KYC**, so a Claim stays permissionless and a ticket holder
  never depends on the committee to be paid.
* **Why this is safe to leave ungated.** The reserve does not trust the
  caller's `qty`; it recomputes the excess from the Ticket itself. Valid only
  if **all** hold:
  1. `vault_policy` is set (28 bytes), read from the genuine Config as a
     **reference input** (`genuine_config`; missing or planted aborts). This is
     the only thing `VaultClaimBurn` reads from the Config.
  2. The transaction **spends exactly one genuine Ticket**: an input at
     `Script(vault_policy)` carrying exactly one `position` marker of that
     policy, with an inline `TicketDatum(t)`; and the redeemer for that input,
     read from `tx.redeemers`, is `Claim` (the vault's own validator already
     accepts nothing else for a Ticket, so this is defence in depth; the
     `VaultRedeemer` type moves to `lib/` so the reserve can name `Claim`).
  3. The transaction also spends exactly one **genuine vault State** (the
     input at `Script(vault_policy)` holding the one `state` thread token of
     that policy, with a `StateDatum`). Claim spends it since `ticket_escrow`
     (3a.2), so its `loss_index` is read from the spent input, not a
     reference.
  4. `qty == t.value - ticket_payout(t.value, s.loss_index, t.index_at_request)`
     **exactly**, and `qty > 0`. `ticket_payout` is one shared function in
     `lib/tessera/vault_state.ak` (floor, capped at `value`), used by both the
     vault's `claim` and the reserve, so the two cannot disagree.
  5. The TSRA mint delta is exactly `-qty` (and nothing else is minted under
     the policy), and the genuine reserve **Supply** is spent once and returned
     with `minted_supply - qty`, `epoch + 1`, every other field unchanged
     (`attested_reserve` too: the backing was written off in full at
     `ReportLoss`, via `LossBurn`'s `written_off`). **The Config is not
     spent** (the 2.5a rule), so a Claim never touches `loss_pending_until`.
  Not checked, on purpose: committee signature, `paused`, `kyc_redeem`, the
  freeze (a frozen vault already refuses the Claim itself, and it reads the
  same Config by reference).
  A planted or foreign Ticket fails (2); a planted State (no thread token)
  fails (3); a different `qty` fails (4). Because `qty` is pinned to a real
  Ticket's excess, `VaultClaimBurn` cannot be used to burn arbitrary TSRA past
  `kyc_redeem`: the only quantity it will ever burn is a Ticket's loss share.
* **Vault side.** `Claim` now requires the burn to be exactly the excess
  (`mint delta == -excess`, was `<=`; with `excess == 0` the delta must be 0),
  and the genuine reserve **Supply** to be spent in the same transaction when
  `excess > 0`. Loss-hit Claims therefore also serialise on the Supply;
  no-loss Claims need neither the Supply as an input nor a burn. In **every**
  Claim the freeze check reads the genuine **Config by reference** (a Claim
  never spends the Config, so the reference is always available and is the one
  the reserve's `VaultClaimBurn` reads too).
* `ReportLoss` itself burns through `LossBurn` (committee-signed): unvested
  yield + first-loss draw + `R_stakers`. The Tickets' share is burned later,
  Ticket by Ticket, here.

### 3a.6 A class whose assets reach 0 (or near 0) with shares outstanding

The risk: `mint_shares` divides by `total_assets`; at 0 assets and live shares
a stake aborts, and near 0 it mints astronomically many shares (a Cardano
token quantity is an int64, so repeated wipes overflow it).

* **[D-18] Class generations.** `VaultState` gains `short_gen`, `long_gen`
  (0 at genesis); `Position` gains `gen`. The sTSRA asset name is `"sTSRA"`
  for generation 0 and `"sTSRA" ++ <gen as big-endian bytes>` after. A class
  is **dead** after a ReportLoss when `shares > 0` and
  `(A_c - R_c) * 1000 < shares_c` (price below 0.001 TSRA per share, which
  includes exactly 0). A dead class is reset in the same transaction:
  `assets' = 0`, `shares' = 0`, `gen' = gen + 1`; its remaining `A_c - R_c`
  (< 0.1% of the class) is **swept to first-loss** via `Draw{.., deposit}`
  rather than burned, so the burn stays exactly `u + d + R_stakers`.
  * Short class: the old-generation sTSRA stays in wallets as a worthless
    token (cannot be unstaked: the State no longer recognises its name).
  * Long class: old-generation Positions can still be spent with
    `UnlockLong`, which pays **0 TSRA**, returns the lovelace to the owner and
    burns the marker (so lovelace is not stranded); `redeem_value` uses the
    live generation only.
  * Both classes share the rate `r`, so they die together except for rounding.
* **Invariant on every transition (division-by-zero guard):**
  `shares_c == 0 <=> assets_c == 0 && vest_c == 0`, and when `shares_c > 0`,
  `assets_c * 1000 >= shares_c` (price floor). This makes `mint_shares`
  total: the `total_shares == 0` branch is the only one with zero assets.
* **Restart.** The first stake into an empty class is the existing
  `min_initial_deposit` (10 TSRA) 1:1 mint, in the new generation. Nobody
  from a dead generation shares in it.
* **Rejected alternative:** a 1-unit asset floor (no generations) leaves old
  shares owning dust and forces new stakers to be minted ~`d × shares` shares;
  it overflows after repeated wipes.

### 3a.7 Unvested yield when a class fully exits (2-H edge)

* **[D-19] Route it to first-loss.** When a `RequestUnstake` or `UnlockLong`
  takes a class's last share (`shares' = 0`), the class's remaining
  `vest_c` (and any rounding dust in `assets_c`; `redeem_value(shares >=
  total)` already returns all booked assets) must leave the State in the same
  transaction as a `Deposit` to the first-loss State, and the datum shows
  `vest_c = 0`. Without this, yield vests into a class with no shares and
  the next first staker captures it (a windfall, and an exploit: wait until
  yield accumulates, then be the sole staker). First-loss is the only sink
  that is neither a staker nor the committee. Only the *last* exit pays the
  extra input; ordinary exits are unchanged. `ReportYield` into a class with
  `shares == 0` already allocates it nothing (its weight is 0) and stays
  refused for an empty vault.

### 3a.8 Summary of interface changes

| Item | Change |
|---|---|
| `ConfigState` | `+ loss_pending_until`, `+ vault_policy` (`SupplyState` unchanged) |
| `reserve.ak` | `+ OpenLoss, CancelLoss, SetVault` (Config), `+ VaultClaimBurn` (Supply, Config by reference), `+ LossBurn` (Supply **and** Config); genesis Config `loss_pending_until == 0`, `vault_policy` empty |
| `reserve_ref.ak` | `genuine_config` returns the grown ConfigState; one reader for the vault, `VaultClaimBurn` and the registry |
| `eligibility.ak` | rehash only (decodes the grown `ConfigDatum`; reads the committee as before) |
| `first_loss.ak` | new: thread token, `Deposit`, `Draw` |
| `VaultState` | `first_loss_addr -> first_loss: PolicyId`; `+ short_gen, long_gen`; `+ ticket_escrow` |
| `Position` | `+ gen` |
| `VaultRedeemer` | `+ ReportLoss{loss}`; the type moves to `lib/` so the reserve can name `Claim` |
| `RequestUnstake` | `ticket_escrow += v` |
| `ReportLoss` | **[rev 5]** `ticket_escrow -= r_tickets` |
| `Claim` | now spends the State (**[rev 5]** `ticket_escrow = max(0, ticket_escrow - payout)`); burns exactly the excess; reads the Config by reference (freeze); with `excess > 0` also spends the reserve Supply (`VaultClaimBurn`) |
| exits/stakes | read the reserve Config by reference (freeze); last-share exits also spend the first-loss State |
| `ReportLoss` | spends vault State + reserve Supply + reserve Config (`LossBurn`) + first-loss State when `d > 0` or a sweep |
| `rules.ak` / `vault_state.ak` | `max_loss_pending_ms`, `loss_reopen_gap_ms`, `min_loss_index`, `dead_price_den = 1000`, `first_loss_cap_bps = 300`, `split_loss`, `class_dead`, `sweep`, shared `ticket_payout` helpers |

### 3a.9 Test list

*Reserve, which UTxO (the 2.5a cross-kind tests, extended):* `OpenLoss`,
`CancelLoss`, `SetVault` spend the Config and **cannot also spend the
Supply**; `VaultClaimBurn` spends the Supply and **cannot also spend the
Config**; `LossBurn` with only the Supply, or only the Config, rejected; with
both spent, the Supply given `LossBurn` and the Config given `SetPaused` (or
`OpenLoss`, `Rotate`, any other) rejected, and the reverse; `Mint`, `Burn`,
`Attest`, `SetCap` still cannot spend the Config, and `Rotate`, `SetPaused`,
`SetKyc` still cannot spend the Supply; `LossBurn` changes no Config field but
`loss_pending_until` and `epoch` (committee, switches, policies each pinned),
and no Supply field but `minted_supply`, `attested_reserve` and `epoch`; both
epochs bump; a planted Config or planted Supply beside the genuine one rejected
even when the planted one carries the real committee; a `LossBurn` committee
taken from a *referenced* (not spent) Config rejected; `VaultClaimBurn` without
a Config reference, with a planted one, or with `vault_policy` unset rejected;
Config reference not spent by a Claim; thread tokens still move only at
genesis (the 2.5a tests stay green unchanged).

*Reserve:* `OpenLoss` — needs committee; `until` beyond 7 days rejected; `until
<= hi` rejected; reopening inside the 7-day gap rejected; opening while a
freeze is active rejected; unbounded or >1-day window rejected; other fields
change rejected; epoch not bumped rejected; works while paused. `CancelLoss`
— needs committee; with no active freeze rejected. `LossBurn` — needs
committee; **not gated by `kyc_redeem`** (switch on, ineligible, accepted);
rejected without an active freeze; rejected if `hi >= until`; mint delta ≠
`-qty` rejected; `qty <= 0` / `> supply` rejected; `written_off < qty`
rejected; lowers `attested_reserve` by `written_off` (not `qty`; clamped at 0);
closes the freeze to `lo`; plain `Burn` still gated. Genesis
`loss_pending_until != 0` or non-empty `vault_policy` rejected. Rotation
carries to the new redeemers. `SetVault` — needs committee; not 28 bytes
rejected; changes nothing else.

*VaultClaimBurn:* a genuine Ticket + genuine vault State + `qty == excess`
accepted; **no Ticket in the tx → rejected**; **`qty` ≠ excess (one above, one
below, zero) → rejected**; **a foreign Ticket** (marker of another policy, or at
another script) **→ rejected**; **a planted Ticket** (right address and datum,
no marker) **→ rejected**; a Ticket whose redeemer is not `Claim` rejected; a
planted vault State (no thread token) or a State at another address rejected;
two Tickets rejected; `vault_policy` unset rejected; mint delta ≠ `-qty`
rejected; **works while paused**; **works with `kyc_redeem` on and no
eligibility token**; needs no signature; `attested_reserve` and the freeze
field unchanged (changing either rejected); `minted_supply` falls by exactly
`qty`; epoch bumped; the burn cannot exceed the Ticket's real excess even when
the caller holds more TSRA (bypass attempt: burn 1 extra unit → rejected).

*first_loss:* genesis good/bad (balance, epoch, foreign tokens, two outputs,
seed); `Deposit` raises balance by exactly the TSRA arriving; short deposit
rejected; `Draw` needs committee, rejected above `balance`, rejected unless
burned, `deposit` accounted; planted State (no token) rejected; foreign token
in State rejected; no redeemer pays the TSRA to an address.

*ReportLoss:* committee required (follows a reserve `Rotate`); table-driven
waterfall (loss < unvested; = unvested; unvested + part of reserve; reserve
exactly exhausted; into stakers; beyond everything → residual); **order
violations** (touching stakers while reserve has TSRA, touching reserve while
unvested remains) each rejected; `fold` at `lo` (vested yield is not drained);
pro-rata split over `A + T` with rounding (`R_S + R_L == R_stakers`,
`R_L <= A_L`); a loss with `T = 0` equals the old formula; a loss with large
`T` charges Tickets and stakers the same rate (**no double charge**: stakers
alone are not cut by the whole remainder); `A = 0` with `T > 0` (Tickets alone
absorb); `E = 0` (nothing exposed, residual only); `loss_index'` formula,
floor at `min_loss_index`; burn quantity exactly `u + d + R_stakers`;
`written_off` exactly `loss − residual` (a `written_off` of `qty` only, i.e.
omitting `R_tickets`, rejected; one unit more or less rejected; `qty` and
`written_off` swapped rejected); **invariant: `attested_reserve − minted_supply`
is unchanged by ReportLoss plus every open Ticket's Claim, within `[−1, +2n]`**
(table: round numbers exact; awkward numbers; `T = 0`; `A = 0`; clamp case
`attested_reserve < written_off`); the committee cannot mint `R_tickets` after
`ReportLoss` (mint at the old headroom rejected); State
value, first-loss balance and `minted_supply` conservation; requires the
reserve Supply **and** Config and (when needed) the first-loss State to be
spent; **no freeze → rejected**; `hi >= until` rejected; Supply or Config not
genuine rejected; shares
unchanged except dead classes; `loss <= 0` rejected; changing any bound
rejected; **a price can fall only via ReportLoss** (property test: for every
other redeemer on a table of States, per-share price and `loss_index` do not
fall).

*Freeze:* `Claim`, `UnlockLong`, `RequestUnstake`, `StakeShort`, `StakeLong`
each rejected with `until > lo`, accepted with `lo == until` and after; a
missing or planted Config rejected (a Supply in its place rejected); a Mint or
Burn between the user's build and submit does not invalidate the exit (the
exit references the Config only); a freeze that **lapses** unfreezes
everything with no committee action; a tx with `lo < until <= hi` is rejected
as an exit and as a ReportLoss.

*ticket_escrow:* `RequestUnstake` adds exactly `v` (one more or less
rejected); **[rev 5]** `Claim` subtracts exactly `payout` (not `t.value`) and
clamps at 0; `ReportLoss` subtracts exactly `r_tickets`; a second loss sees
what the Tickets are now worth (burned total == written off over two losses);
`Claim` spends
the State and no other vault UTxO but its Ticket; `ticket_escrow` never goes
negative; a State with `ticket_escrow` out of step with the Ticket rejected;
genesis `ticket_escrow != 0` rejected; planted Ticket still unclaimable.

*Claim excess / conservation:* `payout + excess == v`; Claim burns **exactly**
the excess (one more, one less rejected; `excess == 0` needs mint delta 0 and
no Supply input); with `excess > 0` the Supply must be spent (`VaultClaimBurn`); the
index floor never divides by zero; Claim after a drop pays `v·idx/idx_req`.
**Conservation, end to end:** simulate a ReportLoss then every open Ticket's
Claim over a table of states (round numbers: burned total == `loss`
**exactly**; awkward numbers: `loss_absorbed - 1 <= burned <= loss_absorbed +
2n`; loss beyond everything: burned == everything exposed, residual
reported); the same table with `T = 0` and `A = 0`; and a Ticket requested
*after* the loss is not charged (its `index_at_request` is the new index).

*Dead class:* wipe to exactly 0, to 0.0009 price (dead) and 0.001 price (alive);
generation bump; sweep goes to first-loss, not burned; old-gen sTSRA cannot be
unstaked; old-gen Position unlocks for 0 and returns lovelace; first stake
after a wipe is `min_initial_deposit`, 1:1, in the new generation; no
transition leaves `shares > 0` with `assets == 0`; `mint_shares` never sees
zero assets with live shares (property over all redeemers).

*Last exit:* unvested + dust deposited to first-loss on the last share; without
the deposit rejected; non-last exit unchanged; the next staker gets no
windfall; `ReportYield` into the emptied class allocates it nothing.

*Funding:* `to_reserve` capped at 3% of `minted_supply` minus balance; overflow
to treasury; conservation `to_reserve + to_treasury + net == gross`;
`to_reserve > 0` requires the first-loss State spent with a matching
`Deposit`; planted first-loss State, Supply or Config rejected.

### 3a.10 Mutation plan

Same method as §6 (delete or weaken each guard in turn, re-run `aiken check`,
a survivor is either an equivalent mutant, listed with the reason, or a test
gap, fixed). Run in a scratchpad copy (Aiken rewrites tracked `packages.toml`),
then re-run every Phase 2.2–2.4 and 2-H mutant against the changed scripts.
Expected guard groups, about 140 mutants:

| Group | Mutants |
|---|---|
| Waterfall | each of the three steps skipped or reordered; `min` → `max`; `fold` dropped; pro-rata remainder rule; `R_L` formula; unvested drained unevenly |
| Index / escrow | floor removed; formula uses `A` instead of `A + T`, or `rem` instead of `rem'`; applied only to one class; not applied at all; `ticket_escrow` not updated on `RequestUnstake` / `Claim`; Claim subtracts `payout` not `value`; stakers charged the whole remainder (double charge) |
| Burn/conservation | burn ≠ `u + d + R_stakers`; `written_off` ≠ `loss − residual` (omits `R_tickets`, or equals `qty`); `attested_reserve` lowered by `qty` instead of `written_off`; clamp at 0 dropped; `written_off >= qty` dropped; sweep burned instead of deposited; State value unchecked; `minted_supply` / `attested_reserve` not lowered |
| VaultClaimBurn | Ticket not required; marker unchecked; address unchecked; redeemer unchecked; State thread token unchecked; `qty` not pinned to the excess (`==` → `<=`, `>=`); `ticket_payout` cap dropped; `attested_reserve` lowered; committee / KYC / pause wrongly required; two Tickets accepted; `vault_policy` unset accepted; Claim burn `==` → `<=` |
| Freeze | `>` ↔ `>=`; `lo` ↔ `hi`; each of the five actions unfrozen in turn; fail-open on missing Config; freeze read from the Supply or from a spent Config in an exit; 7-day constants ×10; gap dropped; extension allowed; `OpenLoss` window unchecked |
| Split (which UTxO) | `LossBurn` accepted with only the Supply, or only the Config; the other input's redeemer unchecked; committee read from a reference Config instead of the spent one; `LossBurn` allowed to change a Config field other than `loss_pending_until`/`epoch` (committee, switches, `vault_policy` each); Config epoch not bumped; `OpenLoss`/`CancelLoss`/`SetVault` allowed to spend the Supply; `VaultClaimBurn` allowed to spend the Config, or accepted without a Config reference; `vault_policy` read from a planted Config; the 2.5a one-kind rule relaxed for any other redeemer |
| Reserve redeemers | committee dropped; `kyc_redeem` wrongly applied; pause check added; next datum unchecked; epoch not bumped |
| first_loss | thread token ignored; draw above balance; draw unburned; deposit unmatched; committee dropped |
| Dead class | threshold off by one; generation not bumped; sweep omitted; invariant dropped; `mint_shares` zero branch |
| Funding | cap removed; overflow lost; first-loss State not required to be spent |
| Last exit | vest not swept; dust not swept; sweep required on non-last exit |

Expected equivalents (to be confirmed, not asserted): redundant input-count
guards on redeemers that already fix the number of vault inputs, as in §3.13.

### 3a.11 Open risks

1. The committee can burn any amount of staked TSRA ([D-13]).
2. Same-block front-running at the opening of a freeze; secondary-market sales
   of sTSRA during a freeze.
3. `Claim` is now a State transition (`ticket_escrow`), so it contends with
   stakes and unstakes; loss-hit Claims also contend on the reserve Supply (not the Config), and
   last-share exits on the first-loss State. `ReportYield` references the hot
   Supply for the 3% cap (3a.1), so a same-block mint or burn can invalidate it.
4. Tickets and stakers bear the same rate, but the Ticket burn is rounded up
   per Ticket (< 2 units each, 3a.2): a few units of Ticket-holder dust, in the
   protocol's favour.
5. Every exit/stake reads the reserve **Config** for the freeze. After the
   split (2.5a, 3a.13) only committee actions and `LossBurn` spend it, so
   supply traffic cannot invalidate or grief an exit. `LossBurn` itself
   invalidates in-flight exits once (they are frozen anyway). The Supply is
   still contended by Mint, Burn, Attest and loss-hit Claims.
6. `VaultClaimBurn` adds a second ungated burn path to the reserve. It is
   pinned to a real Ticket's recomputed excess (3a.5), but it is new
   attack surface and gets its own mutation group.

### 3a.12 Decisions to confirm

**Revision 4 (2.5a merged as PR #14) — to approve: the re-targeting only, no
new decision.** `loss_pending_until` and `vault_policy` live in the Config
(3a.3); `OpenLoss`, `CancelLoss`, `SetVault` are Config transitions;
`LossBurn` spends Supply **and** Config (the one redeemer allowed to spend
both); `VaultClaimBurn` spends the Supply only and reads `vault_policy` from
the Config by reference; the vault's freeze check reads the Config by
reference. Two consequences the earlier text hid, both accepted here:
`ReportYield` references the hot Supply for the 3% cap (3a.1), and a
`VaultClaimBurn` needs the Config reference after all (3a.5).

Revision 2 **approved** (D-11, D-12, D-17, D-17a, D-20), with one fix applied
as revision 3: **D-14** — `LossBurn{qty, written_off}` lowers `attested_reserve`
by the full `written_off = loss − residual`, not by the burned `qty`. D-20 is
a separate workstream: **2.5a** (config/supply split, branch
`phase2-5a-reserve-split` from `main`) merges first; **2.5b** (this section)
is then rebased onto `main`. Revision 2 text follows. **Approved:** D-9, D-10 (3% reading confirmed), D-13, D-14, D-15,
D-16, D-18, D-19, and D-8 (resolved: 2-H merged, rebased). **Changed, to
re-approve:**
* **D-11 (changed)** — waterfall spreads the remainder over `A + T` using the
  new `ticket_escrow`; `Claim` becomes a State transition.
* **D-12 (changed)** — `loss_index' = max(min_loss_index, idx·(E − rem')/E)`
  with `E = A + T`.
* **D-17 (replaced)** — `VaultClaimBurn{qty}`: ungated, pinned to a genuine
  Ticket's recomputed excess.
* **D-17a (new)** — `vault_policy` is a Reserve Config field set by
  `SetVault` (a reserve script parameter is impossible: circular hash).
* **D-20 (new, recommendation in 3a.13)** — split the Reserve State into
  config and supply UTxOs in 2.5, staged as 2.5a before the loss logic.

### 3a.13 Reserve State: config / supply split (D-20) — done in Phase 2.5a

Implemented and merged as PR #14 (§1). The recommendation and its reasoning are
kept in the git history of this section; what 2.5b builds on:

* **ConfigState** (changes by committee action; read by reference by the vault,
  the registry, `VaultClaimBurn` and later the queue): the 2.5a fields plus
  `vault_policy` and `loss_pending_until`, added in 2.5b (3a.3). Spent by
  `Rotate`, `SetPaused`, `SetKyc`, `SetVault`, `OpenLoss`, `CancelLoss`
  and `LossBurn`.
* **SupplyState** (unchanged by 2.5b): spent by `Mint`, `Burn`, `Attest`,
  `SetCap`, `LossBurn` and `VaultClaimBurn`.
* `ReportLoss` spends the vault State, the Supply, the Config and (when
  needed) the first-loss State: four script inputs, committee-driven and rare.
* **What 2.5b relaxes.** 2.5a's rule "a transition spends one kind and none of
  the other" gets exactly one exception, `LossBurn` (3a.3). The 2.5a tests that
  pin the rule stay, and `LossBurn` gets its own both-or-neither tests.
* **What the split buys the freeze.** Exits and stakes reference only the
  Config, which supply traffic cannot spend (3a.4, risk 5).

### 3a.14 Execution budget (measured in 2.5b, re-measured with `vault_ops`)

The Preprod per-transaction limits are 14,000,000 memory and 10,000,000,000 CPU
steps. Measured with Aiken's unit-test machine on worst-case fixtures
(`lib/tessera/loss_fixture.ak`, which every validator's tests also run). Each
test's cost includes building the fixture transaction, which does not exist on
chain; that baseline was measured separately and subtracted (the "net" columns).
What the unit tests leave out is the validator wrapper's decoding of the script
context, a few thousand steps per script. **Open item:** a full-transaction
evaluation (Ogmios / Lucid `evaluate`) once the Phase 3 builders exist.

| Transaction | Scripts run | Memory (net) | CPU (net) | Memory (as measured) | CPU (as measured) |
|---|---|---:|---:|---:|---:|
| `ReportLoss` (both classes wiped, Tickets open, first-loss drawn) | vault State, `vault_ops`, reserve Supply, reserve Config, reserve mint, first-loss | 6,018,915 (**43.0%**) | 1,975,827,761 (**19.8%**) | 11,271,189 (80.5%) | 3,586,114,967 (35.9%) |
| `ReportYield` (first-loss funded) | vault State, `vault_ops`, first-loss `Deposit` | 1,919,643 (**13.7%**) | 646,530,349 (**6.5%**) | 3,406,202 (24.3%) | 1,066,004,434 (10.7%) |
| Claim **with** excess | vault State, vault Ticket, vault mint, `vault_ops`, reserve Supply, reserve mint | 3,385,073 (**24.2%**) | 1,127,473,965 (**11.3%**) | 6,928,259 (49.5%) | 2,136,464,433 (21.4%) |
| Claim **without** excess | vault State, vault Ticket, vault mint, `vault_ops` | 1,855,775 (**13.3%**) | 637,193,966 (**6.4%**) | n/a | n/a |

Per script, net, for the two largest cases:

| `ReportLoss` | memory | CPU | | Claim with excess | memory | CPU |
|---|---:|---:|---|---|---:|---:|
| vault State (binding) | 225,458 | 88,997,621 | | vault State (binding) | 190,928 | 73,349,142 |
| `vault_ops` | 2,406,630 | 784,182,215 | | vault Ticket | 602,785 | 204,980,192 |
| reserve Supply | 1,181,141 | 378,954,533 | | vault mint (marker burn) | 34,531 | 9,428,220 |
| reserve Config | 1,186,029 | 381,867,451 | | `vault_ops` | 1,047,992 | 360,262,976 |
| reserve mint | 231,381 | 71,874,270 | | reserve Supply | 1,321,840 | 422,390,898 |
| first-loss `Draw` | 788,276 | 269,951,671 | | reserve mint | 186,997 | 57,062,537 |

The "Claim without excess" vault figures are taken from the excess case (an
upper bound). The target was under 70% of each limit; the net sums are 43.0% /
19.8%, 13.7% / 6.5%, 24.2% / 11.3% and 13.3% / 6.4%. The as-measured
`ReportLoss` memory (80.5%) includes six copies of the fixture-building cost,
which the chain never pays. Moving the checks into `vault_ops` cost about 1.5
percentage points of memory on `ReportLoss` and 1.4 on a Claim with excess (the
binding and a sixth / fifth script run).

### 3a.15 `vault_ops`: why the vault was split, and how (Phase 2.5b)

**The problem.** The compiled `stsra_vault` was 17,058 bytes, over the 16,384-byte
maximum transaction size. A reference script must itself be published in a
transaction, so the vault could never go on chain, and reference scripts do not
help. (`aiken build` is already `--trace-level silent`; verbose traces would be
18,386 bytes.)

**The fix.** `ReportLoss`, `ReportYield`, `SetBounds` and the State side of `Claim`
moved into `validators/vault_ops.ak`, a withdraw-zero script. The vault's branch
for each of those redeemers only checks:

* the spent input is the genuine State (it holds the thread token);
* the transaction withdraws **0** from `ops`' credential;
* the redeemer of that withdrawal names **this vault's policy** and **this action**
  (the constructor index of its `action`: `ReportLoss` 0, `ReportYield` 1,
  `SetBounds` 2, `Claim` 3). The vault reads only those two things and never
  decodes the action's fields.

The ops script runs the full checks that were in the vault, unchanged. Its
redeemer is `{ vault: PolicyId, action: OpsReportLoss{loss} | OpsReportYield{gross}
| OpsSetBounds{…} | OpsClaim }`; the `loss`, `gross` and bounds that used to ride on
the vault's redeemer now ride on it, so the vault's `ReportYield`, `SetBounds`
and `ReportLoss` redeemers are unit constructors. The Ticket's own validator
(`Claim`'s payout and excess burn) stays in the vault.

**No hash circularity.** The vault is parameterised by `(seed, reserve, ops)`; the
ops script by `reserve` only. It cannot be parameterised by the vault (the vault's
hash contains the ops hash), so it finds the State by the policy its redeemer
names, and the vault binds that field to its own policy. A parameter rather than
a `VaultState` field: it is immutable by construction and adds nothing to the
datum, whose 19-field equality is repeated in every branch and is what makes the
vault large.

**What the withdrawal is.** A gate, not a reward account. The ops handler requires
`withdrawals[ops] == 0`, and the script's **publish handler accepts only
`RegisterCredential`**: deregistration, delegation, registration-and-delegation
and every DRep certificate are refused. Otherwise anyone could deregister the
credential and freeze `ReportLoss`, `ReportYield`, `SetBounds` and every Claim.
Its stake credential must be registered once before first use (a deposit).

**Why an ops run cannot be borrowed.** An ops run for another vault is refused by
the vault (the `vault` field), an ops run for another action by the tag check, a
withdrawal from another credential or with a non-zero amount by the credential and
amount checks, and a transaction that spends an extra vault input (a Position, a
second Ticket) beside the State by the ops script's own input counts. A State
spent under a moved redeemer with no ops run at all is refused.

**Sizes (compiled, silent traces).**

| Script | Before | After |
|---|---:|---:|
| eligibility | 2,365 | 2,365 |
| first_loss | 4,466 | 4,466 |
| reserve | 12,381 | 12,308 |
| stsra_vault | **17,058** | **12,652** |
| vault_ops | - | **11,100** |

Every validator is at or under 13,000 bytes. `scripts/verify-vault-hash.mjs` fails
any validator in any project above 14,000 bytes. **Phase 2.6 must not grow
`stsra_vault` or `reserve`** (about 350 and 690 bytes of headroom); the
redemption queue goes in its own script, and anything the queue needs from the
vault or reserve goes into `vault_ops` (about 1.9 KB of headroom) or a new
script, not into those two. Applying parameters adds a few dozen bytes to each.

## 4. Redemption queue (Phase 2.6 — DESIGN CHECKPOINT, nothing implemented)

Status: **revision 2, approved** (0825b2b), **implemented** in Phase 2.6 (§4.17 lists the
deviations, §4.18 the tests and the mutation pass). D-21 to D-35 approved as committed:
short mode (D-32), Defund notice and veto-by-presence (D-33), the 1% limit floor (D-34)
and the Sink invariant (D-35). R-2 stays an audit item (A-1).

Baseline: §4 of the skeleton ("instant
tier up to the buffer; Request UTxOs bucketed per day; payable after
`bucket_end + settle_delay` (max 7 days); permissionless settlement to `owner`;
owner cancel before settlement") plus the 2.3 decision that `kyc_redeem` is
applied to the requester **at request time** (§1a, note (a)).

Decisions are numbered [D-21]… (2.5b ended at D-20). Each has a recommended
default; the ones that need your call, counsel's or both are in §4.12.

### 4.0 Constraints and what is not touched

* **No change** to `stsra_vault` (12,652 B), `reserve` (12,308 B), `vault_ops`
  (11,100 B), `first_loss` (4,466 B) or `eligibility` (2,365 B), and so no
  rehash and no new pin for any of them. Every new script ≤ 13,000 B; CI fails at
  14,000.
* **Why the reserve cannot take a queue redeemer** (measured, scratch copy, not
  committed): a minimal `QueueBurn{qty}` modelled on `VaultClaimBurn` (it sums
  the settled requests and burns exactly that) takes the reserve from 12,308 to
  **13,072 B (+764)**, before the Config field that would name the queue script.
  That breaks the target and uses up the reserve's remaining headroom, so the
  queue burns through the reserve's **existing** `Burn` (D-22).
* The queue's committee, `kyc_redeem` switch and `eligibility_policy` are read
  from the genuine reserve Config **by reference** (`reserve_ref.genuine_config`),
  so a `Rotate` or `SetKyc` carries over, as in the vault.
* Units: TSRA and the payout asset both have 6 decimals; 1 TSRA redeems for 1
  payout unit (par). Times are POSIX ms.

### 4.1 [D-21] Scripts

The proven 2.5b pattern: cheap per-UTxO gates, the real work once per
transaction in a withdraw-zero script. (A batch settlement spends N Request
inputs, and a spend handler runs once per input: putting the batch checks in it
would cost O(N²).)

| Script | Purpose | Holds | Est. size |
|---|---|---|---:|
| `redeem_queue` (mint + spend; params `seed, reserve, flow, admin, short`) | marker mint/burn; the UTxOs at its address; plain `Cancel`; gates every other spend to `queue_flow`, `queue_admin` or `queue_short` | Request, Sink, Buffer shards, QueueConfig, ShortState, Grace | **3,128** (estimated 6,300–8,500) |
| `queue_flow` (withdraw-zero; param `reserve`) | user flow: `Request`, `Instant`, `Settle`, `Sweep`, limit accounting, and `PayShort` (short mode, §4.17) | – | **12,436** (estimated 9,250–11,750) |
| `queue_admin` (withdraw-zero; param `reserve`) | committee flow: `Genesis`, `Suspend`, `Resume`, `AnnounceLimits`, `ApplyLimits`, `SyncFloor`, `Fund`, `AnnounceDefund`, `Defund`, `GrantGrace` | – | **12,704** (estimated 7,000–9,000) |
| `queue_short` (withdraw-zero; param `reserve`) | stress flow: `EnterShort`, `Register`, `ExitShort`, `CancelRegistered`, `VetoDefund` (D-32, D-33); `PayShort` moved to `queue_flow` | – | **11,165** (estimated 7,000–8,500) |

`queue_flow`, `queue_admin` and `queue_short` publish handlers accept only `RegisterCredential`
(the 2.5b condition), and their withdrawal amount must be 0. The queue binds the
withdraw redeemer's `queue` field and action tag exactly as the vault binds ops.

**Sizes.** Estimates, except one measurement: a scratch stub of `queue_short`'s four
state-machine transitions (`Enter`, `Register`, `Pay`, `Exit`, with simplified payment
checks, no binding, no limits, no Cancel, no veto) compiled to **4,667 B**. Adding
the binding, the limit-room test, `CancelRegistered`, `VetoDefund` and the real
payment checks is what takes the estimate to 7,000–8,500. The other ranges are
anchored on `vault_ops` (11,100 B for four heavy transitions) and `first_loss`
(4,466 B). The short-mode design adds to existing scripts: `redeem_queue` about
300–500 B (the ShortState variant, routing of registered Requests, one more Request
datum field `reg_episode`) and `queue_flow` about 250 B (the normal-mode
"short mode is off" reference-input check). **Worst case is `queue_flow` at
11,750 B, 1,250 B under the target.** First step of the implementation, before any real
logic: compile stubs of all four validators and report real sizes; if any estimate
fails, stop and re-split.

### 4.2 [D-22] How TSRA is burned (item 2)

**Recommended: lock at request, forward at settlement, burn in batches through
the existing `Burn`.**

1. *Request:* the holder signs, `kyc_redeem` is applied to them **here** (D-25),
   and their TSRA is locked in a Request UTxO. Supply is **not** touched, so
   requests are independent of the reserve (D-30).
2. *Settle / Instant:* the TSRA in the settled Requests moves into a **Sink**
   output at the queue address (no burn yet), and the payout is made (D-23).
3. *Sweep:* anyone holding a `kyc_redeem`-eligible key (a keeper; the committee
   issues it a registry token) spends any number of Sink inputs together with the
   genuine Supply under the reserve's **existing** `Burn{qty, holder}`. The Sink
   spend handler (gate to `queue_flow`) requires: the Supply input's redeemer, read
   from `tx.redeemers`, is constructor 1 (`Burn`) with `qty` equal to the total TSRA
   in the Sink inputs; no TSRA output at the queue address; nothing else spent at
   the queue. The reserve itself enforces `delta == -qty`, `minted_supply -= qty`
   and the `kyc_redeem` check on the keeper.

The reserve's `Burn` constructor index is read with `builtin.un_constr_data` (a
mirror, as `OpsEnvelope` does); `verify-vault-hash.mjs` is extended to check the
index against the reserve blueprint, so a reordering of `ReserveRedeemer` fails CI.

*Consequence to accept:* between settlement and sweep, `minted_supply` still
counts TSRA that has already been paid out. That errs **against** minting
(`minted ≤ attested` keeps holding with a larger left side), so it is
conservative; the cost is that the TSRA supply figure lags by the unswept amount.
If no eligible keeper exists, sinks pile up (liveness, not safety).

*Alternatives rejected:* (a) **new reserve redeemer**: +764 B, breaks the target;
(b) **burn at request** with the existing `Burn`: the burn cannot be undone, so
the owner could never cancel; (c) **settlement through `Burn` signed by the
holder**: not permissionless, and it is when `kyc_redeem` is on (the real mode)
that permissionlessness matters; (d) **a burn-authority script** that takes
`claim_excess` out of the reserve and lets the queue use the same slot: would
shrink the reserve and is the clean long-term shape, but rewrites the merged,
mutation-tested `VaultClaimBurn` path. Not for 2.6; revisit if a third burner
appears.

### 4.2a [D-35] Invariant I-Q1: a Sink can only be burned

**I-Q1. A Sink UTxO is spendable ONLY in a transaction that burns its entire TSRA
through the reserve's `Burn`. Nothing else, ever.** No cancel, no refund, no
committee path, no re-route, no change of datum, not even in an emergency: if
TSRA is in a Sink, the only thing that can happen to it is that it ceases to exist.

How it is enforced (all of it must hold, in one place, `queue_flow`'s `Sweep`):

1. The spend handler for a Sink datum in `redeem_queue` accepts **one** redeemer, the
   gate to `Sweep`; every other redeemer, and a Sink input under any other action
   of the same withdrawal (for example a `Settle` that also lists a Sink), fails.
   The Sink datum has no owner and no alternative branch to add one to.
2. `Sweep` requires the genuine reserve Supply (thread token) to be spent in the
   same transaction with a redeemer that decodes to the reserve's `Burn`
   (constructor 1) whose `qty` equals the **total TSRA in all Sink inputs**.
3. No output at the queue address carries any TSRA, and no output anywhere
   carries TSRA that came from a Sink input: the entire amount is burned (the
   reserve checks `delta == -qty`; the sweep checks the outputs).
4. Every input at the queue address in a `Sweep` is a Sink (a Sweep cannot also
   carry a Request, a Buffer shard or the config along).
5. A Sink input must hold only TSRA and lovelace (no other token), so nothing else
   can be trapped or smuggled out through the sweep.
6. The Sink lovelace goes to whoever builds the sweep (that is the keeper's
   incentive); it is not part of the invariant.

*Creation is unconstrained:* anyone can send TSRA to a Sink, which is a donation
that can only be burned; `Settle` and `Instant` are the only ways the protocol
creates one.

*Tests for I-Q1:* a Sink spent with the owner's signature but no Supply; with a
Supply spent under `Mint`, `Attest`, `SetCap`, `VaultClaimBurn`, `LossBurn`; with a
`Burn` for one unit less / more than the Sink total; with a planted Supply (no
thread token); with TSRA left at the queue address; with TSRA sent to a wallet and
a smaller `Burn`; with a Request or Shard input alongside; with a Sink holding a
foreign token; a Sink under every other queue redeemer (`Cancel`, `Settle`,
`Instant`, each admin and short action); two Sinks plus one correct `Burn`
(accepted); accepted: one Sink and many Sinks, each exactly burned.
*Mutants for I-Q1:* delete each of the six conditions; `Burn` constructor index 1 -> 0
or 2; `qty ==` total -> `<=` or `>=`; total over only the first Sink; the "no TSRA
output" check on the wrong address; the Sink gate accepting a second redeemer;
the single-redeemer rule replaced by `True`.

### 4.3 [D-23] Who funds settlement; evidence of payout (item 1)

**Recommended: payout is on chain, in a configured payout asset, from a
Buffer; the fiat leg is explicitly not evidenced on chain.**

* The **Buffer** is a set of UTxOs ("shards", D-27/D-30) at the queue address,
  each holding the payout asset (`payout_policy`, `payout_name` in QueueConfig;
  on Preprod a committee-minted test asset) plus a shard thread token. The
  committee funds a shard (`Fund`) and may withdraw surplus (`Defund`), both
  M-of-N via `queue_admin`. `Defund` has a 7-day public notice, can be vetoed by anyone who
  shows unpaid payable Requests, and is refused in short mode (D-33, §4.3a).
* A settlement transaction pays `qty` payout units **to the Request's `payout_to`
  address** out of a shard. The payment itself is the evidence: a Request is
  settled **iff** its owner's address received `qty` in the same transaction.
  Nobody can settle without paying, so permissionless settlement is safe.
* **Not evidenced, on purpose:** any bank or fiat wire. How the committee turns
  fiat into the payout asset (or tops the Buffer up from the off-chain reserve)
  is off chain, visible on chain only as `Fund`, and reflected in the next
  `Attest`. If counsel requires a direct fiat payout instead, the alternative is
  a committee-signed `SettleAttested` (settlement stops being permissionless);
  that is a separate decision, not designed here.
* The Buffer is part of the reserve; the committee's `attested_reserve` must
  include it. **`Burn` does not lower `attested_reserve`** (existing behaviour),
  so between a payout and the next `Attest` the mint headroom
  `attested_reserve - minted_supply` is larger than the cash. Minting still needs
  a committee signature and a fresh attestation, so this is a committee-trust
  point, not a new hole (R-2).

### 4.3a [D-33] Defund: notice, veto, no Defund in short mode (R-3)

**Which of the two forms you offered is enforceable: neither, exactly.** The
"total currently payable" is not tracked (no counters, by design, so that Requests
do not serialise) and "no Request is past `payable_after` and unpaid" is an
**absence**, which a script cannot prove without enumerating every UTxO. What
is cheap to prove on chain is a **presence**: a referenced Request that is payable
and unpaid. So the rule is built on that, with two backstops:

1. **7-day public notice.** `AnnounceDefund{shard, amount}` (committee M-of-N,
   `queue_admin`) writes `pending_defund { shard, amount, effective_at = lo + 7 days }`
   to the QueueConfig (one pending at a time; anything else on the Config is
   unchanged). It lapses 7 days after `effective_at` (re-announce).
2. **Veto by anyone** (`VetoDefund`, `queue_short`). Anyone may reference payable
   Request UTxOs (marker, `payable_after <= lo`, current datum) whose total
   `qty` exceeds `shard balance - amount`; the pending Defund is then cleared.
   A permissionless proof of "this Defund would leave payable Requests uncovered".
3. **Not in short mode.** `Defund` (committee) executes only if `lo >= effective_at`,
   not lapsed, the amount equals the announcement, the shard is the announced one,
   `ShortState` (reference input) is inactive, and it clears the pending record.
   Short mode is exactly "the Buffer cannot pay a Request" (D-32), so when the
   Buffer is under stress the committee cannot drain it.

*Why this and not the tracked total:* a tracked total would be a counter touched by
every Request, Cancel and Settle. *Residual:* the veto needs someone to look, and
shows only the Requests it references (about 40 per transaction); the committee
could announce a Defund that leaves the Buffer short of Requests nobody shows.
The notice is public for 7 days, short mode blocks the execution once a Request
is overdue, and owners can cancel at any time. Documented, not hidden.
*Cost:* `AnnounceDefund`, `Defund` and the config field in `queue_admin` (counted in its 7,000–9,000 B);
`VetoDefund` in `queue_short` (counted in its 7,000–8,500 B).

### 4.4 [D-24] Requests, buckets, cancel

* **Request UTxO** at `redeem_queue`, holding exactly: `qty` TSRA, one `request`
  marker (minted by the queue, F-4 style, so a planted lookalike is ignored), and
  lovelace `>= min_request_ada`. Datum:
  `Request { owner: VerificationKeyHash, payout_to: Address, qty, bucket, payable_after }`.
* `bucket = lo / 86_400_000` of the creating transaction, which must be a finite
  window of at most 1 hour that lies inside one day (a window crossing midnight is
  refused; resubmit). `payable_after = (bucket + 1) * 86_400_000 + settle_delay`,
  **computed and stored at request time**, so the committee cannot lengthen an
  existing request by changing `settle_delay` later.
* `settle_delay` is in QueueConfig, `0 <= settle_delay <= 7 days` (hard rule in
  `rules.ak`-style constants, not a vote). Recommended default 2 days.
* `qty >= min_request` (QueueConfig; default 100 TSRA) keeps dust out.
* **Cancel:** the owner signs; spends the Request with `Cancel`; gets exactly the
  TSRA back (+ lovelace) at an address they choose; marker burned. Allowed at any
  time before the Request is spent by a settlement, **and never blocked** by a
  suspension, a loss freeze, a revoked eligibility token, the pause, or an empty
  Buffer. Cancel and settlement race for the same UTxO; whichever lands first
  wins. Cancel is handled by `redeem_queue` itself (no `queue_flow` run).
* **Keeper tip:** a settler may take at most `settle_tip` lovelace (QueueConfig,
  default 0.2 ADA, hard cap 1 ADA) per Request out of its lovelace; the rest goes
  to `payout_to`. So permissionless settlement has an incentive but cannot be a
  grab.
* `payout_to` must be a key-credential address (v1); a script payout address is
  refused (it could be made un-spendable or non-payable and block a batch).

### 4.5 [D-25] Eligibility (item 2)

* `kyc_redeem` on: `Request` and `Instant` call the one existing
  `eligible(tx, policy, owner)`: `owner` signed and holds a registry token, read
  from the genuine Config at request time. Off: `owner` still signs (a Request
  needs its owner for Cancel), no token needed.
* `Settle` needs **no** signature and no eligibility (decided in 2.3 note (a)):
  funds go only to `payout_to`.
* `Sweep` goes through the reserve's `Burn`, which applies `kyc_redeem` to the
  keeper (above). That is not a compliance control on the redeemer; the control
  is the request-time check.
* `paused` does not block any queue action: the reserve's `Burn` is allowed while
  paused, and so is redemption.

### 4.6 [D-26] Instant tier

`Instant{qty}` in one transaction: the holder signs, `kyc_redeem` applies, the
holder's TSRA goes into a Sink and the holder is paid `qty` from a shard.
Allowed iff all hold: not suspended (D-28), no loss freeze (D-29), `qty <=
instant_max` (QueueConfig, default 10,000 TSRA per transaction), `qty <=` the
shard's payout balance, and the shard's daily and monthly counters leave room
(D-27). So "instant up to the buffer" is bounded by the shard balance **and** the
limits. Anything above that goes through the daily-bucket path.

### 4.7 [D-27] Daily and monthly limits (item 3)

* Limits cap total **payouts** (instant + settled) and live where payouts
  already serialise, the Buffer shards, never on Requests. QueueConfig holds
  `daily_limit`, `monthly_limit` (global, in payout units) and `shards`; each shard
  enforces `daily_limit / shards` and `monthly_limit / shards`, so the global cap
  holds without a shared counter. Windows: day index `lo / 86_400_000`, month
  index `day / 30` (30-day blocks, not calendar months; simpler and
  unambiguous on chain).
* Shard datum: `Shard { day, paid_day, month, paid_month }`; a payout resets a
  counter when its index moved and refuses when `paid + qty > limit`.
* A Request that does not fit today's limit stays pending (nothing is lost, it
  can be cancelled) and is paid on a later day.
* **The committee's power over limits is bounded:** an *increase* applies at once;
  a *decrease* is announced (`pending_limits` + `effective_at`), applies only
  `limit_notice` (7 days) later, and only through an explicit `ApplyLimits` that
  re-checks the floor (D-34), so lowering the limits cannot be used as an
  open-ended suspension, and neither can a limit that has fallen below the floor.
* Per-holder limits (AML) are **not** on chain: they would need per-holder state
  and a shared registry. Out of scope unless counsel requires it.

### 4.7a [D-34] Limit floor (R-4)

`floor = max(min_daily_limit, minted_supply / 100)`, with `min_daily_limit` a
constant of **10,000 TSRA** (units of the payout asset, par). `minted_supply` is
read from the genuine reserve **Supply by reference**.

* `daily_limit >= floor` is required wherever a limit is written: at genesis, on an
  increase, on the announcement of a decrease, **and again at `ApplyLimits` when a
  decrease takes effect** ("including after the notice period"). Also
  `monthly_limit >= daily_limit`.
* Supply grows, so a limit that was legal can fall below 1%. `SyncFloor` (anyone, no
  committee) raises `daily_limit` to the current floor (and `monthly_limit` to at
  least that) when it is below. So no limit stays under the floor for longer than one
  transaction after anyone cares to fix it, and zero is impossible.
* The **hot path never reads the Supply**: `Settle` and `Instant` read only
  `QueueConfig.daily_limit`. A Supply reference input on every payout would make
  every payout fail whenever a mint or burn lands between building and submitting
  (the problem the 2.5a Config/Supply split removed). Only `queue_admin` reads it.
* 1% of supply a day still lets a determined committee slow redemptions to about 100
  days for the full supply; that is the policy number you chose, and the
  7-day announced decrease plus the floor are the protection. Say if you want 2%.
* *Cost:* about 400–600 B in `queue_admin` (counted in its range). *Tests:* the limit
  exactly at the floor (accepted) and one unit below (refused) at genesis, increase,
  announcement, `ApplyLimits`; a limit legal at announcement and below the floor at
  application (refused) after the supply grew; `SyncFloor` raises, never lowers;
  `SyncFloor` with a fake Supply (no thread token) refused; zero refused.
  *Mutants:* `max` -> `min`; `/ 100` -> `/ 10` and `/ 1000`; `>=` -> `>`; floor skipped
  at `ApplyLimits`; floor skipped at announcement; `SyncFloor` allowed to lower.

### 4.8 [D-28] Suspension under stress (item 3)

* `Suspend{until}` (committee M-of-N, `queue_admin`) sets `suspended_until` in
  QueueConfig; `Resume` clears it. Effects while `suspended_until > lo`: `Instant`
  and `Settle` are refused. `Request` and `Cancel` are **not** blocked (the queue
  can form; owners can always leave).
* Cap and gap mirror the loss freeze: one suspension lasts at most
  **3 days** from the transaction's lower bound (`max_suspend_ms`, constant), and a
  new one may open only **7 days** after the previous ended
  (`suspend_reopen_gap_ms`). The window of the opening transaction is at most 1
  day. Recommended 3 days (not 7) because the daily path already adds up to 7
  days of `settle_delay`; the committee can still re-suspend after the gap.
* A suspension does not change any stored `payable_after`; requests simply wait.

### 4.8a [D-32] Short mode: oldest-day-first, stress only (R-1)

**Normal settlement is unchanged (D-30: no shared cursor).** When the Buffer
cannot pay, settlement becomes strictly oldest-day-first. This is the cheapest form
I can find that is actually enforceable, and what it costs.

*Why a bare cursor is not enough:* a cursor "pay day 3 before day 4" needs a
proof that **no unpaid day-3 Request exists**, and absence cannot be proved without
a maintained count. A count per day touched by every Request and Cancel would put a
shared UTxO on all requests, which you ruled out. So: **lazy registration**, with one
`ShortState` UTxO that nothing spends in normal operation.

* **ShortState** (one UTxO, thread token, at the queue address, created at Genesis):
  `{ active, episode, since, reg_deadline, last_exit, tallies: List<{day, open}> }`,
  `tallies` sorted by day. In normal mode it is **referenced** (by `Settle`,
  `Instant`, `Defund`), never spent.
* **Enter** (anyone, `queue_short`). Evidence, all by reference: one Request UTxO
  (marker) at least **24 h past its `payable_after`** with `qty <= probe_max`
  (= `instant_max`, 10,000 TSRA), **and every Buffer shard** (the count must equal
  `shards`, distinct thread tokens) unable to pay it (balance or day/month room below
  its `qty`); not suspended and no loss freeze (those are not a funds shortage); at
  least 24 h since the last exit. `probe_max` stops one huge Request from forcing
  short mode. Effect: `active`, `episode + 1`, `reg_deadline = lo + 24 h`, empty tallies.
* **Register** (anyone). Spends payable, unregistered Requests and re-creates them
  identical except `reg_episode = episode`; adds their `qty` to the tallies by bucket
  (sorted insertion: an older day goes to the head). **No payments during the
  24-hour window**, so every payable Request has a public day to be registered by its
  owner or by the keeper. Registration stays open afterwards.
* **PayShort** (anyone), only after `reg_deadline`: spends **registered** Requests of
  the **head day** only, pays them as `Settle` does (same payout, tip, limits and
  Sink rules), and subtracts the total from the head tally (the head is removed at 0).
  Order within a day is free. `Instant` and normal `Settle` are refused while
  `active` (they would jump the queue).
* **Cancel of a registered Request** goes through `queue_short` and takes its
  `qty` off its day's tally (any day); the plain, unregistered Cancel is unchanged and
  still never blocked by a rule.
* **Exit** (anyone): after `reg_deadline` when `tallies == []`; `last_exit = lo`.

*Guarantee:* among registered Requests, payment is strictly oldest-day-first, and no
unregistered Request can be paid while short mode is on. *Residual (R-1b):* a Request
that was payable at entry and that nobody registered within the 24-hour window can be
overtaken by registered newer ones; registration is permissionless so the keeper and
the owner can both do it, and a Request that was not payable at entry has a later
bucket than anything payable at entry, so it cannot be an older one that was skipped.

*Contention:* every short-mode action serialises on `ShortState` (accepted).
Normal mode adds one reference input to `Settle` and `Instant`; a short-mode
transition invalidates in-flight settlements, which is intended.
*Cost, bytes:* `queue_short` 7,000–8,500 B (stub of the state machine: 4,667 B,
measured); `redeem_queue` +300–500 B; `queue_flow` +250 B. *Cost, budget (estimate,
unmeasured):* normal `Settle` and `Instant` +<1% (one reference input); `Register` and
`PayShort` with 20 Requests under 35% memory (list work is O(Requests x days));
`EnterShort` under 15%. **All fit the size limit, so no alternative is needed.**


### 4.9 [D-29] Loss freeze and Tickets (item 4)

* **While `loss_pending_until > lo` (read from the genuine Config by reference):**
  `Instant` and `Settle` are refused (same mechanism as suspension, no committee
  step needed, bounded by the reserve's 7-day cap); `Request` and `Cancel` are
  allowed. So a frozen vault's **TSRA holders can queue and can cancel**, they are
  just not paid until the freeze ends. Reason: a pending loss means the reserve is
  being re-stated; paying par during it races the write-down.
* **sTSRA stakers in a frozen vault** cannot unstake or stake (vault rule, 2.5b);
  until they hold TSRA they have nothing to queue. TSRA that exited before the
  freeze can be queued.
* **Tickets are not in the queue.** A Ticket claim pays TSRA (loss share already
  burned via `VaultClaimBurn`); the claimant may queue that TSRA afterwards. The
  queue never reads or spends vault UTxOs, and the vault never reads the queue.
* `LossBurn` and `ReportLoss` do not touch Requests, Sinks or Buffers. A loss that
  also hits the payout asset's backing is the committee's `Defund`/`Attest`
  problem, not a protocol path (R-5).

### 4.10 [D-30] Contention (item 5)

| UTxO | Touched by | Contention |
|---|---|---|
| Request (one per request) | its creator, then one settlement or cancel | none: new outputs, nobody shares them |
| Sink (one per settlement tx) | the sweep | none until swept; a sweep takes many at once |
| Buffer shard (K UTxOs) | `Instant`, `Settle` | one tx per shard per block; K shards, K set by the committee; a settler picks any shard with room |
| Supply | `Sweep` only | once per batch, not once per request (this is the point of D-22) |
| QueueConfig, reserve Config | by reference only; committee actions spend them | none in normal operation |
| ShortState | referenced by normal `Settle`/`Instant`/`Defund`; spent only in short mode | none in normal operation; in short mode every action serialises on it (accepted, D-32) |

A settlement transaction takes **many** Requests (their number is bounded by the
execution budget and the 16 KB size, estimated ~20–30) and pays them all from one
shard, so shard contention is per batch.

### 4.11 [D-31] Grace period for revoked holders (item 6)

**Recommended: a parameter, `grace_ms` in QueueConfig (hard cap 30 days;
recommended default 14 days; 0 disables), exercised through an explicit,
committee-granted record. Counsel to confirm the number and whether it may apply
at all (e.g. sanctions).**

* `GrantGrace{holder, until}` (committee M-of-N, `queue_admin`) creates a Grace
  UTxO at the queue (a token named by the holder's key hash) with
  `until <= lo + grace_ms`. The committee does it in the same transaction that
  revokes the registry token, or later, or never (a sanctioned holder gets none).
* While `kyc_redeem` is on, `Request` accepts a holder who has **either** an
  eligibility token **or** a referenced Grace for them with `until >= hi`. A grace
  holder can only **queue** to redeem; it does not let them mint or stake.
* A Request already created is unaffected by a later revocation (eligibility is
  checked at request time), so revoking never strands an in-flight Request.
* It is opt-in per revocation by design: a rule that grants grace automatically
  would apply to the cases where counsel says it must not.
* Not on chain: why a holder was revoked, and whether a revoked holder's
  payout may be withheld. Counsel.

### 4.12 Decisions to confirm

| # | Decision | Recommended | Needs |
|---|---|---|---|
| D-21 | Four scripts (`redeem_queue`, `queue_flow`, `queue_admin`, `queue_short`); nothing existing changes | approved | – |
| D-22 | Lock at request; Sink; batched sweep through the existing `Burn`; no reserve change | approved | – |
| D-23 | On-chain payout from a Buffer in a payout asset; fiat leg explicitly off-chain | approved | – |
| D-24 | Day buckets, `payable_after` stored at request, key-address payout, tip ≤ 1 ADA | approved | – |
| D-25 | `kyc_redeem` at request/instant; none at settle | approved (2.3 decision) | – |
| D-26 | Instant tier = shard balance and limits, `instant_max` | approved | – |
| D-27 | Limits per shard (global ÷ shards), decreases with 7-day notice | approved | – |
| D-28 | Suspension ≤ 3 days, 7-day reopen gap, blocks instant and settle only | approved | – |
| D-29 | Loss freeze blocks instant and settle; request and cancel stay open | approved | – |
| D-30 | Requests are independent UTxOs; K Buffer shards; Supply touched once per sweep; no cursor in normal mode (oldest-day-first only in short mode, D-32) | approved | – |
| D-31 | Grace: `grace_ms` ≤ 30 days, default 14, committee-granted | approved | – |
| D-32 | Short mode: lazy registration, one ShortState, oldest-day-first over registered Requests, permissionless entry by evidence | approved | – |
| D-33 | Defund: 7-day notice, anyone's veto by showing unpaid payable Requests, refused in short mode | approved | – |
| D-34 | Daily limit floor = max(10,000 TSRA, 1% of minted supply), checked at every write and at `ApplyLimits`, `SyncFloor` | approved | – |
| D-35 | I-Q1: a Sink is spendable only in a tx that burns all its TSRA through the reserve | approved | – |

Defaults for QueueConfig (all committee-set within hard bounds, genesis values are
bootstrap parameters): `settle_delay` 2 d (≤ 7 d), `min_request` 100 TSRA,
`instant_max` 10,000 TSRA, `settle_tip` 0.2 ADA (≤ 1 ADA), `daily_limit` and
`monthly_limit` chosen per launch, `shards` 4, `grace_ms` 14 d (≤ 30 d).

**Open risks.**
* R-1 *Ordering (revised).* Normal settlement is not first-in-first-out (D-30); in short
  mode it is oldest-day-first over registered Requests (D-32). Residual R-1b: a
  Request payable at entry that nobody registers in the first 24 hours can be
  overtaken. Entering short mode needs a real shortage (the evidence is a
  Request of at most `probe_max` that no shard can pay).
* **A-1 (audit item, formerly R-2).** *The attested reserve lags payouts* (D-23).
  `Burn` does not lower `attested_reserve`, so between a payout and the next
  `Attest` the mint headroom `attested_reserve - minted_supply` is larger than
  the cash. Minting still needs a committee signature and a fresh attestation, so
  this is a committee-trust point, unchanged from the `Burn` of 2.2, not a new hole.
  To be listed in the external audit scope; not changed here.
* R-3 *`Defund` (revised).* Closed as far as it is enforceable (D-33): the tracked
  total and the "no overdue Request" absence are not provable, so the rule is notice,
  veto by presence, and a block in short mode. Residual: the veto shows only the
  Requests it references.
* R-4 *Limit floor (closed by D-34).* Remaining policy point: 1% a day.
* R-5 *Payout-asset risk* (depeg, issuer freeze) is outside the protocol.
* R-6 *Keeper dependence:* if no eligible keeper sweeps (D-22) supply is
  overstated, never understated.
* R-7 *Estimated, not measured sizes* (§4.1) and execution budget (below).

### 4.13 Execution budget and sizes (targets, to be measured)

The 2.5b method applies: worst-case fixtures, fixture-building cost subtracted,
limits 14,000,000 memory / 10,000,000,000 CPU, target < 70% (design target < 50%
for the batch paths).

| Transaction | Scripts | Target |
|---|---|---|
| `Request` | mint marker, `queue_flow` | < 15% |
| `Cancel` | `redeem_queue` spend, marker burn | < 10% |
| `Instant` | `redeem_queue` (Buffer, gate), `queue_flow`, reserve **by reference only** | < 25% |
| `Settle`, 20 Requests | 20 `redeem_queue` gates, `queue_flow` once, ShortState by reference | < 50% (report the largest batch under 70%) |
| `Sweep`, 20 Sinks | 20 Sink gates, `queue_flow`, reserve Supply + mint | < 50% |
| `Suspend`, `SetLimits`, `Fund`, `GrantGrace` | gate, `queue_admin` | < 15% |
| `AnnounceLimits`, `ApplyLimits`, `SyncFloor`, `AnnounceDefund`, `Defund` | gate, `queue_admin`, reserve Supply by reference | < 15% |
| `EnterShort` | `queue_short`, 1 + K references | < 15% |
| `Register`, 20 Requests | 20 gates, `queue_short` | < 35% |
| `PayShort`, 20 Requests | 20 gates, `queue_short` (+ payout checks) | < 50% |
| `VetoDefund`, 40 references | gate, `queue_short` | < 25% |

The gate on each Request/Sink/Buffer input must stay O(1) per input (a withdrawal
lookup and a redeemer-tag compare, as the vault binding does). Transaction size
is the other limit on batch size (16,384 B).

**Batch caps (hard limits for builders, measured in Phase 2.6).** The scripts do not
enforce a batch size (the ledger's execution limit does); a builder must not exceed these,
which keep each transaction under its target. Memory, fixture cost subtracted, per-input
gates of `redeem_queue` included (108 k for the first queue input, 72 k for each other):

| Transaction | Cap | Memory at the cap | Target | Next size up |
|---|---:|---:|---|---|
| `Settle` | 20 Requests | 47.3% | < 50% | 21 is about 49.3% (not measured) |
| `Sweep` | 20 Sinks | 23.8% | < 50% | – |
| `PayShort` | **16** Requests | 49.1% | < 50% | 17 is about 51.5% |
| `Register` | **12** Requests | 34.9% | < 35% | 14 is 40.3% |
| `VetoDefund` | **30** referenced Requests | 24.0% | < 25% | 40 is 30.9% |
| `Instant`, `Request`, `Cancel` | 1 each | 8.0% / 4.9% / 1.6% | < 25% / 15% / 10% | – |

A queue deeper than a cap is paid, registered or shown over several transactions. CPU
stays under 32% at every cap. `Register` at 12 clears its target by 0.1 point: a builder
that sees a larger fixture (more days in the tallies, longer addresses) should use 10.

### 4.14 Tests (planned)

* **Request:** accepted with `kyc_redeem` off/on; refused: eligibility missing
  when on, owner not signed, `qty < min_request`, TSRA short or extra token in the
  Request, no marker, two markers, window over 1 h or across midnight, wrong
  `bucket`, wrong `payable_after`, script `payout_to`, marker minted to a wallet.
* **Cancel:** owner only; exact TSRA back; refused: other signer, short return,
  marker kept, **allowed while suspended, while the loss freeze is on, with the
  owner's token revoked, while paused, with an empty Buffer** (one test each).
* **Settle:** pays exactly `qty - tip` to `payout_to`; refused: before
  `payable_after` (by 1 ms), underpayment by 1, wrong address, tip over cap, TSRA
  not moved to a Sink, a Request without a marker, two Requests paid once, a
  shard not genuine, shard over daily limit, over monthly limit, suspension,
  loss freeze, mixed batch with one unpayable Request (whole tx refused); counters
  reset on a new day/month; limits are per shard.
* **Instant:** the same limit/suspension/freeze matrix, `instant_max`, shard
  balance; `kyc_redeem` on needs the token.
* **Sweep:** exact `qty` equals the sink total; refused: qty off by 1, no Supply
  spend, wrong reserve redeemer (`Mint`, `Attest`), TSRA left at the queue, Supply
  planted (no thread token), sink + a Request in one tx; a *reserve*-side test that
  `Burn` with `kyc_redeem` on still demands the keeper's token (unchanged).
* **Admin:** Genesis (one-shot, seed); `Suspend` cap 3 days, window ≤ 1 day, 7-day
  gap, refused with a lower bound inside the gap; `Resume`; `SetLimits` increase
  immediate, decrease delayed 7 days, zero refused; `Fund`/`Defund` committee
  only, shard value exact; `GrantGrace` cap `grace_ms`, committee only.
* **Binding** (as for `vault_ops`): no withdrawal, wrong credential, non-zero
  amount, redeemer naming another queue, a different action, an extra queue UTxO
  riding along; publish handlers: unregister, delegate refused, register accepted.
* **Conservation / invariants:** across a generated sequence of requests,
  cancels, settles and sweeps, TSRA in Requests + Sinks equals pending + unswept
  quantity; payouts never exceed shard balance or limits; `minted_supply` falls by
  exactly the swept total; a Request is spent only by Cancel (owner) or a settlement
  that pays it.
* **Short mode (D-32):** `EnterShort` accepted with a 24 h-overdue Request of at
  most `probe_max` that every shard cannot pay; refused: not overdue by 1 ms, a
  Request over `probe_max`, one shard missing from the references, a duplicated
  shard, a shard that can pay, suspended, loss freeze, inside the 24 h re-entry gap,
  already active, a planted Request (no marker). `Register`: tallies add up, an
  older day goes to the head, a not-yet-payable Request refused, a Request registered
  twice refused, the output datum changed beyond `reg_episode` refused. `PayShort`:
  refused inside the window (by 1 ms), a non-head day, an unregistered Request, a
  Request of an old episode, over-subtracting the tally; normal `Settle` and
  `Instant` refused while active; `ExitShort` refused with a non-empty tally or inside
  the window; `CancelRegistered` lowers the right day's tally and cannot take more than
  it holds; a stale registration (older episode) cancels plainly.
* **Defund (D-33):** `AnnounceDefund` sets the 7-day notice; `Defund` refused one
  millisecond early, after lapse, with another amount or shard, in short mode, and
  with the announcement missing; `VetoDefund` accepted with referenced payable
  Requests whose total exceeds `balance - amount`, refused at equality, with a
  not-yet-payable Request, a duplicated reference, a planted Request.
* **Limit floor (D-34):** see §4.7a. **Sink invariant (D-35):** see §4.2a.

* **Cross-checks:** `Burn` constructor index pinned against the reserve blueprint
  (CI); sizes ≤ 13,000 B and ≤ 14,000 B guard.

### 4.15 Mutation plan (planned)

Guard-deletion and comparison-flip mutants, in batches of ≤ 14 in the
**foreground**, with the 2.5b harness: one mutant per item of every `and { … }`
block in the three scripts and the new `lib/` modules, plus targeted mutants for:
`payable_after` comparison (`>=` vs `>`), the tip cap, the day/month window
indices and reset, the `payout >= qty - tip` arithmetic, the suspension cap and
gap, the 7-day decrease notice, the grace cap and `until >= hi`, the Burn
constructor index, the Sink-total equality, the `RegisterCredential`-only publish
rule, the zero-withdrawal gate, each binding check, and Cancel's three
"never blocked" conditions (suspension, freeze, revocation). Expect equivalents
to be listed with the reason, as in 2.5b.

Added in revision 2: **every item of every `and { }` block of `queue_short`**; the 24 h
overdue, window, re-entry and `probe_max` constants (off by one, and swapped
operators); "every shard referenced" (count, distinctness); tally insert order and
subtraction; head-day-only; the `reg_episode` comparison; the veto sum (`>` vs `>=`)
and its reference dedup; the Defund notice, lapse and short-mode check; the floor
mutants (§4.7a); the I-Q1 mutants (§4.2a). The register-twice and cancel-tally
mutants are the ones most likely to survive and are written first.


### 4.16 Out of scope for 2.6

UI and builders (Phase 3: prompts in `docs/lovable-prompts/phase-2-6.md`); the
keeper bot; per-holder AML limits; fiat rails; on-chain FIFO; a burn-authority
refactor (D-22 d); mainnet.

### 4.17 Implementation notes (Phase 2.6, as built)

The scripts are `validators/redeem_queue.ak`, `queue_flow.ak`, `queue_admin.ak` and
`queue_short.ak`, with `lib/tessera/queue_state.ak` (datums, redeemers, constants and the
pure rules), `queue_ctx.ak` (genuine-UTxO selection), `queue_pay.ak` (shard and Sink
output rules shared by Settle and PayShort) and `queue_fixture.ak` (tests only).
`stsra_vault`, `reserve`, `vault_ops`, `first_loss` and `eligibility` are byte-identical
(their blueprint hashes are unchanged).

**Sizes (compiled, bytes).** `redeem_queue` 3,128 · `queue_flow` 12,436 · `queue_admin`
12,704 · `queue_short` 11,165. Target ≤ 13,000, CI fails above 14,000. The stub step
(binding and dispatch only, no logic) compiled to 428–629 B per withdraw script and 495
B for `redeem_queue`: floors, not estimates. The first complete logic measured
`queue_flow` 11,556, `queue_admin` 13,460 and `queue_short` **13,676**; the last two were
over target and were brought under it (below).

**Deviations from the design above.**

1. **PayShort lives in `queue_flow`** (`FlowPayShort`), not in `queue_short`.
   `queue_short` with PayShort compiled to 13,676 B. PayShort is `Settle` with the
   ShortState spent instead of referenced, so it shares every payment rule with it
   (`settle(…, short_mode)`); `queue_flow` grew by about 900 B and `queue_short` fell to
   11,165 B. `queue_short` keeps `EnterShort`, `Register`, `ExitShort`,
   `CancelRegistered` and `VetoDefund`. Tests and mutants for PayShort are in
   `queue_flow`.
2. **`redeem_queue` parameters are `(seed, reserve, flow, admin, short)`**, as
   designed; `reserve` is used by `Cancel` to check that the TSRA leaves the queue.
3. **The binding check also runs when a Cancel is the first queue input.** Found while
   writing the tests: if the first queue input is a Cancel and the others run under a
   script naming a different queue, nothing checked the binding (a shard could be spent
   under an unbound `queue_flow` run). The first queue input now checks that every
   script that runs names this queue, however it is spent; a non-first `Run` input
   still checks that a script runs at all. Test:
   `a_cancel_first_cannot_hide_an_unbound_script_that_runs_the_other_inputs`.
4. **I-Q1 is enforced one level above the spend handler.** The gate in `redeem_queue`
   reads a `Run` input without decoding its datum (a full decode cost about 25,000 memory
   per input in a batch). "A Sink moves only in a Sweep" is instead enforced where the
   inputs are classified: `Sweep` accepts only Sinks and the Supply `Burn`; **every
   other action of the three scripts requires an exact set of queue inputs and refuses a
   Sink among them** (`Request`: none; `Instant`: one shard; `Settle`: shard plus
   Requests; `PayShort`: shard, ShortState plus Requests; every admin action; `Register`,
   `Enter`, `Exit`, `CancelRegistered`, `VetoDefund`). Tests: `*_refuses_a_sink_input`,
   `*_may_not_carry_another_queue_input`, `a_sink_has_no_cancel`; mutants for each
   condition were killed (§4.18).
5. **`Settle` and `PayShort` do not re-check each Request's marker and TSRA value.** For
   `n` Request inputs the transaction must burn exactly `n` markers (`mint == -n`).
   Markers live only in Request UTxOs (minted into them by `Request`, kept by `Register`,
   burned by `Cancel` and settlement) and each holds exactly one, so a planted lookalike
   cannot be among the `n`. The value of a genuine Request was pinned at creation and
   `Register` re-creates it identically. Saves about 0.1 M memory per Request.
6. **The keeper's tip is in lovelace** (§4.4), so `Settle` requires `payout_to` to receive
   at least `qty` payout units and at least the Request's lovelace less `settle_tip`.
   The §4.14 test list's "`qty − tip`" wording conflated the two; the tests follow §4.3/4.4.
7. **`SetLimits` is `AnnounceLimits`:** raising both limits applies at once; anything else
   is announced and applies through `ApplyLimits`. `ApplyLimits` is a committee action;
   `SyncFloor` is permissionless. `max_shards` is 8 (a 16-shard Genesis used about
   85% of the memory budget).
8. **A stale registration cancels through `CancelRegistered`** with the ShortState only
   referenced; the plain `Cancel` refuses any registered Request. `CancelRegistered` is
   owner-signed and does not repeat the plain Cancel's "TSRA must leave the queue" check.
9. **Not testable as listed in §4.14:** "a duplicated reference" in the Defund veto (the
   ledger forbids duplicate reference inputs) and "shard balance" for `Instant` (the
   ledger forbids a negative output; the exact value rule is tested).
10. **Property tests use deterministic spreads** (30 and 20 samples) because
    `aiken/fuzz` is a separate package and the project has no such dependency.
11. **Grace UTxOs are never spent** and are not revocable before expiry; each grant is a
    new UTxO. `until` is capped by `grace_ms`.

**Execution budget** (14,000,000 memory / 10,000,000,000 CPU; fixture-building cost
subtracted; the per-input gates of `redeem_queue` added: first input 108 k memory, each
other input 72 k, so 20 inputs cost 1.51 M memory and 0.80 B CPU):

| Transaction | Script | Memory | CPU | Target | |
|---|---|---:|---:|---|---|
| `Request` | flow | 4.9% | 2.3% | < 15% | met |
| `Cancel` | gate | 1.6% | 0.8% | < 10% | met |
| `Instant` | flow + 1 gate | 8.0% | 3.9% | < 25% | met |
| `Settle`, 20 Requests | flow + 20 gates | **47.3%** | 25.7% | < 50% | met |
| `PayShort`, 20 Requests | flow + 20 gates | **58.9%** | 31.7% | < 50% | not met at 20; **cap 16** (49.1%), §4.13 |
| `Sweep`, 20 Sinks | flow + 20 gates | 23.8% | 14.3% | < 50% | met |
| `Register`, 20 Requests | short + 20 gates | **56.0%** | 30.2% | < 35% | not met at 20; **cap 12** (34.9%), §4.13 |
| `VetoDefund`, 40 references | short | **30.9%** | 13.7% | < 25% | not met at 40; **cap 30** (24.0%), §4.13 |
| `EnterShort` (K = 4) | short | 13.6% | 6.2% | < 15% | met |
| `CancelRegistered` | short | 4.9% | 2.3% | – | – |
| `ExitShort` | short | 2.2% | 1.1% | – | – |
| Admin actions (Suspend, limits, Fund, Defund, Grace) | admin | 6–12% (fixture included) | 2.5–5.5% | < 15% | met |
| `Genesis`, 4 shards | admin | 19.3% (fixture included) | 8.7% | one-time | – |

Batch sizes under 50% memory: `Settle` 20 (measured), `PayShort` 16, `Register` 17 (16
measured, 18 is 50.7%). The short-mode paths missed their design targets: the cost per
Request is about 0.27 M memory in `PayShort` and 0.32 M in `Register`, almost all of it
data decoding and list traversal in the script, not the gates. A batch above the limit is
simply split over several transactions.

### 4.18 Tests and mutation (Phase 2.6)

**Tests:** 434 in the queue modules (`queue_flow` 160, `queue_short` 106, `queue_admin`
110, `redeem_queue` 35, `queue_state` 23), including every item of §4.14 (see the
deviations above for the two that cannot be written as listed), the I-Q1 set, the
short-mode set, the Defund veto, the floor and `SyncFloor`, and "Cancel never blocked".
The whole Tessera suite passes: 1,340 tests (`aiken check`, 0 warnings). The mutation pass ran on the
final logic; `max_shards` 16 to 8 and the removal of an unused constant came after it and
change no comparison.

**Mutation pass.** 413 mutants, generated mechanically from the production code of the
four scripts and the three libraries: every item of every `and { … }` block deleted
(151) and every spaced comparison or `+`/`-` flipped (262), including the Burn tag,
the Sink conditions, the floor, the notice periods, the tallies and every
short-mode constant. Run in foreground batches of up to 21 with 7 workers.

* First pass: 64 survivors. 51 were test gaps: a refusal that another check caused
  (a window or output that was also wrong), or a boundary not tested. Each got a test
  and was re-run and **killed**.
* **13 survivors remain, all equivalent or unreachable**: `n > 0` in `Request`, `Settle`
  (the mint equation `[Pair(request, ±n)]` cannot hold with `n = 0`: a Value has no zero
  entry) and `qty > 0` in `Instant` (a zero or negative Sink cannot be built: the Sink
  must hold a TSRA entry); `reg_episode != 0` in `CancelRegistered` (an unregistered
  Request cancelled through it behaves exactly like the plain Cancel);
  the marker check in `CancelRegistered` (the burn of one marker requires the marker to
  be in the Request); `list.length(shards) == c.shards` in Genesis (implied by the
  output count and the distinct-index count); `>` against `>=` where both branches
  return the same value (`SyncFloor`'s monthly limit, `limit_floor`'s `max`, the order
  tests in `tally_add` and `tally_sub`).
* **Score: 400 of 413 killed (96.9%); 400 of 400 non-equivalent killed.**
* No shared library of the earlier phases was touched (`rules`, `reserve_state`,
  `reserve_ref`, `eligibility` and the thread libraries are unchanged), so their mutants
  need no re-run; the whole Tessera test suite was re-run instead.

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

### Phase 2.4 (sTSRA vault)

110 mutants over `validators/stsra_vault.ak` (95), `lib/tessera/vault_state.ak`
(12) and `lib/tessera/reserve_ref.ak` (3). 102 are killed; the other 8 are
equivalent and listed, one line each, in §3.13. No survivor showed a logic
bug, and the validator logic did not change during the pass.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| Identity / State value | `sole_state` any token count; thread count only; TSRA ignored; next State value unchecked | `a_state_holding_two_tokens_is_not_genuine`, `short_stake_without_the_tsra_arriving_is_rejected`, `short_stake_in_a_lookalike_token_is_rejected`, `the_state_may_not_carry_a_foreign_token` |
| StakeShort / StakeLong | next datum unchecked; epoch not bumped; extra vault inputs | `short_stake_datum_shares_must_match_the_mint`, `short_stake_must_bump_the_epoch`, `long_stake_datum_long_shares_must_match`, `long_stake_cannot_spend_an_existing_position` |
| RequestUnstake / UnlockLong | extra vault inputs / outputs; next datum unchecked | `unstake_cannot_spend_an_existing_position`, `unstake_datum_must_match`, `unlock_cannot_create_another_vault_output` |
| Claim | cap dropped; vault outputs allowed; Ticket value unchecked; early claim; marker burn, payout or excess burn unchecked; loss index ignored | `claim_never_pays_more_than_the_escrow`, `claim_cannot_recreate_the_ticket`, `a_planted_ticket_cannot_be_claimed`, `claim_before_the_cooldown_is_rejected`, `claim_paying_someone_else_is_rejected`, `claim_after_a_loss_must_burn_the_excess` |
| Positions | marker unchecked; State not required; State branch accepts a Claim | `a_planted_position_cannot_be_unlocked`, `a_position_is_spendable_only_beside_the_genuine_state`, `the_state_branch_refuses_a_claim_redeemer` |
| ReportYield / SetBounds | extra vault inputs / outputs; may mint; missing or planted Reserve State | `report_yield_cannot_spend_a_position`, `set_bounds_cannot_create_another_vault_output`, `set_bounds_cannot_mint_stsra`, `report_yield_against_a_planted_reserve_state_is_rejected` |
| Bounds / yield split | each hard limit; lock ≥ cooldown; first loss takes the whole cut; long tier unweighted; short-tier dust lost; cut not taken | `bounds_hard_limits`, `split_conserves_gross_exactly`, `long_tier_earns_the_weight_per_tsra`, `half_the_cut_goes_to_first_loss` |
| Reserve lookup | token ignored; reserve address unchecked | `short_stake_against_a_planted_reserve_state_is_rejected`, `report_yield_against_a_reserve_state_off_the_reserve_address_is_rejected` |

The first run surfaced 18 real test gaps (the guard was there, but no test
pinned it), and each now has a test. Most cover extra vault inputs or outputs
and the next datum on each redeemer. The last one is a Reserve State held at
the wrong address, which the vault suite did not test (2.3 had the matching
test).

### Phase 2-H (hardening: F-6 output pinning, vesting, lock floor, owner unlock)

97 mutants: 59 over Tessera (the shared `lib/stellaris/outputs.ak` 6,
`validators/reserve.ak` 3, `validators/eligibility.ak` 1,
`validators/stsra_vault.ak` 38, `lib/tessera/vault_state.ak` 11) and 38 over
the legacy vaults (`yield_vault` + its `outputs.ak` 12, `multi_asset_vault`
12, `fraction_vault` 14). 96 are killed; the other one is equivalent and
listed in §3.15. No survivor showed a logic bug, and the validator logic
did not change during the pass.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| F-6 helper | address matched by payment credential only; reference script unchecked; lovelace check always true / strict | `f6_state_under_a_foreign_stake_credential_is_rejected`, `f6_state_with_a_reference_script_is_rejected`, `f6_state_losing_lovelace_is_rejected` |
| F-6 per validator | `continuing_ok` / `keeps_lovelace` / `genesis_out_ok` dropped; new Position / Ticket not pinned; lovelace exception removed, widened or not gated on an ADA unit | the `f6_*` tests in each project |
| Vesting (validator) | fold at `hi`; stakes priced at `lo`; exits priced at `hi`; any branch booking from `s0`; weights from booked only; vest start / end / roll-over; window unchecked or strict; yield booked at once | `vesting_a_far_future_upper_bound_cannot_book_the_vest_early`, `vesting_stake_prices_at_the_upper_bound`, `vesting_unstake_prices_at_the_lower_bound`, `vesting_report_conserves_every_unit` |
| Vesting (`vault_state`) | no clamp either side; rounds up; line not restarted; vested not removed; period halved; price ignores vesting | `vested_is_clamped_to_the_unvested_amount`, `vesting_fold_matches_the_hand_computed_state`, `folding_early_never_raises_a_price` |
| Lock floor / genesis | lock ≥ cooldown only; each `vest_*` genesis field unchecked | `set_bounds_with_lock_below_twice_the_cooldown_is_rejected`, `genesis_with_a_future_vest_start_is_rejected` |
| Owner unlock / ADA | owner not required; key owner need not sign; any script input counts; exit ADA not returned; vault-owned Position / Ticket allowed | the H2.3 unlock and claim tests |

The first run surfaced 3 real test gaps, each now with a test: genesis did
not pin `vest_from`, StakeLong at the `lo` price, and SetBounds booking
from the unfolded State. Five mutants that left a one-item `and { }` (which
does not compile) were re-pointed to `True,` and are killed.

### Phase 2.5a (Config / Supply split)

167 mutants over `validators/reserve.ak` (126), `lib/tessera/reserve_state.ak` (6),
`lib/tessera/reserve_ref.ak` (4), `lib/tessera/rules.ak` (8),
`lib/tessera/eligibility.ak` (5) and `validators/eligibility.ak` (18). It
re-runs every Phase 2.2 and 2.3 guard category against the split (genesis datum,
anchor and shape; rotation; committee limits; signature threshold; pause; caps;
freshness; thread-token identity; exact next datum; state value; quantities;
the `eligible()` check, registry, committee source, revoke, KYC gates and
`SetKyc`) and adds the split's own guards. 165 are killed and 2 are
equivalent. The runs were done in batches of about 40 in the foreground, in
scratch copies of the project (Aiken rewrites tracked files), with
`aiken check -m <module>.{` per mutant.

| Guard | Mutants | Killed by (examples) |
|---|---|---|
| Genesis (two tokens, two outputs) | each datum field of Config and Supply; mint exactness (both names, quantity 1 each, nothing else, seed); output count, pinning and exact values per output; datum kind per token | `genesis_with_a_third_output_at_the_reserve_is_rejected`, `genesis_mints_exactly_one_of_each_thread_token`, `genesis_config_token_on_a_supply_datum_is_rejected`, `genesis_with_a_non_zero_config_epoch_is_rejected`, `genesis_with_a_29_byte_eligibility_policy_is_rejected` |
| Thread tokens move only at genesis | mint-handler routing on one name only, on both (`&&`), always, never; TSRA path without a Supply or looking for a Config | `a_second_config_cannot_be_minted_later`, `the_supply_token_can_never_be_burned`, `a_tsra_mint_that_also_mints_a_supply_token_is_rejected`, `a_tsra_mint_that_also_mints_a_config_is_rejected` |
| Supply transitions | structure (spent input is the genuine Supply, Config untouched on both sides, value, address pinning, lovelace); Mint, Burn, Attest, SetCap: signature, switches, bounds, freshness, delta, exact next datum, epoch | `a_planted_supply_beside_the_genuine_one_is_rejected_even_with_the_real_committee`, `a_supply_transition_cannot_spend_the_config_and_send_its_token_away`, `f6_supply_with_a_reference_script_is_rejected`, `burn_datum_must_record_the_burn`, `set_cap_datum_must_match_the_redeemer` |
| Config transitions | structure (spent input is the genuine Config, Supply untouched, value, pinning); SetPaused, SetKyc, Rotate: committee (and the new committee), policy length, exact next datum, epoch, fields taken from the redeemer | `a_planted_config_beside_the_genuine_one_cannot_be_spent_to_rewrite_the_committee`, `the_config_cannot_hold_tsra`, `set_paused_cannot_change_the_committee`, `rotation_can_change_the_threshold` |
| Config reference | missing, planted, off-address, wrong-kind, doubled, two-token Config; committee read from the reference, not the Supply | `mint_without_a_config_reference_is_rejected`, `mint_against_a_planted_config_is_rejected`, `mint_against_a_supply_datum_under_the_config_token_is_rejected`, `the_committee_comes_from_the_config_reference_not_the_supply` |
| Cross-kind | every redeemer on the other kind's datum; sole-token lookups pointed at the wrong token | `set_paused_on_the_supply_datum_is_rejected`, `mint_on_the_config_datum_is_rejected` |
| Committee and rules | `threshold_met`, `operators_valid` parts; `rules` bounds, freshness, window; `finite_bounds` unbounded accepted | `mint_below_threshold_is_rejected`, `genesis_with_a_single_key_threshold_is_rejected`, `attestation_goes_stale_after_seven_days`, `mint_with_unbounded_validity_is_rejected` |
| Readers of the Config | reserve_ref (vault) and the eligibility committee lookup: token, quantity, address, threshold, several Configs, wrong token | `two_config_references_are_rejected`, `issuing_against_a_config_holding_two_config_tokens_is_rejected`, `issuing_against_the_supply_utxo_in_place_of_the_config_is_rejected` |
| Eligibility (2.3, re-run) | `eligible()` (5), issue, registry, revoke, KYC gates, `SetKyc` (switches and policy) | as in Phase 2.3 |

The first run left 20 survivors that were real test gaps (the guard was there,
no test pinned it); each now has a test and was re-run killed. Most were
Config-side twins of guards that had only been pinned on the Supply (F-6
pinning, exact next datum on Burn, SetCap and SetPaused, the planted-input
rule, foreign tokens in the output), plus two mutants that needed the `rules`
module's own tests rather than the reserve's.

**Equivalent survivors (2).**
* *`threshold_met`: `list.unique` removed* — the same equivalent survivor as
  Phase 2.2: a committee never holds a duplicate key (genesis and every
  Config transition require `operators_valid`), so a signer cannot be counted
  twice.
* *Registry: any quantity per name* (`[Pair(name, 1)]` → `[Pair(name, _)]`) —
  the same equivalent survivor as Phase 2.3: the exact-value check on the same
  output already requires a quantity of 1.

**Old guards that did not map one to one.**
* *Single `epoch`* became two counters (Config and Supply); each is bumped and
  checked by its own kind's transitions. `supply_and_config_epochs_are_independent`
  pins it.
* *"Committee valid in the next State" on every transition* (`operators_valid(s1.operators…)`)
  now lives only on Config transitions. A Supply transition checks the
  committee of the Config it references instead
  (`a_config_reference_with_an_invalid_committee_is_rejected`).
* *The spent datum carried the committee*, so the planted-State test pinned the
  rule "the spent input is the genuine State" through the planted committee.
  Supply transitions now take the committee from the Config, so that rule needed
  a new test with the real committee signing
  (`a_planted_supply_beside_the_genuine_one_is_rejected_even_with_the_real_committee`).
* *Eight tests that changed several State fields at once* (a Burn rewriting the
  committee, a Rotate changing the cap or the supply, SetPaused or SetKyc moving
  the reserve) cannot be written any more: no single datum holds both. They are
  now "a transition of one kind cannot also spend the other"
  (`burn_cannot_also_spend_the_config`, `set_cap_cannot_also_spend_the_config`,
  `set_paused_cannot_also_spend_the_supply`, three `rotation_cannot_also_spend_the_supply_to_…`,
  `set_kyc_cannot_also_spend_the_supply`,
  `set_kyc_changing_the_policy_cannot_also_spend_the_supply`).
* *Mint, Burn, Attest and SetCap* now also need a Config reference input; the
  old tests were re-pointed with one added by the fixture.

Tests: 397 before, 507 after (reserve 141 → 244, eligibility 21 → 25, vault 188
→ 191). Every one of the 397 old tests still exists and passes (8 renamed as
above, none weakened).

### Phase 2.5b (loss path)

244 new mutants over `validators/reserve.ak` (OpenLoss, CancelLoss, SetVault,
LossBurn, VaultClaimBurn, genesis), `validators/stsra_vault.ak` (freeze,
`ticket_escrow`, Claim, funding and the 3% cap, ReportLoss, dead classes,
generations, last-exit sweep, genesis), `validators/first_loss.ak`,
`lib/tessera/rules.ak`, `loss.ak`, `first_loss_state.ak`, `reserve_ref.ak` and
`vault_state.ak`. **232 killed, 12 equivalent or redundant.** Run in batches of
at most 16 in scratch copies, each mutant against the tests that name its
guard; survivors were then re-run against the whole module. Eleven first-run
survivors were real test gaps and each has a test now: `CancelLoss` minting,
the long-class sweep of a wiped class's vesting yield, an old-generation
Position and the live class's yield, a draw beyond the balance funded by a
deposit, a genesis datum balance without TSRA, and the first-loss State read
from the wrong address or preferring a stale reference.

**Equivalent / redundant survivors (12).** Each is a guard that another one
already implies; they are kept as defence in depth.
* *LossBurn: own input holds a thread token* — `list.length(ins) == 2` with both
  genuine UTxOs found already forces the spent input to be one of them.
* *VaultClaimBurn: `vault_policy` is 28 bytes* — an empty policy finds no Ticket,
  and `SetVault` only installs 28 bytes.
* *`split_loss`: index term uses `rem` instead of `rem1`* — a negative result is
  clamped to the index floor, the same value.
* *`class_dead`: `shares > 0`* — with no shares `assets_after * 1000 < 0` is false.
* *Claim, State branch: two vault inputs* — `expect [tk] = …` already fixes it.
* *Claim, Ticket branch: two vault inputs* — the State branch, always run
  because the State is spent, refuses a third input.
* *Funding: `cap > balance` as `>=`* — at equality both give room 0.
* *ReportLoss: `loss > 0`* — `written_off > 0` implies it (`written_off <= loss`).
* *first_loss: `balance >= 0`* — `qty <= balance` and `deposit >= 0` imply it.
* *first_loss: `s_in == s0`* — the ledger passes the spent UTxO's own datum.
* *first_loss: the own input holds the thread token* — one genuine input and
  the input count already imply it.
* *`first_loss_moves`: `a.balance == before`* — `before` is read from that input.

**Earlier mutants re-run against the 2.5b scripts.** The 168 Phase 2.2 / 2.3 /
2.5a reserve and eligibility mutants were re-run against the unchanged
2.5a-era tests (the 2.5b tests removed from the scratch copy, so they cannot
mask a regression): all killed except the two known equivalents (`threshold_met`
without `list.unique`; the registry's "any quantity per name"). Nine of them
no longer apply to the rewritten `reserve_ref.ak` and one no longer compiles;
their guards are covered by the `RR-*` mutants above and the Config-lookup
mutants of the registry. The Phase 2.4 / 2-H vault mutants were **not** re-run
as a set: their guards are covered by the 2.4 tests, which all still pass, and by
the new vault mutants; a full re-run of that set is an open item.

Tests: 507 before 2.5b, 906 after the vault_ops split. The PS1 run on the clean tree: tessera 906/906, 0 compiler warnings.

### Phase 2.5b, the `vault_ops` split

280 mutants run after the split, in batches of at most 14 (6 parallel scratch
copies, each mutant against the tests that name its guard; survivors re-run
against the whole module). **265 killed, 15 equivalent or redundant.**

* **Every guard that moved into `vault_ops.ak`** (the earlier 2.5b ReportLoss,
  ReportYield, Claim and escrow mutants, re-pointed at the new file) and every
  other guard of the vault, `vault_ops` and `vault_state.ak`: one mutant per
  item of every `and { … }` block (replaced by `True,`): 43 in `vault_ops`, 80 in
  `stsra_vault`, 8 in `vault_state`.
* **The 38 Phase 2.4 / 2-H and 2.5b vault mutants that stayed** (stakes, exits,
  generations, the last-exit sweep, the freeze, genesis), re-run against the
  rewritten vault tests: all killed.
* **The 27 `loss.ak` mutants**, re-run against the tests that now live in
  `vault_ops`: all killed except the two equivalents (below).
* **The new guards:** the ops handler's zero-withdrawal gate; the publish handler
  (every certificate that must be refused: unregister, delegate,
  register-and-delegate, publish-all, and the registration itself refused);
  the vault's binding (own token, withdrawal present, amount 0, redeemer present,
  `vault` field, action tag, credential, fail-open on a missing redeemer); the
  four redeemer-to-tag routes and the tag constants; ops' own freeze read
  (`open_config`, `exits_open`) and committee read.

Five first-run survivors were real test gaps, and each has a test now: a zero
yield that is otherwise correct, and the pinned State (address, reference script,
lovelace, foreign token) on `SetBounds`, on `Claim` and on every stake and exit
(the old F-6 tests that pinned those had moved with the code or covered only one
redeemer). Seven more first-run misses were filter mistakes (a killer test not in
the mutant's filter) and passed on re-run with no new test.

**Equivalent / redundant survivors (15).** Each guard is implied by another one
and is kept as defence in depth.
* *ops `ReportLoss` `loss > 0`* (and the same mutant in the 2.5b set): implied by
  `written_off > 0`.
* *ops Claim, vault Claim Ticket branch and vault `UnlockLong`: `list.length(ins) == 2`*:
  the `expect [x] = filter(ins, != state_in)` that follows already fixes it; the
  Ticket branch's copy is also covered by the State side's run.
* *vault `in_state == s0`* (the ledger passes the UTxO's own datum);
  *`amount > 0`* on a short stake (`deposit_ok` implies it);
  *`list.length(outs) == 2`* on `StakeLong` and `RequestUnstake` (`other_output`
  already needs exactly one other output); *`shares > 0`* on `RequestUnstake`
  (`v >= min_position_value` implies it).
* *`cap > balance` as `>=`* (both give room 0 at equality).
* *`split_loss` index term using `rem` for `rem1`* (the floor clamps the
  difference) and *`class_dead`'s `shares > 0`* (with no shares
  `assets * 1000 < 0` is false).

**Earlier mutants.** The 168 Phase 2.2 / 2.3 / 2.5a reserve and eligibility
mutants (§6, 2.5a) and the 244 first 2.5b mutants (reserve, first-loss, libs) were
run before this split and are unaffected by it: the reserve and first-loss
scripts are unchanged (the reserve's only change is that `Claim` is named in
`vault_state`). The Phase 2.4 / 2-H vault mutant set that the first 2.5b pass
listed as an open item is closed by the re-run above: its guards either moved
(re-pointed, killed) or stayed (re-run, killed).

## 7. NAV datum and token metadata (Phase 2.7 — DESIGN CHECKPOINT, nothing implemented)

Status: **revision 2.** D-40 **decided by the owner on 2026-10-23: option B** (token metadata in
the CIP-26 off-chain registry, no CIP-68 reference NFTs, no change to `reserve.ak` or
`stsra_vault.ak`). D-36 to D-39, D-42 and D-44 await approval. Decisions are numbered [D-36]…
(2.6 ended at D-35).

Two deliverables: a **NAV datum** that publishes the price of sTSRA and the reserve's health in
one place any script can read, and **token metadata** (name, ticker, decimals, logo) so wallets
show TSRA and sTSRA properly.

### 7.0 Constraints and what was measured

* **2.7 adds no bytes to any existing script.** `reserve` (12,308 B), `stsra_vault` (12,652),
  `vault_ops` (11,100), `first_loss` (4,466), `eligibility` (2,365) and the four queue scripts
  (`redeem_queue` 3,128, `queue_flow` 12,436, `queue_admin` 12,704, `queue_short` 11,165) keep
  their bytecode, hashes and sizes (re-built on `main` after PR #16: identical). The live
  preprod-v1 policy ids (`938b32e0…7400` for TSRA) stay valid.
* The only new script is **`nav`**, and only if D-44 says so. Every script ≤ 13,000 B.
* **Measured** (scratch stub, not committed): a `nav` script with the full derivation of §7.2,
  the rate limit of §7.3 and the thread-token mint compiles to **5,884 B**. It omits the genesis
  datum check and `nav_usable` (which is library code for readers), so the final size is
  expected at 6,000–6,800 B, far under 13,000.

### 7.1 [D-36] The NAV is derived on-chain, not posted by the committee

**Recommended: derived and permissionless.** Everything the NAV publishes already lives in a
genuine State, so the `nav` script recomputes the datum from the States (reference inputs,
selected by their thread tokens) and accepts a publish only if the new datum equals the
recomputation. **Anyone** can publish (a keeper, the app, a lender); nobody is trusted for a
number. The only committee input is already in the Supply: `attested_reserve` and `attested_at`
come from the committee's attestation, and the NAV shows them, dated, as such.

*Alternative rejected:* committee-posted and checked against the States: it adds a signing party
and a liveness dependency, and checking "against the States" means recomputing them anyway.

Inputs (all reference inputs, each the one UTxO holding its thread token at its script address):
the vault **State** (`state` token under the vault policy), the reserve **Supply** and **Config**
(`supply`, `config`), and the **first-loss** State (`state` token under the policy named in the
vault State's `first_loss`).

### 7.2 [D-37] What the datum holds

`NavDatum` (all integers; prices in TSRA micro-units per share, i.e. `e6`):

| Field | Source / formula |
|---|---|
| `version` | 1 |
| `short_price_e6` | `fold(State, lo).short_assets * 1e6 / short_shares` (par 1,000,000 if no shares); the sTSRA price |
| `long_price_e6` | the same for the long class (informational: Positions are not tokens) |
| `short_assets`, `short_shares`, `long_assets`, `long_shares` | after `fold` at `lo` (yield vested so far is in) |
| `ticket_escrow` | State |
| `minted_supply`, `attested_reserve`, `mint_cap` | Supply |
| `backing_bps` | `attested_reserve * 10_000 / minted_supply`; 0 if nothing is minted. A reader that wants to haircut TSRA uses this |
| `first_loss_balance` | first-loss State |
| `attested_at`, `attestation_epoch` | Supply (the committee's attestation date) |
| `loss_pending_until`, `paused` | Config |
| `vault_epoch`, `supply_epoch` | State and Supply epochs the datum was derived from |
| `published_at` | the publish transaction's validity **lower bound** `lo` (a time that has certainly passed) |

`fold` is `vault_state.fold` (the vesting step the vault itself uses), so the NAV price is exactly
what a stake or unstake at `lo` would use. Pure formulas live in `lib/tessera/nav.ak` with test
vectors, so the app, `nav` and a lender's own script share one definition.

### 7.3 [D-38] Publishing rules

A **NAV UTxO** at the `nav` script address holds one thread token (one-shot, seed, like the other
States) and the datum. `Publish` spends it and returns it, with:

* the datum equal to the recomputation at `lo`; address pinned, no reference script, value
  unchanged (F-6 pattern);
* the validity window finite and at most **1 hour**; `published_at` never goes backwards;
* **rate limit with an asymmetry:** a publish that **raises or keeps** `short_price_e6` needs
  `lo >= old.published_at + 15 min`; a publish that **lowers** it is always allowed. Good news is
  rate-limited (fewer invalidated reader transactions) and bad news is never held back.

Cost of the single UTxO: a reader that *references* it is invalidated when it is spent between
building and submitting. Hence the 15 minutes; a reader that must be robust can also fall back to
the formula (§7.4, strict mode).

### 7.4 [D-39] Staleness: the rules a reader must apply

A published NAV is **a dated statement**, not a live price. Vesting only ever lifts the price, a
loss lowers it, and a loss cannot land without a prior public freeze (§3a.4: `ReportLoss`
requires `hi < loss_pending_until`), so:

1. The NAV UTxO is the one at the `nav` address holding the `nav` thread token.
2. `reader_upper_bound - published_at <= 24 h` (**`nav_max_age_ms`**, recommended ceiling; a
   lender can choose shorter, never longer).
3. `loss_pending_until <= reader_lower_bound` and `paused == False` in the datum. And, because a
   freeze can open after the last publish, the reader **also references the reserve Config** and
   requires `loss_pending_until <= lo` there (cheap, and it is the authority).
4. `published_at - attested_at <= 7 days` (the reserve's own rule for the attestation age).
5. For TSRA's own value a lender applies `min(1, backing_bps / 10_000)`.
6. *Strict mode (optional):* also reference the vault State and require its `epoch` equal
   `vault_epoch`; if it differs, recompute with the §7.2 formulas instead of trusting the datum.

`lib/tessera/nav.ak` exports `nav_usable(datum, lo, hi, max_age)` implementing 1-5 so the same
check is tested once. Third parties copy it (Aiken libraries cannot be shared across projects),
with the test vectors. The same rules 2-5 apply to a reader that skips the NAV UTxO and computes
the price from the States directly (§7.9, D-44).

### 7.5 [D-40, decided: option B] Token metadata in the CIP-26 registry

**Decision (owner, 2026-10-23).** TSRA and sTSRA metadata go in the CIP-26 off-chain token
registry. There are **no CIP-68 reference NFTs**, no edit to `reserve.ak` or `stsra_vault.ak`,
and no rename of the tokens, so the deployed preprod-v1 policy ids stay valid.

* **TSRA:** subject = `938b32e0…7400` + `54535241`. Submitted as
  `cardano-foundation/metadata-registry-testnet` **PR #2995**, signed with a dedicated metadata
  key, **no `policy` field** (the policy is a Plutus script). Status: submitted, not yet accepted
  or wallet-verified; the owner will update it when the PR merges and a wallet shows the name.
* **sTSRA:** subject = vault policy + `7354535241` ("sTSRA"); to be submitted when the vault is
  deployed (it is not deployed in preprod-v1). A later generation (`sTSRA` + 4-byte generation,
  §3a.6) is a different asset and gets its own registry entry **when it occurs**. The registry is
  off-chain, so this needs no vault logic; this is a point in B's favour over CIP-68, where a
  reference NFT per generation would have meant vault code.
* **Fields:** `name`, `description`, `ticker`, `decimals` (6), `url`, `logo`, from `BRAND`
  (`src/config/brand.ts`). `BRAND` gains a `logo` (an image file: the artwork is an open item).
  The registry's image format and size limits are to be checked against its current rules (not
  verified here).
* **Who can change it, and how:** whoever holds the metadata key signs a new entry and submits a
  PR; the registry maintainers review it. There is **no on-chain role** for the committee. The
  metadata key therefore controls how wallets *display* the tokens (a rename or a logo swap); it
  controls no funds. Trust assumption to record: the key is held offline and its custody is as
  careful as a committee key, because a hostile rename is an impersonation risk for users.
* **Mainnet:** the testnet registry is for Preprod. Mainnet display needs its own submission to the
  mainnet registry at that time.
* **Wallet behaviour is unverified.** Until PR #2995 merges and a wallet shows the name, B is a
  plan, not a result.

*What was not chosen (A, recorded for the record):* editing the genesis of `reserve` and
`stsra_vault` and relabelling the token names would have cost +40 B (`reserve` 12,348), +63 B
(`stsra_vault` 12,715), +12 B (`vault_ops`), +8 B (`first_loss`), re-hashed five scripts and the
four queue scripts, and orphaned the live preprod-v1 TSRA policy `938b32e0…7400` with its Config and
Supply UTxOs (a re-bootstrap with a new seed). Measured in a scratch copy, never committed.

### 7.6 [D-42] BRAND is the single source, checked in CI

The registry entries are generated from `BRAND` by `scripts/build-token-registry.mjs` into
committed files `contracts/tessera/registry/<unit>.json` (unsigned bodies); a check
`scripts/verify-token-registry.mjs` (wired into `verify-vault-hash` / the PS1) fails if a committed
body differs from `BRAND` (description, ticker, decimals, logo, name). A rename of the stablecoin
stays a one-file change plus a re-signed submission. The signature is made offline and is not in
the repository.

### 7.7 Scripts and sizes

| Script | Purpose | Size |
|---|---|---:|
| `nav` (spend + mint, params `seed, reserve, vault`) | thread token, `Publish`; recomputation of §7.2 | **5,884 B measured (stub)**; final 6,000–6,800 est. |
| `lib/tessera/nav.ak` | formulas and `nav_usable` (compiled into `nav` where used) | – |
| ~~`token_metadata`~~ | withdrawn with CIP-68 (D-41) | – |

Existing scripts: **unchanged, 0 bytes added.** First implementation step: compile the real stub
of `nav` and report its size before writing the rest.

### 7.8 [D-44] Is a `nav` script needed at all?

**Alternative: no `nav` script.** The States are authoritative and never stale; a reader can
reference the vault State, the Supply, the Config and the first-loss State and compute the price with
the §7.2 formulas, applying rules 2-5 of §7.4. That ships `lib/tessera/nav.ak`, its tests and a
documented procedure and adds no script and no UTxO to contend on.

**What `nav` adds:** (1) a **stable, versioned interface**: an integrator reads one small datum and
does not have to decode the 19-field `VaultState`, whose schema has changed between phases
(2.4, 2.5b) and may change again; (2) one input instead of four; (3) a dated record
(`published_at`) readers can enforce staleness on. **What it costs:** one more script and UTxO to
deploy and keep alive (a keeper publishes at least daily), and a datum that is always at least slightly
stale.

**Recommended:** build `nav` (5.9 KB, no change to any other script), because the schema-stability point
is real for lenders and DEXs; ship `lib/tessera/nav.ak` and the direct-read procedure first in the same
phase as the fallback. **If no integrator has asked for a UTxO oracle, defer the script and ship only the
library and the procedure** — that is an acceptable 2.7. Your call.

### 7.9 Tests, mutation plan, budget

* **`lib/tessera/nav.ak`:** `short_price_e6` against `exchange.exchange_rate_e6` over a deterministic
  spread (as in 2.6), including zero shares (par), a dead class, mid-vesting `fold`, zero minted
  (`backing_bps` 0); `nav_usable` rules 1-5 at their boundaries (24 h, 7 d), the `backing_bps` haircut.
* **`nav` Publish (if built):** accepted at `lo` with a mid-vesting State; every datum field wrong by
  one unit refused (one test per field); stale or planted States (no thread token) fail; two vault
  States; a State from another vault policy; rate limit exactly at 15 min and one millisecond early;
  a price **drop** accepted immediately; a rise refused early; `published_at` going backwards; window of
  1 h and 1 h + 1 ms; thread token conserved, address pinned, reference script, extra value; one-shot
  genesis (seed).
* **BRAND check:** the script fails on a changed description, ticker, decimals, name or logo.
* **Mutants:** one per item of every `and { }` block of `nav` and `lib/tessera/nav.ak`, plus the
  constants (15 min, 1 h, 24 h, 7 d), the asymmetry (`lower` vs `raise`), the `fold` time (`lo`, not `hi`),
  the `backing_bps` division and each datum field's source. Foreground, batches ≤ 21 with 7 workers, as
  in 2.6.
* **Budget (memory/CPU, target):** `Publish` < 15% (four reference inputs, one `fold`, one datum
  comparison; to be measured); a reader's `nav_usable` < 1%.

### 7.10 Decisions to confirm

| # | Decision | Recommended | Status |
|---|---|---|---|
| D-36 | NAV derived on-chain from the States, permissionless publish | yes | awaiting approval |
| D-37 | The datum of §7.2 (incl. `backing_bps`, `loss_pending_until`, `paused`, epochs) | yes | awaiting approval |
| D-38 | One NAV UTxO; 15-min limit on rises, none on drops; 1-h window | yes | awaiting approval |
| D-39 | Reader rules 1-5 (24 h max age, freeze via Config, 7-d attestation, backing haircut) | yes | awaiting approval, and any lender partner |
| D-40 | Token metadata via the CIP-26 registry; no CIP-68, no change to `reserve`/`stsra_vault` | **option B** | **decided (owner, 2026-10-23)**; registry PR #2995 submitted, not yet accepted or wallet-verified |
| D-41 | `token_metadata` script (CIP-68 reference NFTs) | – | **withdrawn** with option A |
| D-42 | BRAND is the source; CI compares the committed registry entry bodies to it | yes | awaiting approval |
| D-43 | CIP-68 reference for sTSRA generation 0 only | – | **withdrawn**: the registry takes an entry per generation when it occurs |
| D-44 | Build the `nav` script, or ship only the library and the direct-read procedure | build it (library first); defer if no integrator needs a UTxO oracle | **your call** |

**Open items for you:** the logo artwork (an image for the registry and `BRAND.logo`); whether any lender
partner needs a shorter staleness than 24 h (D-39 is a ceiling); counsel's view on a description that says
"1 TSRA = 1 USD" in a registry entry that wallets display; who holds the metadata key.

**Risks.** (1) A NAV is a past statement: rules 2-4 are what make it safe, and a reader that skips them can
be fooled by a stale high price during a loss. (2) The single NAV UTxO can be spent by a keeper at an
inconvenient moment: the 15-minute limit bounds it and the formula fallback removes it. (3) Under B, wallet
display depends on the registry accepting a Plutus-policy entry with no `policy` field and on the wallet reading
it; neither is verified yet, and the on-chain tokens work regardless. (4) The metadata key can rename the
tokens as shown in wallets; custody is the control.
