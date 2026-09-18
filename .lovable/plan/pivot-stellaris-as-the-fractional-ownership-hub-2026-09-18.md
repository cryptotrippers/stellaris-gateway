# Pivot: Stellaris as the fractional ownership hub

## The read on the market

RealFi as a yield story asks a retail user to trust an APY they cannot verify. Fractional
ownership asks a much simpler question: *what do I own a piece of, and can I sell it?*
That is the pivot — Stellaris stops selling yield and starts selling **verifiable fractions
of real assets**, denominated in ADA, with freely transferable share tokens.

On stablecoins: the honest finding is that no Cardano-native stablecoin currently carries
the depth to make a fractional market work as the base denomination — USDM and iUSD trade
thin, bridged USDC/USDT add custody and bridge risk on top of an already novel product.
So the build is **ADA-first**, with the deposit-denomination plumbing already in place
(the deposit-asset registry and the unit-parameterised validator) so a stablecoin can be
switched on later by registering a row, not by rewriting contracts.

## What Stellaris becomes

A hub with three sides:

- **Owners** hold fractions of a listed asset. Each fraction is a real Cardano native
  token in their own wallet — sellable, sendable, visible in any wallet.
- **Issuers** list an asset, define how many fractions exist, and report against it.
- **The hub** runs the rails: listing, the fractionalisation contract, the register of
  who owns what, and the public proof that fractions match the asset.

Revenue stays the same shape as today — a listing fee to come on chain, and a fee taken
in fractions at mint and redemption — but it now attaches to ownership, not to a
promised return.

## 1. The fractional contract (new)

New Aiken project `contracts/fraction-vault/`, built from the audited patterns already in
`yield_vault.ak` rather than from scratch:

- **Offering datum** — asset id, total fractions, fractions sold, price per fraction in
  the deposit unit, issuer key, committee + threshold, status (open / closed / redeeming),
  mint and redeem fee rates with hard caps.
- **`fraction` mint policy** — parameterised by the applied offering script hash and the
  asset id, so a fraction of asset A can never be minted against asset B. This is the
  existing `receipt.ak` binding pattern, but the token is now the product, not a mirror:
  it is **fully transferable**, with no contract-side transfer restriction.
- **Redeemers** — `Buy` (pay the unit, receive fractions), `Redeem` (burn fractions,
  receive the pro-rata payout when the offering is in redeeming state), `Distribute`
  (issuer pays income into the offering, split pro-rata to holders on redeem),
  `SetStatus` and `SetFees` (committee M-of-N, both validity bounds per V-05),
  `ClaimFee` (committee, pays the treasury only).
- Invariants preserved from the audit: sole state UTxO, single-input/single-output
  continuity, bound mint policy, fee caps, pause semantics, both validity bounds on every
  time-sensitive branch.
- Full Aiken test suite, `aiken build`, blueprint hash pinned in
  `src/lib/fraction-vault.ts`, `scripts/verify-vault-hash.mjs` and `script-identity.ts`
  extended so CI fails on drift.

## 2. Deprecating the yield vaults

The ADA yield vault (v3/v4) is retired, not deleted, because real depositor funds sit in
it on Preprod:

- Vaults move to a **wind-down** state in the operator console: withdraw stays open,
  deposit is closed, and the project page shows a plain "this vault is closing — withdraw
  your balance" notice.
- `/yield`, the accelerator pipeline, and the sUSDr surfaces come out of the main
  navigation and move behind an archive page.
- No on-chain migration. Existing holders withdraw and, if they want, buy fractions in
  the new offering. Anything else would move other people's money for them.

## 3. The hub, rebuilt

- `/` becomes the fractional pitch: what you can own a piece of, from how little, and
  what proves it. Live offerings, fractions remaining, price per fraction.
- `/marketplace` → **offerings**: each listing shows total fractions, sold, price, the
  issuer, and the on-chain policy id of the fraction token.
- `/marketplace/$id` → buy flow in whole fractions, with the fee split shown before
  signing, and the minted fraction token confirmed by tx hash after.
- New **`/portfolio`**: the fractions the connected wallet actually holds, read from the
  chain by policy id — not from our database.
- New **`/register/$id`**: the public holder register for an offering, derived from chain
  data, so anyone can verify fractions outstanding equals fractions minted.
- Governance stays, scoped to fee changes and offering status.

## 4. Data

One migration, additive:

- `offerings` — asset id, script address, fraction policy id, total fractions, price per
  fraction, unit (FK to `deposit_assets`), status, issuer, mint/redeem fee bps.
- `fraction_events` — verified mint/redeem/distribution rows keyed by tx hash, written
  server-side only after Blockfrost confirms the transaction.
- Public read on both, writes admin/server only, GRANTs in the same migration.
- Existing tables stay untouched; the vault tables just stop growing.

## 5. Preprod exercise

Deploy the fraction vault on Preprod, list one real offering (ph-solar-01 re-listed as
fractions), then run a full cycle with a real wallet: buy fractions, send fractions to a
second wallet to prove transferability, distribute income, redeem, claim the treasury fee.
Every step verified against the chain, not asserted.

## Technical notes

- New Aiken package alongside the existing ones; `plutus.json` committed and covered by
  the CI blueprint-drift job.
- Fraction quantities are integers on chain — no fractional-of-a-fraction rounding.
- Lucid stays dynamically imported in browser-only paths, per the existing convention.
- The mainnet guard in `src/lib/network.ts` is untouched; this ships Preprod-only.

## Suggested order

1. Fraction vault validator + mint policy + tests + pinned hashes + CI.
2. Migration and offering registry.
3. Buy / transfer / redeem builders and the offering page.
4. Hub rebuild: home, offerings, portfolio, public register.
5. Yield-vault wind-down and navigation cleanup.
6. Preprod exercise cycle.
