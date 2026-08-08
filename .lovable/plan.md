# Connecting yield output to governance and real-world assets

Goal: one continuous chain of custody from a real-world project, to the on-chain
vault that funds it, to the yield it pays out, to the governance decision that
authorised that payout. Every number on screen traces to a Cardano transaction
hash. Nothing is simulated.

## The loop being built

```text
  Asset (real-world project)
        |  has one yield vault instance (version 3, per-asset script address)
        v
  Vault state UTxO  --- share price, epoch, total assets/shares
        ^                                   |
        | Accrue tx (M-of-N operators)      | read by the app
        |                                   v
  Governance proposal  ------------->  Yield page + asset page + portfolio
   (passed = mandate to execute)       all show the same on-chain numbers
```

## Current state (verified)

- The Yield page renders simulated numbers: APY, streamed ADA, and the whole
  payout history are generated in `src/lib/yield-engine.ts`, not read from chain.
- The Governance page already reads real proposals and treasury config from the
  database, and real TVL from vault positions — but the proposals, treasury
  events, and oracle feed tables are all empty, and proposals carry no link to
  an asset, no body text, and no record of the transaction that executed them.
- The yield vault validator is compiled, tested (48 checks), pinned as version 3,
  and its per-asset Preprod addresses are derived — but no part of the app reads
  from or writes to it yet.

## Step 1 — Bootstrap the on-chain vault ledger

Add a one-time bootstrap flow that creates the vault state UTxO for an asset:
share supply zero, assets zero, epoch zero, the operator key hashes, and the
signature threshold. Without this UTxO no deposit, accrual, or redemption can
happen — it is the ledger every other transaction balances against.

Deliverable: a Preprod transaction hash per asset, recorded in the deploy log.

## Step 2 — Read share price from chain

Replace the simulation with a reader that fetches the state UTxO, decodes its
datum, and exposes: total assets, total shares, share price, epoch, paused flag,
and the operator threshold.

Rules for display:
- Before the first accrual there is no yield history, so the page shows
  "No accruals yet — share price 1.000000" rather than an invented APY.
- APY is only shown once two accrual points exist, computed from the actual
  share-price change over the actual elapsed time between those epochs.
- Every figure links to the transaction that produced it.

## Step 3 — Real payout history

Build the payout history from the chain: scan the vault address for accrual
transactions, and record each one with its epoch, amount, share price before and
after, block, and hash. Cached in the database for speed, but the chain remains
the source of truth and the cache is rebuilt from it — never written by hand.

The existing simulated payout generator is deleted, not left dormant.

## Step 4 — Tie assets to vaults and projects

Extend the asset record so each real-world project carries its vault instance
(version and derived address), its operator committee, and its reporting cadence.
The asset page then shows one honest panel: what the project is, what its vault
address is, what has actually been accrued to it, and when.

## Step 5 — Governance authorises operators

This is the link that makes the system coherent. Extend proposals with:

- the asset the proposal concerns
- the proposal type: accrue yield, pause a vault, unpause, change the operator
  committee, or a general signal
- the proposed parameters (for an accrual: the exact lovelace amount)
- a full body, an author, and a voting window
- the execution record: which transaction carried it out, and when

A proposal moves draft to active to passed to executed. The executed state is
only reachable by pasting a real transaction hash that the app verifies against
the chain: the tx must be at that asset's vault address, must be an accrual of
the approved amount, and must have bumped the epoch. A proposal that cannot be
matched to a real transaction cannot be marked executed.

## Step 6 — Operator console

A gated page listing passed-but-unexecuted proposals. For each one it builds the
exact transaction the proposal authorises, collects the M-of-N signatures, and
submits. On confirmation it writes the hash back onto the proposal.

Operators cannot originate an accrual here — only execute one that governance
already passed.

## Step 7 — Close the loop in the UI

- Yield page: per-asset share price, epoch, real accrual history, and for each
  accrual the proposal that authorised it.
- Governance page: TVL from real positions, treasury flows from real events, and
  per-asset yield delivered versus yield approved.
- Asset page: the project, its vault, its accruals, its governing proposals.
- Portfolio: position value at the current on-chain share price, and yield earned
  as the difference between that and the amount deposited.

## Technical notes

- Chain reads run server-side through the existing Blockfrost server functions,
  so the project key stays off the browser.
- Datum decoding uses the Lucid instance already wired up for the vault, applying
  version 3 and the asset id to the pinned yield blueprint.
- Proposal execution verification runs server-side against Blockfrost; the client
  never asserts that a proposal was executed.
- Governance and operator writes need authenticated roles, so a roles table and
  an operator role are added — role checks happen server-side, never in the
  browser.
- Database changes: extend the proposals table; add tables for yield accruals
  and asset vault configuration; add the roles table. All with row-level access
  rules, public read for proposals and accruals, restricted write.
- Empty states everywhere: an asset with no accruals says so. No placeholder
  percentages, no seeded example rows.

## Sequencing

Steps 1 and 2 are the foundation and prove the read path on Preprod. Step 5 is
the piece that actually joins governance to yield. Steps 6 and 7 are only
meaningful once a real accrual exists on chain, so the first end-to-end proof is:
bootstrap, pass a proposal, execute it as operators, and watch the share price
move on the Yield page.
