# Publish and record reference scripts

Adds an admin-only way to publish each validator's script once on chain, verify the published output server-side, and record it in the vault registry so later transactions can point at it instead of re-embedding the script bytes.

## What gets built

### 1. `recordReferenceScript` server function (`src/lib/asset-vaults.functions.ts`)

Follows the shape of `registerAssetVault` / `recordVaultFeeSchedule` already in that file.

- Input: `assetId`, `vaultVersion`, `validatorKey` (`vault` | `yield_vault` | `receipt`), `txHash`, optional `replace` flag.
- `assertRole(..., "admin")` — publishing spends real ADA and cannot be undone, so operator is not enough.
- Loads the `asset_vaults` row for `(assetId, vaultVersion)`; rejects when there is no registered vault.
- Duplicate guard: if `ref_script_utxos` already has that validator's key, reject with a clear message unless the caller passes the explicit `replace` override.
- Chain verification (server-side, via the existing Blockfrost server helper):
  - fetch the transaction's outputs, take output index 0;
  - the output address must equal `REF_SCRIPT_HOME_ADDRESS`;
  - the output must carry a PlutusV3 reference script;
  - the reference script's on-chain bytes (fetched by script hash) must match the expected applied script for this asset/version and validator key — never the client's claim.
- Only after all checks pass, write `{ txHash, outputIndex: 0, publishedAt: now() }` into `asset_vaults.ref_script_utxos` under the validator key (merge, never overwrite other keys).
- Runtime helpers live in `asset-vaults.shared.ts` / a `.server.ts` module so the server-function file stays a thin wrapper.

**Expected-script source (technical decision).** Deriving the applied CBOR needs `applyParamsToScript`, which is WASM (`@lucid-evolution/uplc`) and is not guaranteed to run in the edge server runtime. The implementation will first attempt a server-side dynamic import to derive the applied CBOR and hash directly. If that WASM path does not run in the worker, verification falls back to authoritative server-held hashes, which bind the same bytes:

- `yield_vault` → `asset_vaults.script_hash` recorded at bootstrap;
- `receipt` → the `receipt_policy` field read from the live on-chain vault State datum;
- `vault` → the applied hash recomputed from the pinned blueprint, or rejected if it cannot be established server-side.

Either way the client's claimed CBOR/hash is never trusted.

### 2. New wizard step (`src/components/deploy/DeploymentWizard.tsx`)

A step after the vault bootstrap: **"Publish reference scripts"**, admin-only (reuses the existing `getMyRoles` gate).

- One row per validator (`vault`, `yield_vault`, `receipt`) for the selected asset, state sourced from `asset_vaults.ref_script_utxos`.
- Not-yet-published row → "Publish" button that:
  1. derives the applied CBOR with the existing derivation used elsewhere in this file;
  2. calls `buildPublishReferenceScriptTx` from `src/lib/ref-scripts.ts`;
  3. has the connected wallet sign and submit;
  4. calls `recordReferenceScript` with the resulting hash;
  5. refetches the registry.
- Published row → "Published" badge with a Cardanoscan link to the transaction and the min-ADA that was locked.
- Buttons stay disabled while the home address in `ref-scripts.ts` is still the Step 0 placeholder, with a note explaining what to paste in.
- Errors (wrong network, non-admin, duplicate key, chain verification failure) surface inline in that row.

## Notes

- No contract or migration changes; `ref_script_utxos` already exists.
- Publishing is optional — the existing embedded-script path keeps working for any validator with no published entry.
