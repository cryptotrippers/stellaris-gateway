# Phase 2.5 — Lovable prompts (loss path UI, not yet wired)

> **Status: not applied, and not applicable yet.** The Tessera contracts have no
> off-chain builders or readers in `src/lib` (only the pinned hashes in
> `src/lib/tessera-blueprint.ts`), so there is nothing for a UI to call. Hold
> these until the Tessera transaction builders land (Phase 3). They are written
> down now so the UI work is not forgotten, and so the contract behaviour the UI
> has to explain is in one place. Paste them into Lovable **separately**, after
> the builders exist.

Background for all of them (contracts: `contracts/tessera/SPEC.md` §3a):

* The committee can open a **"loss pending" freeze** on the sTSRA vault for at
  most 7 days. While it is in force (`loss_pending_until > now`) the vault
  refuses stakes, unstake requests, long-tier unlocks and Ticket claims.
  Nothing else changes, and TSRA minting and burning stay open. A new freeze
  cannot open until 7 days after the last one ended.
* A loss is taken in this order: unvested yield, then the first-loss reserve,
  then stakers and open cooldown Tickets pro rata. Stakers see their price per
  share fall; a Ticket's Claim pays `value * loss_index_now / index_at_request`
  and the rest is burned.
* A share class that a loss wipes out (price below 0.001 TSRA per share) is
  reset: its old sTSRA becomes a worthless token and the class restarts under a
  new name (`sTSRA` for generation 0, `sTSRA` plus a 4-byte generation after).
  An old long-tier Position still unlocks, for 0 TSRA, and returns its ADA.

---

## Prompt 1 — Freeze banner on the staking, unstaking and claim screens

```
On the sTSRA staking page, the unstake flow, the long-tier unlock flow and the
Ticket claim flow, read `loss_pending_until` (POSIX ms) from the reserve Config
(an `Option` the data layer will supply as `reserveConfig.lossPendingUntil`).

When `lossPendingUntil > Date.now()`:
- show a full-width warning banner at the top of the page:
  "A loss assessment is in progress. Staking, unstaking, unlocking and claiming
   are paused until {formatted lossPendingUntil}. Your funds are not affected by
   waiting. Minting and redeeming TSRA are not paused."
- disable the primary action button of each of those four flows and give it the
  tooltip "Paused during a loss assessment".
- show a countdown to `lossPendingUntil`.

When `lossPendingUntil <= Date.now()`, show nothing. Do not add a manual refresh;
re-read the Config every 30 seconds.
```

## Prompt 2 — Ticket claim: show the loss-adjusted payout

```
On the Ticket claim screen, for each open Ticket show:
- "Escrowed at request": ticket.value
- "Pays now": ticket.value * stateLossIndex / ticket.indexAtRequest, capped at
  ticket.value (integer division, floor)
- "Lost to a loss event": the difference, when it is greater than 0, with the
  note "This part is burned. It was written off when the loss was reported."
Hide the "Lost" row when it is 0.
```

## Prompt 3 — Wiped-out share classes

```
On the portfolio screen, when a holder's sTSRA token name is not the vault's
current short-tier name (the State's `shortGen` differs), show the position as
"Wiped out by a loss — worth 0 TSRA" with no unstake button. Do the same for a
long-tier Position whose `gen` differs from the State's `longGen`, but keep an
"Unlock (returns your ADA)" button, because that Position still unlocks, for 0
TSRA.
```

## Prompt 4 — First-loss reserve on the protocol page

```
On the protocol / reserves page add a card "First-loss reserve" showing the
first-loss State's `balance` in TSRA, the cap (3% of the minted supply) and the
fill percentage. Add one sentence: "This reserve absorbs losses before stakers
do and can only be burned against a reported loss."
```
