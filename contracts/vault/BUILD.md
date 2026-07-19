# Vault validator — deterministic, parameterized build

Phase 1 script pinned in `src/lib/vault.ts`.

## Toolchain

- Aiken **v1.1.23** (matches `aiken.toml`)
- stdlib **v2.2.0** (see `aiken.toml`)

## Parameterization

`validator vault(_version: Int)` takes one compile-time parameter. `aiken build`
emits the **unapplied** blueprint — the CBOR still has the free `version` slot.

The applied script (with `version = 1`) is derived on the JS side at module
init using Lucid's `applyParamsToScript`. Bumping `VAULT_VERSION` in
`src/lib/vault.ts` mints a fresh script hash / address without editing this
file. The validator's spending rules never change silently.

## Expected artifacts

After `aiken build`, `contracts/vault/plutus.json` MUST contain the
**unapplied blueprint hash** pinned in `VAULT_BLUEPRINT_HASH` in
`src/lib/vault.ts`. `scripts/verify-vault-hash.mjs` fails the build if it
drifts.

`aiken address` is **not** meaningful for a parameterized validator — it
would produce an address for the unapplied script, which is never deployed.
Use the JS-derived `VAULT_SCRIPT_ADDRESS` (logged at app boot) instead.

## Build steps

```bash
cd contracts/vault
aiken check      # 5 unit tests should pass
aiken build      # regenerates plutus.json (unapplied blueprint)
node ../../scripts/verify-vault-hash.mjs
```

The verify script fails if the unapplied blueprint hash drifts from
`VAULT_BLUEPRINT_HASH` in `src/lib/vault.ts`. Never bump `VAULT_VERSION`
without first withdrawing every live UTxO at the old applied address.
