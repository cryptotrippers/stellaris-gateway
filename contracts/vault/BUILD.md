# Vault validator — deterministic build

Phase 1 script pinned in `src/lib/vault.ts`.

## Toolchain

- Aiken **v1.1.23** (matches `aiken.toml`)
- stdlib **v2.2.0** (see `aiken.toml`)

## Expected artifacts

After `aiken build`, `contracts/vault/plutus.json` MUST contain:

```
validators[0].hash    = 209ef4d27b1c3988583140d565363502b64689f145aaa31634b5da6f
```

And `aiken address` MUST print:

```
addr_test1wqsfaaxj0vwrnzzcx9qd2efkx5ptv35f79z64gckxj6a5mcryvk5r
```

## Build steps

```bash
cd contracts/vault
aiken check      # 5 unit tests should pass
aiken build      # regenerates plutus.json
aiken address    # prints the bech32 script address
node ../../scripts/verify-vault-hash.mjs
```

The last command fails if the compiled hash drifts from the value pinned in
`src/lib/vault.ts` (`VAULT_SCRIPT_HASH`). Never change that constant without
also withdrawing every live UTxO at the old address first.
