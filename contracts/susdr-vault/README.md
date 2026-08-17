# sUSDr — stablecoin yield vault (Cardano-first, EVM secondary)

**⚠️ Read this first — naming and strategy.** "USDr"/"sUSDr" are RealFi's
product names. This code is a **Preprod stand-in and reference
implementation** built so the vault mechanics can be developed and tested
before RealFi's own token identifiers are available — it is *not* a
competing deployment, and it must not ship to mainnet under these names.
Stellaris's strategy is to **integrate** RealFi's real sUSDr (see the
TRANCHE.md `susdr` backing mode), not to reimplement it. Rename before any
public testnet use (e.g. `tUSD-demo`/`stUSD-demo`).

Status: **compiled and tested** (Aiken v1.1.23, 40/40 checks, 0 warnings,
blueprint built). The Solidity version is written to OZ v5 conventions but
has **not** been compiled here — run it through Foundry before use.

## Layout

```
aiken.toml                 Aiken project (plutus v3, stdlib v2.2.0)
lib/susdr/exchange.ak      Pure exchange-rate math, 15 unit tests
validators/usdr.ak         Test stablecoin policy (admin mint/burn), 3 tests
validators/susdr_vault.ak  The vault: spend + mint handlers, 22 tx-level tests
plutus.json                Built blueprint (susdr_vault hash ca69e325…)
evm/src/USDr.sol           ERC20 stablecoin (secondary)
evm/src/sUSDr.sol          ERC-4626 vault (secondary)
```

## Architecture — how the "real yield" model maps on-chain

Both implementations share one accounting model, chosen deliberately so the
two chains produce identical exchange-rate curves for identical events:

- **Share-price appreciation, never rebasing.** sUSDr balances are static;
  the exchange rate (USDr per sUSDr, starting 1:1) rises when yield lands.
- **Yield is reported, not generated.** Capital works off-chain (RWA,
  lending, liquidity, treasury). Operators/oracles periodically report
  harvested yield *by actually depositing the USDr* in the same
  transaction. On Cardano this is enforced structurally: `total_assets`
  must equal the USDr physically locked at the script on every transition
  (`state_value_matches`), so a report that doesn't deliver the money
  cannot validate. On EVM, `totalAssets()` is balance + `deployedAssets`,
  and `reportYield` pulls the USDr in via `transferFrom`.
- **Fee on yield only, capped 20%, settled by dilution.** Zero yield ⇒
  zero fee, ever. The fee mints treasury shares rather than removing
  assets, so principal is never touched and the depositor-visible rate
  moves by exactly net yield.
- **Anti-manipulation on reports.** Cardano: M-of-N committee signatures +
  a mandatory finite validity lower bound (time-anchored, same rule as the
  Stellaris ADA vault's fee anchoring). EVM: `ORACLE_ROLE` (intended for a
  multisig/timelock) + a minimum interval between reports.
- **Bearer redemption.** Burning sUSDr *is* the authorization — whoever
  holds it can redeem. (Contrast with the Stellaris ADA vault's V-04
  proof-of-claim receipts; here the token genuinely is the claim, which is
  the correct model for a stablecoin wrapper.)
- **Depositors can never redeem against treasury shares** (explicitly
  bounded on Cardano; on EVM the treasury holds real shares so the
  question doesn't arise).

## Key eUTxO-specific properties (why the Cardano version is primary)

1. **Accounting cannot drift from reality** — the validator re-derives the
   USDr held at the script every transition instead of trusting stored
   bookkeeping. An EVM vault has to trust its own storage.
2. **Token supply is bound to share supply structurally** — the same
   script is both the spending validator and the sUSDr minting policy;
   minting without a State transition is impossible, and the transition
   enforces the exact quantity.
3. **No reentrancy class at all**, and the double-satisfaction class is
   closed by requiring exactly one State UTxO on *both* inputs and outputs
   (the V-01 lesson from the Stellaris audit, applied from day one — with
   its regression test, `two_state_inputs_are_rejected`).
4. **Foreign-token griefing is blocked** — the State output may hold only
   ADA + USDr, so an attacker can't attach junk tokens to inflate min-ADA.

## Deployment notes (Cardano / Preprod)

1. `aiken build`; apply `usdr.ak` with the issuer PKH, mint test USDr.
2. Apply `susdr_vault.ak` with a version integer; the applied hash is both
   the vault address and the sUSDr policy id.
3. Bootstrap the State UTxO: datum carries the USDr asset id, committee,
   threshold, fee bps (≤2000), treasury PKH, epoch 0, zero supply.
4. First deposit ≥10 USDr (bootstrap floor).
5. Reference-script publication strongly recommended (9.2KB validator) —
   follow the Stellaris REFSCRIPTS.md pattern.

EVM constructor example: `sUSDr(usdrToken, adminMultisig, treasuryAddr, 1000)`
(10% fee on yield). Grant `ORACLE_ROLE` to the yield-reporting multisig,
`MANAGER_ROLE` to the capital-routing multisig; keep `DEFAULT_ADMIN_ROLE`
behind a timelock. Upgradeability deliberately omitted — for a vault
holding a stablecoin, an immutable contract + migration path is easier to
audit than UUPS; add a proxy only with a compelling reason.

## Test coverage (all passing)

Math (15): bootstrap 1:1 & floor, rate-at-par, yield-raises-rate,
second-depositor-pays-accrued-rate, floor rounding both directions,
zero-yield-zero-fee, fee cap, fee-on-yield-not-assets, fee-shares redeem
to fee value ±1 unit, position bounds, dust-strand rejection, full close.

Vault tx-level (22): honest deposit/redeem/report/claim paths, plus
adversarial: minting extra sUSDr, claiming assets that never arrived
(deposit AND yield variants), redeeming without burning, over-redeeming vs
rate, redeeming treasury shares, skipping the fee, sub-threshold and
unbounded-validity reports, fee above cap, committee swap mid-deposit,
two-State collapse (V-01), foreign-token grief, epoch replay, treasury
misdirection, unanchored sUSDr minting.

Foundry test ideas for the EVM side: fuzz deposit/redeem round-trips never
profit; first-depositor inflation with virtual shares + floor; report
cadence enforcement; fee-share dilution exactness vs the Cardano vectors
above (they should match to the unit).
