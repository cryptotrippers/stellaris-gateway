# Phase 1 — Lovable prompts (UI follow-up to the contract security fixes)

Paste each prompt into Lovable **separately, in order**, and check the result
before the next one. Each prompt only touches UI files; the logic they call is
already in `src/lib` (committed on `feature/tessera-rebuild`).

Background for all of them: shared vaults and offerings now carry a one-shot
**state-thread token** minted at bootstrap (AUDIT.md F-1). The token's policy is
derived from a **seed** UTxO chosen at bootstrap, so a vault's address no longer
exists before it is bootstrapped. After bootstrapping, a developer pins the
returned seed in `src/lib/vault-instances.ts`; until then, deriving that vault's
address throws `VaultNotBootstrappedError`.

---

## Prompt 1 — Bootstrap flows: no address preview, show the seed afterwards

```
Update the yield-vault bootstrap flows in src/components/deploy/DeploymentWizard.tsx,
src/components/operators/RebootstrapVaultCard.tsx and src/routes/operators.tsx.
Do not change anything in src/lib.

1. A vault's address can no longer be known before it is bootstrapped. Remove every
   pre-bootstrap call to deriveYieldVaultAddress(assetId) that is used to PREVIEW an
   address (DeploymentWizard around line 203, operators.tsx around line 321). Where the
   preview was shown, show this text instead: "The vault address is fixed by the
   bootstrap transaction and shown once it confirms."

2. deriveYieldVaultAddress and getYieldVaultScript can now throw an error whose
   `name` is "VaultNotBootstrappedError" (exported from "@/lib/vault-instances").
   Wherever these are called for display or comparison, catch that error and show
   "Not bootstrapped in this build" in place of the address — never a red error.
   In RebootstrapVaultCard's drift scan (around line 68), treat that error as
   "no pinned instance" and skip the vault instead of failing the whole scan.

3. bootstrapYieldVault() now returns two extra fields: `seed` ({ txHash, outputIndex })
   and `threadUnit` (string). After a successful bootstrap, show a success panel with:
   - the address and script hash from the RESULT (not from a derive call),
   - "Seed: <txHash>#<outputIndex>" with a copy button,
   - "State token: <threadUnit>" with a copy button,
   - this note: "Developer step: pin this seed in src/lib/vault-instances.ts under
     YIELD_VAULT_SEEDS["<assetId>"] as { txHash: "...", outputIndex: N }. Until that
     commit is deployed, deposits and withdrawals for this vault are unavailable."
   Keep calling registerAssetVault with res.address and res.scriptHash exactly as now.

4. Running bootstrap again for the same asset now creates a brand-new vault at a new
   address (a different seed); it can no longer add a duplicate State to an existing
   vault. Replace any copy that warns "bootstrapping twice creates a duplicate ledger"
   with: "Each bootstrap creates a new, separate vault. Only the one pinned in the
   build is used by the app."
```

## Prompt 2 — Offering opening: same treatment

```
Update src/components/operators/OpenOfferingCard.tsx. Do not change src/lib.

1. Remove the pre-open address preview that calls deriveOffering(assetId, unit)
   (around line 70). Show instead: "The offering address is fixed by the opening
   transaction and shown once it confirms."
2. openOffering() now returns `seed` ({ txHash, outputIndex }). After a successful
   open, show the address and fraction unit from the RESULT, plus
   "Seed: <txHash>#<outputIndex>" with a copy button and the note: "Developer step: pin
   this seed in src/lib/vault-instances.ts under OFFERING_SEEDS["<assetId>:"] (ADA) as
   { txHash: "...", outputIndex: N }."
3. If deriveOffering throws an error whose name is "VaultNotBootstrappedError", show
   "Not opened in this build" instead of an error.
```

## Prompt 3 — Read-only contract cards

```
Update src/components/chain/MultiAssetVaultCard.tsx and
src/components/vault/AssetVaultPanel.tsx. Do not change src/lib or src/hooks.

1. MultiAssetVaultCard: deriveMultiVault(assetId, unit) can throw an error whose
   name is "VaultNotBootstrappedError". For that error, render the row value as
   "Not bootstrapped" instead of failing the card.
2. AssetVaultPanel: useDerivedVaultAddress may return an error whose name is
   "VaultNotBootstrappedError". Show "This project's vault has not been bootstrapped
   in the current build." in a neutral (not red) notice.
3. AssetVaultPanel around line 161: `stateCount` now counts EVERY State-shaped UTxO
   at the address, and only the one carrying the vault's state token is used. Change
   the copy from "This project was set up twice on chain…" to: "{stateCount - 1}
   unrecognised record(s) sit at this vault address. They carry no vault token, are
   ignored, and can never be spent." Only show it when stateCount > 1.
```

## Prompt 4 — Network badge copy

```
Update src/components/layout/NetworkBadge.tsx only. The app now REFUSES mainnet:
when VITE_BLOCKFROST_NETWORK is "mainnet", IS_UNEXPECTED_MAINNET is true but
APP_NETWORK stays "preprod". Change the danger tooltip to: "CONFIGURATION ERROR:
mainnet was requested and refused. The app is still on Preprod; fix
VITE_BLOCKFROST_NETWORK." Keep the red styling. Remove the branch that describes
"App is pointed at Cardano Mainnet. Transactions use real ADA." — it can no longer
occur.
```

## Prompt 5 — Legacy yield v3 exit (ONLY after the v3 exit builder is approved and merged)

Not ready: depends on a `src/lib` v3 exit builder that has not been written
(AUDIT.md F-5). Do not paste until that lands.
