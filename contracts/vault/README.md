# Stellaris Vault (Phase 1)

Per-user Cardano vault used by the Preprod on-chain flow. Anyone can deposit
ADA to the script address by locking it with an inline datum containing their
own payment-key hash. Only the address whose PKH matches the datum can spend
the UTxO (checked via `tx.extra_signatories`).

## Prerequisites

- [Aiken](https://aiken-lang.org/installation-instructions) ≥ v1.1.9
- A Preprod-funded Cardano wallet (Lace, Eternl, or Nami) — grab tADA from
  <https://docs.cardano.org/cardano-testnets/tools/faucet>

## Build

From the repo root:

```bash
cd contracts/vault
aiken build
```

This produces `plutus.json` with the compiled validator. To derive the script
address (needed by the browser), run:

```bash
aiken address --stdlib --network preprod --validator vault
```

Alternatively, in a Node REPL with `@lucid-evolution/lucid`:

```ts
import { Lucid, Blockfrost, validatorToAddress } from "@lucid-evolution/lucid";
import plutus from "./plutus.json" with { type: "json" };

const cbor = plutus.validators.find(v => v.title === "vault.vault.spend").compiledCode;
const address = validatorToAddress("Preprod", { type: "PlutusV3", script: cbor });
console.log(address); // addr_test1w...
```

## Wire it into the app

Copy the resulting `addr_test1w…` address into `.env.development`:

```
VITE_VAULT_SCRIPT_ADDRESS=addr_test1w...
```

Then restart the dev server. The Deposit ADA card on `/marketplace/sfm-01`
will switch from "Vault not deployed" to a live deposit form.

## What's next (Phase 1.5)

- Withdraw flow (spend the UTxO, provide redeemer, sign as owner)
- Cache locked UTxOs via Lovable Cloud so the "Your position" tile is fast
- Move to a per-asset shared vault + fractional CIP-68 receipt token
