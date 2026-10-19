# Tessera (TSRA)

Stellaris's own reserve-backed stablecoin rail on Cardano. **Independent of
`contracts/susdr-vault`**: no shared names, hashes, token identifiers or
dependencies. See `DESIGN.md` for the design and the open decisions.

**Status: scaffold.** Preprod only. Nothing here is audited or deployed, and
mainnet stays gated by `NETWORK.md`.

## Layout

```
aiken.toml                 Aiken project (plutus v3, stdlib v2.2.0)
lib/tessera/exchange.ak    Share-price math for sTessera (ported, renamed)
lib/tessera/rules.ak       Reserve-gate rules (caps, freshness, windows) + tests
lib/tessera/reserve_state.ak  ConfigState / SupplyState datums + committee rules (shared)
lib/tessera/reserve_threads.ak  The `config` and `supply` thread-token names
lib/tessera/eligibility.ak The one eligibility check, eligible(tx, policy, holder)
lib/tessera/reserve_ref.ak Genuine Reserve Config / Supply lookups (reference and spent)
lib/tessera/vault_state.ak sTSRA vault datum, redeemer, bounds, yield split, ticket_payout
lib/tessera/loss.ak        ReportLoss waterfall arithmetic (Phase 2.5b)
lib/tessera/first_loss_state.ak  First-loss State datum and lookups
lib/tessera/loss_fixture.ak  Worst-case ReportLoss / Claim transactions for the budget tests
validators/reserve.ak      Reserve Config + Supply + TSRA mint policy (one script)
validators/eligibility.ak  Eligibility-token policy + registry (allowlist)
validators/stsra_vault.ak  sTSRA vault: State, Positions, Tickets + sTSRA policy
validators/first_loss.ak   First-loss reserve State (Phase 2.5b)
lib/stellaris/thread.ak    State-thread token helpers (verbatim copy of the vaults' module)
DESIGN.md                  Design draft + decisions
SPEC.md                    State transitions and invariants (to be filled)
```

## Planned validators

| File | Role |
|---|---|
| `validators/reserve.ak` | **Written and tested** (`aiken check`, mutation-tested, SPEC.md §6). Reserve Config + Supply (Phase 2.5a split) + TSRA policy; the loss path (`OpenLoss`, `CancelLoss`, `LossBurn`, `SetVault`, `VaultClaimBurn`, Phase 2.5b) |
| `validators/eligibility.ak` | **Written and tested** (Phase 2.3, SPEC.md §1a). Allowlist tokens, committee-issued and revocable |
| `validators/stsra_vault.ak` | **Written and tested** (Phase 2.4, SPEC.md §3). Two-tier staking vault; `ReportYield` requires delivered funds; `ReportLoss`, the loss freeze and class generations (2.5b) |
| `validators/first_loss.ak` | **Written and tested** (Phase 2.5b, SPEC.md §3a). TSRA that exists only to be burned against a loss; `Deposit` / `Draw` |
| `validators/redeem_queue.ak` | Request UTxOs, daily buckets, permissionless settlement |

## Commands

```bash
cd contracts/tessera
aiken check     # unit tests
aiken build     # writes plutus.json; commit it, CI will diff it
```

## Not yet done

* The `ConfigState` / `SupplyState` datums are provisional until counsel answers (SPEC.md §1).
  Committee rotation and on-chain genesis validation landed in Phase 2.2.
* `aiken fmt --check` fails on the `.ak` files (it already did before the TSRA
  rename); formatting is left for one mechanical commit.

`plutus.json` is committed, its hash is pinned in `src/lib/tessera-blueprint.ts`
and checked by `scripts/verify-vault-hash.mjs`, and CI runs
`verify-tessera-blueprint`.
