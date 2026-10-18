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
validators/state_nft.ak    One-shot NFT marking the genuine Reserve State
DESIGN.md                  Design draft + decisions
SPEC.md                    State transitions and invariants (to be filled)
```

## Planned validators

| File | Role |
|---|---|
| `validators/reserve.ak` | **Written and tested** (`aiken check`, mutation-tested, SPEC.md §6). Reserve State + TSRA policy |
| `validators/state_nft.ak` | **Written and tested.** One-shot State NFT |
| `validators/stessera_vault.ak` | Yield vault; `ReportYield` requires delivered funds |
| `validators/redeem_queue.ak` | Request UTxOs, daily buckets, permissionless settlement |

## Commands

```bash
cd contracts/tessera
aiken check     # unit tests
aiken build     # writes plutus.json; commit it, CI will diff it
```

## Not yet done

* The `ReserveState` datum is provisional until counsel answers (SPEC.md §1);
  committee rotation and on-chain genesis validation are Phase 2 must-haves.
* No `plutus.json` and no blueprint pin in
  `scripts/verify-vault-hash.mjs`.
* No CI job in `.github/workflows/contracts.yml` (add together with the first
  validator, mirroring the `verify-susdr-blueprint` job).
* `aiken fmt --check` fails on all four `.ak` files (it already did before the
  TSRA rename); formatting is left for one mechanical commit after the rebase.
