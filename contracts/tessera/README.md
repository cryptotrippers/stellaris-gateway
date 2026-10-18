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
lib/tessera/reserve_state.ak  ReserveState datum + committee rules (shared)
lib/tessera/eligibility.ak The one eligibility check, eligible(tx, policy, holder)
lib/tessera/reserve_ref.ak Genuine Reserve State lookup (reference input)
lib/tessera/vault_state.ak sTSRA vault datum, bounds, yield split
validators/reserve.ak      Reserve State + TSRA mint policy (one script)
validators/eligibility.ak  Eligibility-token policy + registry (allowlist)
validators/stsra_vault.ak  sTSRA vault: State, Positions, Tickets + sTSRA policy
lib/stellaris/thread.ak    State-thread token helpers (verbatim copy of the vaults' module)
DESIGN.md                  Design draft + decisions
SPEC.md                    State transitions and invariants (to be filled)
```

## Planned validators

| File | Role |
|---|---|
| `validators/reserve.ak` | **Written and tested** (`aiken check`, mutation-tested, SPEC.md §6). Reserve State + TSRA policy |
| `validators/eligibility.ak` | **Written and tested** (Phase 2.3, SPEC.md §1a). Allowlist tokens, committee-issued and revocable |
| `validators/stsra_vault.ak` | **Written and tested** (Phase 2.4, SPEC.md §3). Two-tier staking vault; `ReportYield` requires delivered funds |
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
