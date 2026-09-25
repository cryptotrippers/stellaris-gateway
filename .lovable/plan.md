# Fraction token: go live on Preprod

## Where things stand

Already built in earlier steps:
- The fraction token contract and the offering contract (44 passing tests, fingerprints locked so the app refuses to sign if they ever change).
- The listings register (`offerings`) and the verified activity log (`fraction_events`).
- The "Open an asset for fractional ownership" panel in the operator console, the buy / redeem panel on each asset page, and chain-confirmed recording of every buy.

What is **not** done: no offering has been opened on Preprod yet, so the contracts have never been used on chain. (The database was waking up during this check, so the register's current contents are confirmed as the first step below.)

On Cardano there is no separate "deploy" step: a contract goes live the first time a transaction uses it. That first transaction must be signed with your master wallet — it cannot be signed for you.

## Steps

1. **Confirm current state** — read the register and the offering address on Preprod; report whether anything is already open.
2. **Harden the opening flow before you sign**
   - Refuse to open if the asset already has a live offering on chain (no duplicate state records).
   - After the opening transaction confirms, re-read it from the chain and only then mark the listing live; if the chain disagrees with what was entered, show the mismatch and don't list it.
   - Show the derived contract address and token ID before signing, so you can check them.
3. **Publish the contracts as on-chain references** (optional, recommended) — a one-time transaction storing both contracts on chain so every buy is smaller and cheaper, recorded alongside the existing vault references.
4. **Wire buys fully to the chain**
   - Asset page reads price, fractions left and holders only from the chain (with source + time shown).
   - After a buy, the activity row is written only once the chain confirms the counters moved by exactly the fractions minted; failed or unconfirmed buys never appear.
   - Portfolio card on the asset page: fractions the connected wallet actually holds.
5. **Guided go-live** — a short checklist in the operator console: connect master wallet → open ph-solar-01 (e.g. 1,000 fractions) → confirm → make a small test buy from a second wallet → confirm the tokens appear in that wallet and in the holder list.
6. **Verify end to end** — I check each confirmed transaction against Preprod and report tx hashes, token ID and holder counts.

## Technical details

- Duplicate guard: query Blockfrost `/addresses/{offering}/utxos` for a datum-bearing UTxO before `openOffering`; `registerOffering` re-validates server-side.
- `registerOffering` gains a `txHash` input and verifies the opening output (address, inline datum via `decodeOffering`, `minted = outstanding = 0`, parameters match) before insert.
- Reference scripts: extend `ref-scripts-publish.ts` / `ref-scripts.shared.ts` with `fraction_vault` and `fraction` entries; builders use `readFrom` when present.
- `recordFractionEvent` already verifies deltas; add a check that the tx mint quantity under the policy equals the outstanding delta.
- Preprod-only guard in `network.ts` untouched.
