# Tessera (TSR)

Stellaris's own reserve-backed stablecoin rail on Cardano. **Independent of
`contracts/susdr-vault`**: no shared names, hashes, token identifiers or
dependencies. See `DESIGN.md` for the design and the open decisions.

**Status: scaffold.** Preprod only. Nothing here is audited or deployed, and
mainnet stays gated by `NETWORK.md`.

## Layout

```
aiken.toml                 Aiken project (plutus v3, stdlib v2.2.0)
lib/tessera/exchange.ak    Share-price math for sTessera (ported, renamed)
validators/                (empty) reserve, tessera policy, vault, queue
DESIGN.md                  Design draft + decisions
SPEC.md                    State transitions and invariants (to be filled)
```

## Planned validators

| File | Role |
|---|---|
| `validators/reserve.ak` | Reserve State UTxO: attested reserve, mint cap, committee |
| `validators/tessera.ak` | TSR mint/burn policy, bound to the Reserve State |
| `validators/stessera_vault.ak` | Yield vault; `ReportYield` requires delivered funds |
| `validators/redeem_queue.ak` | Request UTxOs, daily buckets, permissionless settlement |

## Commands

```bash
cd contracts/tessera
aiken check     # unit tests
aiken build     # writes plutus.json; commit it, CI will diff it
```

## Not yet done

* No validators, so no `plutus.json` and no blueprint pin in
  `scripts/verify-vault-hash.mjs`.
* No CI job in `.github/workflows/contracts.yml` (add together with the first
  validator, mirroring the `verify-susdr-blueprint` job).
* The code in `lib/tessera/exchange.ak` was ported mechanically from the
  existing, tested sUSDr math but has not been compiled in this environment
  (no `aiken` binary available); run `aiken check` first.
