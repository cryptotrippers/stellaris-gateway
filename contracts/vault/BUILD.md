# Vault validator — deterministic build

Phase 1 script pinned in `src/lib/vault.ts`.

## Toolchain

- Aiken **v1.1.23** (matches `aiken.toml`)
- stdlib **v2.2.0** (see `aiken.toml`)

## Expected artifacts

After `aiken build`, `contracts/vault/plutus.json` MUST contain:

```
validators[0].hash    = 7ee33b926834bd7d983ca9d433cee0cc1918ed5bcb5f78ab795d7057
```

And `aiken address` MUST print:

```
addr_test1wplwxwujdq6t6lvc8j5agv7wurxpjx8dt094779t09whq4chqhwe6
```

## Build steps

```bash
cd contracts/vault
aiken check      # 4 unit tests should pass
aiken build      # regenerates plutus.json
aiken address    # prints the bech32 script address
node ../../scripts/verify-vault-hash.mjs
```

The last command fails if the compiled hash drifts from the value pinned in
`src/lib/vault.ts` (`VAULT_SCRIPT_HASH`). Never change that constant without
also withdrawing every live UTxO at the old address first.
