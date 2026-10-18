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
validators/reserve.ak      Reserve State + TSRA mint policy (one script)
lib/stellaris/thread.ak    State-thread token helpers (verbatim copy of the vaults' module)
DESIGN.md                  Design draft + decisions
SPEC.md                    State transitions and invariants (to be filled)
```

## Planned validators

| File | Role |
|---|---|
| `validators/reserve.ak` | **Written and tested** (`aiken check`, mutation-tested, SPEC.md §6). Reserve State + TSRA policy |
| `validators/stessera_vault.ak` | Yield vault; `ReportYield` requires delivered funds |
| `validators/redeem_queue.ak` | Request UTxOs, daily buckets, permissionless settlement |

## Commands

```bash
cd contracts/tessera
aiken check     # unit tests
aiken build     # writes plutus.json; commit it, CI will diff it
```

## Not yet done

* The `ReserveState` datum is provisional until counsel answers (SPEC.md §1).
  Committee rotation and on-chain genesis validation landed in Phase 2.2.
* `aiken fmt --check` fails on the `.ak` files (it already did before the TSRA
  rename); formatting is left for one mechanical commit.

`plutus.json` is committed, its hash is pinned in `src/lib/tessera-blueprint.ts`
and checked by `scripts/verify-vault-hash.mjs`, and CI runs
`verify-tessera-blueprint`.
