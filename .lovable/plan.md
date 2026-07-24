## Goal

Keep the existing Connect Wallet flow (needed for signing deposits/withdrawals) and add a second entry point that lets anyone paste a Cardano **payment** (`addr1…` / `addr_test1…`) or **stake** (`stake1…` / `stake_test1…`) address to view holdings in read-only mode. The choice persists in `localStorage`.

## UX

- In `WalletButton.tsx`, the Connect Wallet modal gets a new tab/section: **"View by address (read-only)"** with an input, Paste button, validation, and a Track button.
- After a valid address is entered, the header button changes to a neutral state: `👁 stake1…abcd · Read-only` with a dropdown to switch address, disconnect, or upgrade to Connect Wallet for signing.
- Signing actions (Deposit, Withdraw, Confirm All, Governance submit) show a "Read-only — connect a wallet to sign" inline notice and are disabled when only a viewer address is set.
- Network mismatch: infer network from address prefix (`_test` vs mainnet) and show the same NetworkBadge warning if it doesn't match `EXPECTED_WALLET_NETWORK_ID`.

## State model

Extend `src/lib/wallet-store.ts`:

- Add `mode: "signer" | "viewer" | null` to `WalletState`.
- Add `viewerAddress`, `viewerStakeAddress`, `viewerKind: "payment" | "stake"` fields.
- New actions: `setViewerAddress(addr)`, `clearViewer()`.
- Signer connect (existing `connectWallet` / WalletConnect) takes precedence — if a signer connects, viewer is cleared.
- `localStorage` key `stellaris:wallet:viewer-address` for persistence; restored on boot alongside `restoreWallet()`.
- Export a `useEffectiveAddress()` helper that returns `{ address, stakeAddress, canSign }` so downstream code has one source of truth.

## Address validation

New `src/lib/address.ts`:

- `parseCardanoAddress(input)` returns `{ kind, networkId, bech32 }` or an error.
- Uses bech32 decode (already available via existing wallet deps; if not, add `bech32` package) to enforce prefix + checksum:
  - `addr` (mainnet payment), `addr_test` (testnet payment)
  - `stake` (mainnet stake), `stake_test` (testnet stake)
- Rejects hex, script addresses without warning, and anything with a bad checksum.

## Read-only data wiring

Update the two hooks that currently key off `useWallet().address`:

- `src/hooks/useVaultHoldings.ts` → use `useEffectiveAddress()`. Query runs for both signer and viewer.
- `src/lib/vault-holdings.ts` (`fetchMyVaultHoldings`) → accept an explicit address rather than reading the store directly, so it works for viewer mode. Stake addresses: resolve associated payment addresses via Blockfrost (`/accounts/{stake}/addresses`) inside the existing `blockfrost.functions.ts` server function; payment addresses query directly.
- Portfolio page (`src/routes/app.tsx`) and marketplace detail (`src/routes/marketplace.$id.tsx`) already read from these hooks — no logic change beyond the disabled-sign UI.
- Vault tx history is stored per-address in localStorage; it will simply be empty for a freshly-tracked viewer address (honest zero state).

## Guards on signing paths

In `depositAdaToVault`, `withdrawAdaFromVault`, `ConfirmAllWithdrawDialog`, and governance submit:

- Early-return with a typed `read_only` error if `mode !== "signer"`.
- UI shows "Connect a signing wallet to continue" with a button that opens the existing Connect Wallet modal.

## Files touched

- `src/lib/wallet-store.ts` — extend state, add viewer actions, restore on boot.
- `src/lib/address.ts` — new, address parsing/validation.
- `src/components/wallet/WalletButton.tsx` — add "View by address" tab + read-only header state.
- `src/hooks/useVaultHoldings.ts` — use effective address.
- `src/lib/vault-holdings.ts` + `src/lib/blockfrost.functions.ts` — support stake-address resolution.
- `src/lib/vault.ts` — early guard on signing helpers.
- `src/components/vault/DepositVaultCard.tsx`, `WithdrawVaultCard.tsx`, `ConfirmAllWithdrawDialog.tsx`, `src/routes/governance.new.tsx` — disabled state + prompt when read-only.
- `package.json` — add `bech32` if not already transitively available.

## Out of scope

- No new database tables — viewer address stays client-side only.
- No changes to referral, security settings, or governance data flows beyond the sign-action guard.
- No mainnet enablement — network inference still enforced against `EXPECTED_WALLET_NETWORK_ID`.
