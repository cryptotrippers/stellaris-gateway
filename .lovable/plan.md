
## Part A — Unblock the build

The client bundle now transitively pulls in `@walletconnect/heartbeat`, which imports Node's `events` module. Vite's default browser externals stub it out, so rollup fails at build time. Fix by adding node polyfills to the client build.

- Install `vite-plugin-node-polyfills`.
- In `vite.config.ts`, add it to the `vite.plugins` array alongside `wasm()` / `topLevelAwait()`, enabling the `events`, `buffer`, `stream`, `util`, and `process` polyfills (the set Lucid + WalletConnect need in the browser).
- Verify `bun run build:dev` succeeds before touching feature code.

## Part B — Real deposits in portfolio

Show the connected wallet's confirmed on-chain vault holdings anywhere the app currently uses mock "invest" state.

### 1. New chain-read helper: `src/lib/vault-holdings.ts`

Client-side (browser) module. Exports:

```
export type VaultHolding = {
  txHash: string;         // origin tx (UTxO producer)
  outputIndex: number;
  lovelace: bigint;
  ada: number;            // lovelace / 1_000_000
  ownerPkh: string;
};

export type VaultHoldings = {
  address: string;        // wallet payment address
  ownerPkh: string;
  holdings: VaultHolding[];
  totalAda: number;
};

export async function fetchMyVaultHoldings(): Promise<VaultHoldings>;
```

Implementation:
- Reuses `initLucidWithWallet()` from `vault.ts` (refactor: export it, or lift into `vault-lucid.ts` shared by both files).
- Derives owner PKH via `paymentCredentialOf(walletAddress)`.
- `lucid.utxosAt(VAULT_SCRIPT_ADDRESS)` → filter by inline `VaultDatum.owner === ownerPkh` (same decoder as withdraw).
- Maps each UTxO to `VaultHolding` (uses `u.txHash`, `u.outputIndex`, `u.assets.lovelace`).
- Wraps failures in `decodeVaultError` so the caller gets a readable reason.

### 2. Data hook: `src/hooks/useVaultHoldings.ts`

- Uses TanStack Query (already in the app).
- `queryKey: ['vault-holdings', walletAddress]`.
- `enabled: wallet.connected && wallet.networkId === 0`.
- `queryFn: fetchMyVaultHoldings`.
- `staleTime: 20_000`, `refetchInterval: 30_000` (Preprod block time is ~20s).
- Returns `{ holdings, totalAda, isLoading, error, refetch }`.

### 3. UI: `MyVaultHoldingsCard`

New component `src/components/vault/MyVaultHoldingsCard.tsx`, rendered on `/marketplace/sfm-01` in the aside stack under the deposit/withdraw cards:

- Header: "Your on-chain position" + live indicator.
- Big number: total tADA locked.
- Per-UTxO list: `txHash` (short + Cardanoscan link), ADA amount, output index.
- Empty state: "No confirmed deposits yet — new deposits appear ~20s after the tx confirms."
- Error state: reuses `decodeVaultError` message.
- Manual refresh button that calls `refetch()`.

### 4. Cross-cutting integration

Replace the mock "Your position" line in `InvestPanel` (inside `src/routes/marketplace.$id.tsx`) so `sfm-01` shows the real on-chain total pulled from `useVaultHoldings`. Other asset IDs keep their existing mock display (no other assets have real vaults yet — Phase 1 scope).

Auto-refresh after a successful `DepositVaultCard` / `WithdrawVaultCard` submission by invalidating the `['vault-holdings', walletAddress]` query on the success path (accept a `queryClient` from context inside the cards).

### 5. Out of scope

- No portfolio/aggregate view across multiple assets — the vault is still per-wallet, single-script Phase 1.
- No indexer or database — Blockfrost is queried live each time.
- No historical activity feed (that was the other option — leave for a later step).

## Files touched

- `vite.config.ts` — add `nodePolyfills()`
- `package.json` — add `vite-plugin-node-polyfills`
- `src/lib/vault.ts` — export `initLucidWithWallet` (or extract to `vault-lucid.ts`)
- `src/lib/vault-holdings.ts` — new
- `src/hooks/useVaultHoldings.ts` — new
- `src/components/vault/MyVaultHoldingsCard.tsx` — new
- `src/components/vault/DepositVaultCard.tsx` — invalidate holdings query on success
- `src/components/vault/WithdrawVaultCard.tsx` — invalidate holdings query on success
- `src/routes/marketplace.$id.tsx` — mount the card, wire InvestPanel's "your position" to real data for `sfm-01`

## Verification

- `bun run build:dev` exits 0 (Part A fix).
- On `/marketplace/sfm-01` with a connected Preprod wallet, `MyVaultHoldingsCard` shows the deposit made in the previous step and disappears after a successful withdraw.
