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
