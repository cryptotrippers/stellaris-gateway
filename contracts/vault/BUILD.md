# Vault validator — deterministic, parameterized build

Stage 3 validator blueprint pinned in `src/lib/vault.ts`.

## Toolchain

- Aiken **v1.1.23** (matches `aiken.toml`)
- stdlib **v2.2.0** (see `aiken.toml`)

## Parameterization

`validator vault(_version: Int, _asset_id: ByteArray)` takes two compile-time
parameters. `aiken build` emits the **unapplied blueprint** — the CBOR still
has the free `version` and `asset_id` slots.

The active applied script uses `version = 2` and is derived on the JS side with
Lucid's `applyParamsToScript`. Each marketplace asset receives its own script
hash and address. The Stage 3 validator also enforces owner-preserving datum
continuity for partial withdrawals.

## Expected artifacts

After `aiken build`, `contracts/vault/plutus.json` MUST contain the
**unapplied blueprint hash** pinned in `VAULT_BLUEPRINT_HASH` in
`src/lib/vault.ts`. `scripts/verify-vault-hash.mjs` fails the build if it
drifts.

`aiken address` is **not** meaningful for a parameterized validator — it
would produce an address for the unapplied script, which is never deployed.
Use the JS-derived address logged by the app instead.

## Build steps

```bash
cd contracts/vault
aiken check      # 10 unit tests should pass
aiken build      # regenerates plutus.json (unapplied blueprint)
cd ../..
node scripts/verify-vault-hash.mjs
```

The Stage 3 blueprint is pinned as:

- Hash: `b582793a5e9bb3993ed68876ee017165808efb672e0d333e83975194`
- Applied version: `2`

The verify script fails if the unapplied blueprint hash or CBOR drifts from
`VAULT_BLUEPRINT_HASH` / `VAULT_BLUEPRINT_CBOR` in `src/lib/vault.ts`. Never
bump `VAULT_VERSION` without first withdrawing every live UTxO at the old
applied address.

## CI

`.github/workflows/contracts.yml` runs on every push and pull request:

1. installs the Aiken version pinned in `aiken.toml`;
2. runs `aiken check` (all validator + share-math tests);
3. runs `aiken build` to regenerate `plutus.json`;
4. runs `node scripts/verify-vault-hash.mjs --strict`.

Strict mode fails when `plutus.json` is missing instead of skipping, so CI can
never pass silently without actually comparing the compiled validators. Both
blueprints are checked by validator title:

- `vault.vault.spend` → `VAULT_BLUEPRINT_HASH` / `VAULT_BLUEPRINT_CBOR` in `src/lib/vault.ts`
- `yield_vault.yield_vault.spend` → `YIELD_BLUEPRINT_HASH` / `YIELD_BLUEPRINT_CBOR` in `src/lib/yield-vault.ts`

Locally: `bun run verify:contracts` (skips if you haven't built) or
`bun run verify:contracts:strict`.

## Yield vault blueprint (Stage 6 + security scan close-out)

The security-scan fixes (AUDIT.md V-01, V-03, V-05) changed `yield_vault.ak`,
so its unapplied blueprint hash moved again:

- Previous: `e34414de8570158a207577dee9d1e77f6788154bff5057168f73e696`
- **Current: `e79ee0c4c5d5e0e29d095d616046cbcb9554ab6ba64b428236e11875`**
  (pinned in `YIELD_BLUEPRINT_HASH`, `src/lib/yield-vault.ts`)
- `receipt.receipt.mint`: `ae6bf02ede5ed0aa23d619400208fca63f4dba372a69b7ae7e01862d` (unchanged)
- `vault.vault.spend`: `b582793a5e9bb3993ed68876ee017165808efb672e0d333e83975194` (unchanged)

Every applied yield-vault address therefore changes and each asset must be
re-bootstrapped. This was safe to do because nothing was bootstrapped on the
previous hash. `aiken check` runs 101 tests.
