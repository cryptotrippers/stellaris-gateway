# Complete the Governance page

Governance today lists proposals but nothing can actually be voted on: the "For %"
column is a static number no one writes to, the proposal list has no history or
timeline, and the vault registry shows the address without any chain-derived time.
This closes those three gaps.

## 1. Real voting, weighted by vault position

- New `proposal_votes` table: one row per voter per proposal, recording the choice
  (for / against / abstain), the weight used, and the moment it was cast. A unique
  constraint makes double-voting impossible; a voter may change their choice, which
  updates the existing row rather than adding a second.
- Weight comes from the voter's verified vault holdings at the time of voting, not
  from a self-declared number. The server reads the voter's positions, computes the
  weight, and stores it on the vote so later recounts are reproducible.
- Voters with no vault position get zero weight: they can still record a position,
  but it is shown separately as a non-binding signal instead of silently counting.
- Tallies (for / against / abstain, weighted and headcount, quorum reached or not)
  are computed server-side from the vote rows. The old static percentage is no longer
  displayed anywhere.
- Voting is only open between a proposal's start and end time. Closed proposals show
  the final tally and are read-only.

## 2. Proposal history and status

- Each proposal card expands in place to show: the full body, the named asset and
  action parameters, the vote panel with live tallies, and a timeline.
- Timeline entries are drawn from data that exists — created, voting opened, voting
  closes/closed, executed — with the executed entry timestamped from the Cardano
  block that contains the execution transaction, linked to the explorer.
- Statuses are derived, not asserted: an active proposal past its end time is shown
  as awaiting finalisation until the tally is closed out; executed proposals show
  their transaction and epoch.
- Filters and search stay, plus a clear separation between open and concluded
  proposals so history is readable.

## 3. Vault ↔ governance linkage with chain timestamps

- Each registered vault in the Vaults tab shows its bootstrap transaction with the
  real block time and epoch read from the chain, plus current epoch, share price and
  last accrual time — the same chain reads the yield ledger already uses.
- Each vault lists the proposals that name it, with their current status, and each
  executed proposal links back to the vault it acted on.
- Where a fact is genuinely unavailable (independent valuation, liquidity coverage)
  the card keeps saying so rather than inventing a value.

## Technical notes

- Migration: `public.proposal_votes` (proposal_id, voter user id, choice enum,
  weight, timestamps), unique on (proposal_id, voter), GRANTs for `authenticated`
  and `service_role`, RLS — anyone signed in may read tallies via an aggregate path,
  a voter may insert/update only their own row, and no one may delete.
- New server functions in a `governance-votes.functions.ts` module:
  `castVote` (auth-required; derives weight from the caller's positions server-side,
  rejects votes outside the voting window) and `getProposalTallies` (public,
  aggregated, returns no voter identities).
- Chain timestamps come from the existing Blockfrost server functions
  (`getVaultChainState`, `getVaultChainHistory`, transaction block time) — no new
  client-side chain access and no new secrets.
- `src/routes/governance.tsx` is refactored into per-tab components with TanStack
  Query instead of the current `useEffect` + `useState` fetching; the unused
  `createProposal` path in `governance-submit.functions.ts` is dropped in favour of
  the validated `createVaultProposal`.
- No fabricated values: every number on the page traces to a vote row, a database
  row, or a Cardano transaction.
