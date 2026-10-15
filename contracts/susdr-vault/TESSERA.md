# Tessera — stablecoin rail redesign (draft for decision)

Status: **design only, no contract code yet.** Written 2026-10-15 against the
code in `contracts/susdr-vault/`. Items marked **DECISION** block
implementation; everything else follows from the current code.

## 1. What exists today (and what it is not)

| Piece | Reality in the repo |
|---|---|
| `usdr.ak` | Test stablecoin. One issuer key signs any mint/burn. No reserve, no cap, no peg logic. Comment says Preprod stand-in only. |
| `susdr_vault.ak` | ERC-4626-style share vault **over** an external stablecoin. Price-per-share rises when operators deposit real yield (`ReportYield`). Bearer redemption. Fee on yield only (cap 20%), settled by dilution. Sole-State rule on both sides (V-01 lesson). |
| Redemption | Instant, directly against the State UTxO. **No queue exists on chain.** |
| Redemption UI/API | `RedemptionQueueStatus.tsx`, `/api/v1/yield/user/$address/queue` and `src/lib/redemption-queue.shared.ts` model a 7-day queue, but the API returns a hard-coded empty feed, and every amount field is typed in **lovelace/₳**, not stablecoin units. |
| Naming | `README.md` states USDr/sUSDr are RealFi's names and the code must be renamed before any public use. |
| Oracles | None wired (`NETWORK.md`). |

So today there is a yield wrapper but no collateral model, no queue, and no
token we own. The redesign is three pieces, in dependency order.

## 2. Token — `Tessera` (working ticker `TSR`) + `sTessera`

**Scope (decided):** Tessera is Stellaris's own token with **no tie to sUSDr or
RealFi**. It is a new package, `contracts/tessera/`, not a rename of
`susdr-vault`. The sUSDr stand-in stays untouched and is retired once Tessera
ships; Tessera may reuse its *patterns* (sole-State rule, share math), never
its names, hashes or token identifiers.

* **Tessera** is the stable unit (1 TSR = 1 USD target). **sTessera** is the
  yield-bearing share, a new vault modelled on `susdr_vault.ak`'s accounting.
* Replace `usdr.ak` with a policy that mints only inside a transaction that
  also spends the **Reserve State** UTxO (same pattern the vault already uses
  to bind sUSDr supply to share accounting). No bare issuer key.
* Reserve State datum: `minted_supply`, `attested_reserve`, `mint_cap`,
  `attestation_epoch`, `paused`, committee + threshold. Mint requires
  `minted_supply + qty <= min(attested_reserve, mint_cap)`; burn is always
  allowed to the holder (bearer redemption of the token itself is never gated
  by the committee).
* Cardano native assets cannot be frozen, so compliance is enforced at the
  **mint and redeem gate** (KYC'd counterparties), not at transfer. That needs
  the KYC verifier from the `NETWORK.md` mainnet gate list.
* Keep PlutusV3 (current `aiken.toml`). The other vaults' version was not
  checked here.

## 3. Collateral model — **DECISION 1**

| Option | How it holds the peg | Cost / risk for the Jan 2027 target |
|---|---|---|
| **A. Reserve-backed (recommended for launch)** | Issuer holds USD/T-bill reserves off-chain; the on-chain cap equals the committee-attested reserve; redemptions are paid from a USDC/ADA-denominated on-chain buffer plus off-chain settlement. | No oracle needed. Trust sits in custodian + attestation, so the attestation cadence and committee threshold become the security model. Needs legal/licensing for Brazil (counsel, not code). |
| B. Over-collateralised on-chain (CDP) | ADA and RWA vault shares locked at 150%+, liquidations. | Needs a price oracle and a liquidation design; neither exists. Not realistic before an external audit. |
| C. Hybrid | A at launch, RWA vault receipts accepted as reserve assets at haircuts later. | Good path; defer to a second stage. |

Recommendation: **A, with C as the planned extension.** The existing RWA
yield (`yield_vault.ak` accruals) feeds `ReportYield` on sTessera, which
already forces the yield to be physically deposited, so reported yield cannot
exceed funds actually delivered.

## 4. Redemption queue — **DECISION 2**

Why a queue at all: reserve-backed redemption can need off-chain settlement,
and a bank-run buffer limits how much can leave per day.

Proposed design (on-chain, replacing the stub feed):

1. **Instant tier.** Redeem up to the current `buffer` held in the Reserve
   State, no wait, fee `instant_fee_bps`.
2. **Queued tier.** Above the buffer, the holder locks TSR in a **Request
   UTxO** (datum: `owner`, `amount`, `requested_at`, `bucket`). Owner can
   cancel any time before settlement.
3. **Daily buckets, not strict FIFO.** eUTxO makes a single ordered queue a
   contention point. Requests are grouped by `floor(requested_at / 1 day)`;
   a bucket becomes payable once `bucket_end + settle_delay` passes
   (hard cap 7 days, matching `REDEMPTION_WINDOW_DAYS`). Buckets are paid
   pro-rata if liquidity is short.
4. **Permissionless settlement** after `available_at` (anyone can submit; funds
   can only go to `owner`), so redemption does not depend on the committee
   being online.
5. Validator rules inherit the sole-State input/output rule and the
   foreign-token grief block from `susdr_vault.ak`.

Off-chain work that follows: fix `redemption-queue.shared.ts` to use stable
units instead of `amountLovelace`, and make the API decode Request UTxOs
instead of returning `entries: []`.

## 5. Phases and tests

1. **Scaffold `contracts/tessera/`** with its own `aiken.toml`, a spec, and a
   `scripts/verify-vault-hash.mjs` entry so CI pins its blueprint. Port
   `exchange.ak` math with the Tessera names; no dependency on `susdr-vault`.
2. **Reserve State + Tessera policy.** Tests: mint above cap, mint above
   attestation, stale attestation, two Reserve States, mint without spending
   Reserve State, committee below threshold, replayed epoch.
3. **Queue validator.** Tests: cancel by non-owner, settle early, settle to
   wrong address, double-settle, pro-rata shortfall, bucket mixing, dust.
4. **Off-chain.** Shared encoder/decoder with a round-trip script like
   `verify-state-datum-roundtrip.ts` (the O-02 lesson), plus queue API.
5. **Audit gate.** `NETWORK.md` already requires an independent audit, legal
   wrappers and KYC before mainnet. Any validator change moves the blueprint
   hash, so batch everything into one rebuild.

## 6. Timeline reality check

Today is mid-October 2026; January 2027 is roughly 11 weeks away. Phases 1–4
are feasible on Preprod in that time. The mainnet gates in `NETWORK.md`
(external audit, legal wrappers per asset, real KYC verifier, multisig
treasury) are not code and are the likely critical path, particularly for a
$50M+ Brazil launch. I would not promise January mainnet until the audit slot
and licensing path are confirmed.

## 7. Open decisions

1. **Collateral model** — A (reserve-backed), B or C? (Section 3)
2. **Queue** — daily buckets with instant buffer as above, or a simpler
   fixed 7-day delay for everything? (Section 4)
3. ~~Naming~~ — **resolved:** Tessera is independent of sUSDr; full build.
4. **Reserve asset and custodian** — which stable/T-bill custodian and which
   on-chain asset pays redemptions? This sets the attestation format.
