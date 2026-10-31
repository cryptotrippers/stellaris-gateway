# Stellaris Shield — security architecture baseline (31 Oct 2026)

Phase 0 of the Stellaris Shield brief: what protects reserve and investor value today, verified from the repository, and what Shield should add. Companion files: `CONTRACT_INVENTORY.md`, `SECURITY_INVARIANTS.md`, `THREAT_MODEL.md`, `IMPLEMENTATION_GAP_ANALYSIS.md`.

Nothing here is an audit. The external audit is planned for February 2027 (build guide P13); fraction_vault v2 goes to a second audit later (decision 27 Oct).

## The layers that already exist

1. **On-chain M-of-N for every privileged action** — reserve committee 3-of-5 (Tessera), offering committee 2-of-3 (fv2 test). Distinct signers counted; rotation needs old and new committee.
2. **Exact state transitions** — one State per instance, identified by a thread token; every spend fixes the whole next datum and value; markers authenticate Positions, Tickets, Requests and pledges.
3. **Bounded issuance** — TSRA mint ≤ min(attested reserve, cap), attestation ≤ 7 days old, not while paused.
4. **Segregated value** — reserve Supply, sTSRA vault, first-loss, queue Buffer and each offering are separate scripts; payouts go only to fixed destinations (owner, `payout_to`, SPV, treasury).
5. **Bounded emergency powers** — pause blocks minting only; queue suspend ≤ 3 days; loss freeze ≤ 7 days (4 in the fix batch); user exits and refunds read no switch.
6. **On-chain limits and notice** — redemptions capped per shard per day and month; Defund and limit changes announced, delayed, vetoable.
7. **Signing path** — the S1 intent guard and confirm dialog decode every app transaction before a wallet signs; Blockfrost key server-only; Preprod-only network guard.
8. **CI** — Aiken tests, blueprint drift guard, worst-case budget gate, security tests and dependency audit on every PR.

## What Shield should add (the real gaps)

| Gap | Proposal | Cost |
|---|---|---|
| G1 Protocol treasury is a single key | **Shield treasury vault** (new Aiken project): M-of-N, propose → delay → execute, per-tx and rolling limits in a state UTxO, cancellation, destinations fixed in the proposal; ADA and TSRA | New contract: tests, mutation, budget; **adds to audit scope** |
| G2 No delay on Mint, SetCap, Rotate, Draw, Release, ClaimFee | Two-step announce → execute for those redeemers (the Defund pattern) | Changes `reserve`, `first_loss`, `offering_v2` → **new policy IDs** → belongs in the one counsel rebuild (preprod-v2) |
| G3 Reserve existence is attested | Custodian + attestation process; on chain, keep the cap and freshness rules | **BLOCKED** on counsel and custodian |
| G4 Preprod keys on one PC | Documented key custody now; hardware-wallet ceremony before mainnet | Operational |
| G5 Monitoring | Tessera reconcile (P5.7), attestation-age alert, proposal monitor once G1 exists | Off chain, can start now |
| C-1, C-2, C-3 | Already fixed on `phase2-9-security-fixes` | Merge with the rebuild |

## Decisions needed before contract work

1. **G1 design:** a native-script multisig (simple, no timelock or limits) for now, or the full Aiken treasury vault (timelock, limits) built now on Preprod?
2. **G2:** add the announce → execute delay to reserve/first-loss/offering in the counsel rebuild? It changes every policy ID once more (already planned for v2) and enlarges the audit.
3. **Audit scope:** add the treasury vault (and G2 changes) to February 2027, or to the second audit with fraction_vault v2? The February schedule is not changed without a decision.
