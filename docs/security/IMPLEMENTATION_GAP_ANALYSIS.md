# Implementation gap analysis — Stellaris Shield (31 Oct 2026)

Classification of every Shield feature against the repository. EXISTING · PARTIAL · MISSING · BLOCKED.

| Shield phase | Feature | Status | Where / why |
|---|---|---|---|
| 2.1 | On-chain M-of-N, unique signers, rotation | **EXISTING** | reserve, queue_admin, offering_v2 |
| 2.1 | Independent signers | **PARTIAL** | Preprod keys on one PC; mainnet ceremony planned |
| 2.2 | Segregated domains: reserve, staking, first-loss, queue, offerings | **EXISTING** | separate scripts + thread tokens |
| 2.2 | Operating treasury / protocol income domain | **MISSING** | single key address |
| 2.3 | NORMAL / ELEVATED / CRITICAL classes | **MISSING** | no treasury contract |
| 3 | Propose → delay → execute | **PARTIAL** | Defund and limits only; not Mint, SetCap, Rotate, Release, ClaimFee, Draw |
| 4 | Pause / suspend / freeze without seizure | **EXISTING** | SetPaused, Suspend, OpenLoss (bounded) |
| 4 | Emergency proposal cancellation, key revocation | **PARTIAL** | Rotate exists; no proposals to cancel |
| 5.1 | Redemption limits (per tx, daily, monthly, split-proof) | **EXISTING** | queue shards |
| 5.1 | Treasury spending limits | **MISSING** | — |
| 5.2 | Mint ≤ attested reserve, freshness | **EXISTING** | reserve |
| 5.2 | 102–105% coverage, haircuts, oracle | **BLOCKED** | no eligible-asset definition, custodian or oracle; counsel |
| 5.3 | Loss waterfall first-loss → sTSRA | **EXISTING** (as specified) | vault_ops, first_loss; originator collateral not modelled (term sheet D-7) |
| 6 | Project escrow, release to SPV only, caps, refunds | **EXISTING** (fv2) | milestone *verification* is committee + evidence hash, not independent |
| 6 | Independent milestone verifier | **MISSING** | needs a reviewer role (design) |
| 7 | sTSRA accounting, Tickets, owner-only exits | **EXISTING** | stsra_vault; long-sequence tests in Aiken + stress model 2.8 |
| 8 | Midnight eligibility | **DEFERRED** | design only; Cardano can't verify the proof (Meridian) |
| 9 | Attack suite ATT-001…020 | **PARTIAL** | most rail-specific attacks exist (see mapping below); treasury attacks need the treasury |
| 10 | Intent verification before signing | **EXISTING** | S1 guard + confirm dialog |
| 10 | Monitoring, alerts, reconcile | **PARTIAL** | nightly integrity job; Tessera reconcile (5.7) and attestation alert (14.8) not built |
| 12 | CI: compile, tests, drift guard, budgets, dependency audit | **EXISTING** | `contracts.yml`, `security.yml` |
| 12 | Mutation runs in CI | **MISSING** | run offline per milestone |

## ATT mapping

| ATT | Today |
|---|---|
| 001/002/003 one, two keys, duplicate signer | **covered** for reserve/queue/offering (2-of-5 refused; distinct counting) — treasury MISSING |
| 004 before timelock | covered for Defund/limits only |
| 005/006 tampered destination/amount | covered (Release to SPV only, exact payouts, Settle to `payout_to`) |
| 007 replay | covered by construction |
| 008 parallel bypass of caps | covered for redemptions (sharded caps) |
| 009 unauthorised config change | covered (M-of-N, Rotate old+new) |
| 010 emergency seizure | covered (pause/suspend/freeze move no value) |
| 011/012 unbacked mint, stale attestation | covered (`tessera-attest.test.ts`) |
| 013 unrelated UTxOs | covered (thread tokens, clean value) |
| 014 duplicate project payment | covered (payout tags, exact balance) |
| 015 beneficiary change | covered (immutable terms) |
| 016 unauthorised sTSRA redemption | covered (owner-only Claim) |
| 017 cross-domain | covered for Tessera ↔ offerings |
| 018 backend signing bypass | covered (S1 guard) |
| 019/020 emergency cancel, recovery | partial (Rotate; no proposals) |

## Recommendation

Do **not** rewrite the existing contracts. The Shield's remaining value is a **protected treasury** (proposal, timelock, rolling limits, M-of-N) for protocol income and operating funds, plus a **delay on the highest-impact committee actions**. Both are new or changed contracts, so they belong in the one planned rebuild and widen the audit scope — decisions listed in `SECURITY_ARCHITECTURE_BASELINE.md`.
