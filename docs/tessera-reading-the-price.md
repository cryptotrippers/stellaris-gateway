# Reading the Tessera price

For wallets, DEXs and lenders (Liqwid-style) that need the price of **sTSRA** (and the health of
**TSRA**) safely. Specification: `contracts/tessera/SPEC.md` §7. Formulas and tests:
`contracts/tessera/lib/tessera/nav.ak` (copy it, with its test vectors, into your own Aiken
project; Aiken libraries cannot be shared across projects). Drop the `tessera/loss_fixture` import
and the `tests` section if you only want the functions.

There is **no published NAV UTxO yet** (the `nav` script, SPEC §7.8, is built when an integrator
asks). Until then you read the States directly. They are authoritative and never stale.

## 1. Which UTxOs to reference

Reference (do not spend) these four. Each is **the one UTxO holding its thread token at its script
address, with an inline datum of the expected kind**. Select by token, never by datum shape, address
alone, or position in a list: anyone can pay a look-alike datum to a script address, and only the real
UTxO carries the token.

| State | Policy (script hash) | Asset name (hex) | Datum |
|---|---|---|---|
| Vault State | the sTSRA vault | `state` (`7374617465`) | `VaultDatum.StateDatum(VaultState)` |
| Reserve Supply | the reserve | `supply` (`737570706c79`) | `ReserveDatum.SupplyDatum(SupplyState)` |
| Reserve Config | the reserve | `config` (`636f6e666967`) | `ReserveDatum.ConfigDatum(ConfigState)` |
| First-loss State | `VaultState.first_loss` | `state` | `FirstLossState` |

Fail closed: zero or two matching UTxOs, a wrong address, a missing or wrong datum, all mean "no
price". The script hashes of a deployment are in its `deployments/<label>.json`; the **applied**
hash is the policy id (the blueprint hash in `src/lib/tessera-blueprint.ts` is the *unapplied* one).

## 2. The formulas (all integers, no floats)

Let `lo`, `hi` be your transaction's validity bounds, and `V = fold(VaultState, lo)` (the vault's
own vesting step: yield reported but not yet vested is added to `short_assets`/`long_assets` linearly
between `vest_from` and `vest_until`; before `vest_from` nothing, after `vest_until` everything).

```
short_price_e6 = V.short_shares == 0 ? 1_000_000 : V.short_assets * 1_000_000 / V.short_shares
long_price_e6  = (the same for the long class; informational, Positions are not tokens)
backing_bps    = minted_supply == 0 ? 0 : attested_reserve * 10_000 / minted_supply
sTSRA value of `n` shares, in TSRA units = n * short_price_e6 / 1_000_000   (rounds down)
```

`lib/tessera/nav.ak` exports `derive(vault, supply, config, first_loss, lo)` returning the whole
`NavDatum` (also `ticket_escrow`, `mint_cap`, `first_loss_balance`, `attested_at`, the epochs) and
`short_value`. Division rounds down everywhere, so the values never overstate.

## 3. The rules a reader must apply (SPEC §7.4)

A price is only as good as the checks around it. Apply all of these:

1. **Age.** If you use a published NAV datum, `hi - published_at <= max_age`, with `max_age` at most
   **24 hours** (a lender may choose shorter). Reading the States directly has no age: they are current.
2. **Freeze and pause.** Require `Config.loss_pending_until <= lo` and `Config.paused == False`. A loss
   cannot be booked without a prior public freeze of up to 7 days (SPEC §3a.4), so refusing during a
   freeze removes the stale-high-price risk. Read the **Config** for this even when you read a published
   datum: it is the authority.
3. **Attestation age.** `lo - Supply.attested_at <= 7 days` (the reserve's own limit for minting). An older
   attestation means the committee has not confirmed the reserve; do not extend credit against it.
4. **TSRA is not always worth one dollar.** Apply `min(10_000, backing_bps) / 10_000` to the value of TSRA
   itself (`haircut_value`). `backing_bps` below 10,000 means the attested reserve is below the supply.
5. **A published NAV is a past statement.** If you use one, optionally also reference the vault State and
   Supply and require `vault_epoch == VaultState.epoch` and `supply_epoch == Supply.epoch` (strict mode);
   if they differ, recompute with the formulas above instead of trusting the datum.

`nav_usable(datum, config_loss_pending_until, lo, hi, max_age)` implements the age, freeze, pause and
attestation rules; `haircut_bps`, `haircut_value` and `strict_matches` implement the rest.

## 4. Behaviour to expect

* **Vesting only lifts the price**, continuously, over the 7 days after yield is reported. A price read a
  little earlier is slightly low: conservative for collateral.
* **A loss lowers the price at once**, and only after a freeze has been public. During a freeze, refuse.
* **The price is TSRA per sTSRA**, not dollars. TSRA targets 1 USD (see rule 4).
* **sTSRA has generations.** After a class wipe-out the token name gains a 4-byte generation suffix
  (SPEC §3a.6); a later generation is a different asset. Price it from the same State's `short_*` fields,
  which belong to the current generation.
* **Contention.** The vault State is spent by every stake, unstake and yield report. A transaction that
  *references* it fails if it is spent between building and submitting; rebuild and resubmit.

## 5. Test vectors

From `nav.ak` (shares / assets -> price):

| Case | Short price (e6) |
|---|---:|
| 100 / 100 (par) | 1,000,000 |
| 100 / 105 | 1,050,000 |
| 3 / 4 (rounds down) | 1,333,333 |
| 0 / 0 (no shares) | 1,000,000 |
| 100 / 0 (dead class) | 0 |
| 1,000 / 600 (after a loss) | 600,000 |
| 1,000,000,000 / 1,000,000,000 plus 40,000,000 vesting over 7 days, at half time | 1,020,000 |

`backing_bps`: attested 10,000 over minted 10,000 -> 10,000; 9,999 -> 9,999; 15,000 -> 15,000 (the
haircut caps at 10,000); nothing minted -> 0.

Boundaries (all in `nav.ak` tests): age exactly 24 h accepted and one millisecond more refused;
attestation exactly 7 days old at publication accepted, one millisecond more refused; a freeze ending at
exactly `lo` accepted, one millisecond later refused; paused refused; a `max_age` above 24 h refused.
